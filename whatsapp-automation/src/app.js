# Upgrade — WhatsApp Automation (multi-instância, backup de sessão, idempotência)

Abaixo estão **todos os arquivos completos** (novos e alterados) prontos para colar no projeto. Mantive o código existente e adicionei apenas o necessário.

---

## src/app.js

```js
// ======================= WebCrypto SHIM (antes de qualquer import do Baileys) =======================
try {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    const { webcrypto } = require('crypto')
    globalThis.crypto = webcrypto
  }
} catch (_) { /* silencioso */ }
// ===================================================================================================

const path = require('path')
const fs = require('fs/promises')
const express = require('express')
const morgan = require('morgan')
const QRCode = require('qrcode')
const rateLimit = require('express-rate-limit')
const cron = require('node-cron')
const WhatsAppClient = require('./services/whatsapp-client')
const settings = require('./services/settings')
const sessionBackup = require('./services/session-backup')
const { runOnce } = require('./jobs/post-winner')
const hubRoutes = require('./routes/api/hub');
const hubAdminRoutes = require('./routes/admin/hub');
// SSE hub
const { addClient: sseAddClient, broadcast: sseBroadcast } = require('./services/wa-sse')

// === Atendente (opcional) – carregamento tolerante ===
let attachAssistant = null
try { ({ attachAssistant } = require('./modules/assistant-bot')) } catch (_) { /* módulo opcional */ }

const PORT = process.env.PORT || 3000
const WA_INSTANCE_ID = process.env.WA_INSTANCE_ID || 'default'

// util: interpreta booleanos em env
function envOn(v, def = false) {
  const s = String(v ?? '').trim().toLowerCase()
  if (!s) return def
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

// ===== helpers de JID / parsing de números =====
function phoneToJid(v) {
  if (!v) return null
  const s = String(v).trim()
  if (s.includes('@')) return s
  const digits = s.replace(/\D/g, '')
  if (!digits) return null
  return `${digits}@s.whatsapp.net`
}
function parsePhonesToJids(value) {
  if (!value) return []
  return String(value)
    .split(/[\,\s;]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(v => v.includes('@') ? v : phoneToJid(v))
    .filter(Boolean)
}

const SESSION_DIR_CANDIDATES = [
  process.env.WA_SESSION_PATH,
  process.env.WHATSAPP_SESSION_PATH,
  path.join(process.cwd(), 'data', 'whatsapp-session'),
  path.join(process.cwd(), 'data', 'baileys'),
].filter(Boolean)

async function hasSavedSession() {
  for (const dir of SESSION_DIR_CANDIDATES) {
    try {
      const list = await fs.readdir(dir)
      if (list && list.some(f => /creds|app-state-sync|pre-key|sender-key/i.test(f))) {
        return { ok: true, dir, files: list.length }
      }
    } catch { /* ignore */ }
  }
  return { ok: false, dir: null, files: 0 }
}

class App {
  constructor() {
    this.app = express()
    this.whatsappClient = null
    this.waAdmin = null
    this.isFallbackEnabled = envOn(process.env.WA_CLIENT_AUTOSTART, false) || envOn(process.env.WA_FALLBACK_ENABLED, false)

    // ======= CONFIG DE ALERTA (via WhatsApp) =======
    const alertJidsMerged = [
      ...parsePhonesToJids(process.env.ALERT_WA_PHONES),
      ...parsePhonesToJids(process.env.ALERT_WA_PHONE),
      ...parsePhonesToJids(process.env.ALERT_WA_JIDS),
      ...parsePhonesToJids(process.env.ALERT_WA_JID),
    ]
    const uniqJids = [...new Set(alertJidsMerged)]
    this.alertCfg = {
      adminJids: uniqJids,
      graceMs: (Number(process.env.ALERT_GRACE_SECONDS) || 120) * 1000,
      enabled: uniqJids.length > 0
    }
    this.alertState = {
      lastConnected: null,
      lastChangeAt: Date.now(),
      downNotifiedAt: null
    }
    // ==============================================

    const limiter = rateLimit({
      windowMs: 60 * 1000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
      validate: false
    })

    this.app.use(limiter)
    this.app.use(morgan('dev'))
    this.app.use(express.json())
    this.app.use(hubRoutes);
    this.app.use(hubAdminRoutes);
    this.app.use(express.urlencoded({ extended: true }))
    this.app.use(express.static(path.join(__dirname, '../public')))

    const tp = process.env.TRUST_PROXY === '1' ? 1 : false
    this.app.set('trust proxy', tp)

    // Healthcheck para o Render
    this.app.get('/health', (req, res) => {
      res.status(200).json({ ok: true, ts: Date.now() });
    });

    // Resposta da raiz (ajuda nos testes e evita 502)
    this.app.get('/', (req, res) => {
      res.status(200).send('OK - staging');
    });

    // === PAINEL ADMIN (WhatsApp) ===
    try {
      const waAdmin = require('../admin-wa-bundle.js')
      this.waAdmin = waAdmin
      this.app.locals.waAdmin = waAdmin
      this.app.use('/admin', waAdmin)
    } catch (e) {
      console.warn('⚠️ Admin bundle indisponível:', e?.message || e)
    }

    // === fim do bloco ===
    this.routes()
  }

  // cria o cliente interno APENAS se fallback estiver habilitado
  initWhatsApp() {
    if (!this.isFallbackEnabled) return null
    if (!this.whatsappClient) {
      this.whatsappClient = new WhatsAppClient()
      this.app.locals.whatsappClient = this.whatsappClient
      this.whatsappClient.initialize().catch((e) => {
        console.error('❌ Falha inicial ao iniciar WhatsApp (fallback):', e?.message || e)
      })
    }
    return this.whatsappClient
  }

  getClient({ create = false } = {}) {
    if (this.whatsappClient) return this.whatsappClient
    if (create) return this.initWhatsApp()
    return null
  }

  async waitForWAConnected(wa, timeoutMs = 8000) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const start = Date.now()
    while ((!wa?.isConnected || !wa?.sock) && Date.now() - start < timeoutMs) {
      await wait(250)
    }
    return !!(wa?.isConnected && wa?.sock)
  }

  // pega um socket conectado (prefere ADMIN; cai no fallback)
  async getConnectedSock() {
    try {
      if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') {
        const st = await this.waAdmin.getStatus()
        if (st?.connected && this.waAdmin.getSock) {
          return this.waAdmin.getSock()
        }
      }
    } catch (_) {}

    if (this.isFallbackEnabled) {
      const wa = this.getClient({ create: false })
      if (wa?.isConnected && wa?.sock) return wa.sock
    }
    return null
  }

  // envio de alertas (para todos os destinos)
  async sendAlert(text) {
    if (!this.alertCfg.enabled || !this.alertCfg.adminJids?.length) return false
    const sock = await this.getConnectedSock()
    if (!sock) return false
    let ok = true
    for (const jid of this.alertCfg.adminJids) {
      try {
        await sock.sendMessage(jid, { text })
        console.log('🔔 ALERT sent to', jid)
      } catch (e) {
        ok = false
        console.error('❌ ALERT send error to', jid, e?.message || e)
      }
    }
    return ok
  }

  // pega status consolidado (prioriza admin)
  async consolidatedStatus() {
    try {
      if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') {
        const st = await this.waAdmin.getStatus()
        if (st && typeof st === 'object') {
          return {
            ok: true,
            connected: !!st.connected,
            connecting: !!st.connecting,
            hasSock: !!st.hasSock,
            msisdn: st.msisdn || null,
            isConnected: !!st.connected,
            qrCodeGenerated: !!st.qr,
            currentRetry: 0,
            maxRetries: 3,
            circuitBreakerState: 'CLOSED',
            failureCount: 0,
            queueLength: 0,
            user: st.user || null
          }
        }
      }
    } catch (_) {}

    // fallback
    if (this.isFallbackEnabled) {
      const wa = this.getClient({ create: false })
      if (wa) {
        const user = wa.user || null
        const msisdn = (function (u) {
          try {
            const raw = String(u?.id || '')
              .replace('@s.whatsapp.net', '')
              .replace(/^55/, '')
            const m = /(\d{2})(\d{4,5})(\d{4})/.exec(raw)
            if (m) return `${m[1]} ${m[2]}-${m[3]}`
          } catch (_) {}
          return null
        })(user)

        return {
          ok: true,
          connected: !!wa.isConnected,
          connecting: false,
          hasSock: !!wa.sock,
          msisdn,
          isConnected: !!wa.isConnected,
          qrCodeGenerated: wa.qrCodeGenerated,
          currentRetry: wa.currentRetry || 0,
          maxRetries: wa.maxRetries || 3,
          circuitBreakerState: wa.circuitBreaker || 'CLOSED',
          failureCount: wa.failureCount || 0,
          queueLength: 0,
          user
        }
      }
    }

    return {
      ok: true,
      connected: false,
      connecting: false,
      hasSock: false,
      msisdn: null,
      isConnected: false,
      qrCodeGenerated: false,
      currentRetry: 0,
      maxRetries: 3,
      circuitBreakerState: 'CLOSED',
      failureCount: 0,
      queueLength: 0,
      user: null,
      fallbackDisabled: !this.isFallbackEnabled
    }
  }

  routes() {
    // Health (inclui info da sessão no disco)
    this.app.get('/health', async (_req, res) => {
      const sess = await hasSavedSession()
      res.json({ ok: true, ts: new Date().toISOString(), sessionDir: sess.dir, sessionFiles: sess.files })
    })

    // STATUS
    this.app.get('/api/whatsapp/status', async (_req, res) => {
      try {
        const st = await this.consolidatedStatus()
        return res.json(st)
      } catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) })
      }
    })

    // Detalhe sessão (não cria fallback)
    this.app.get('/api/whatsapp/session-status', (req, res) => {
      const wa = this.getClient({ create: false })
      res.json({
        initialized: !!wa?.sock,
        connected: !!wa?.isConnected,
        qrAvailable: !!wa?.getQRCode?.(),
        pairingAvailable: !!wa?.getPairingCode?.(),
        qrCode: null,
        pairingCode: null,
        retryCount: wa?.currentRetry || 0,
        maxRetries: wa?.maxRetries || 3,
        circuitBreaker: wa?.circuitBreaker || 'CLOSED',
        user: wa?.user || null,
        fallbackDisabled: !this.isFallbackEnabled && !wa,
        timestamp: new Date().toISOString()
      })
    })

    // === NOVO: limpar sessão (usado pelo painel público) ===
    this.app.post('/api/whatsapp/clear-session', async (_req, res) => {
      if (!this.isFallbackEnabled) {
        return res.status(503).json({ success: false, error: 'Fallback desabilitado (WA_CLIENT_AUTOSTART=0).' })
      }
      try {
        const wa = this.initWhatsApp()
        await wa.clearSession()
        const ok = await wa.forceQRGeneration()
        if (ok && process.env.SESSION_BACKUP === '1') {
          try { await sessionBackup.backupDir(wa.sessionPath, 'after-clear'); } catch (_) {}
        }
        return res.json({ success: true, message: ok ? 'Sessão limpa. QR pronto em /qr.' : 'Sessão limpa. Gere o QR com /api/force-qr.', action: ok ? 'qr_ready' : 'qr_pending' })
      } catch (e) {
        return res.status(500).json({ success: false, error: e?.message || String(e) })
      }
    })

    // SSE
    this.app.get('/api/whatsapp/stream', async (req, res) => {
      const inst = (req.query.inst || 'default').toString()
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders()

      sseAddClient(inst, res)
      try {
        const s = await this.consolidatedStatus()
        res.write(`event: status\ndata: ${JSON.stringify(s)}\n\n`)
      } catch (_) {}
    })

    // DISCONNECT (proxy)
    this.app.post('/api/whatsapp/disconnect', async (_req, res) => {
      try {
        if (this.waAdmin?.disconnect) {
          await this.waAdmin.disconnect()
        }
        for (const d of SESSION_DIR_CANDIDATES) {
          try { await fs.rm(d, { recursive: true, force: true }) } catch {}
        }
        sseBroadcast('default', { type: 'status', payload: { ok: true, connected: false, connecting: false, hasSock: false } })
        return res.json({ ok: true })
      } catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) })
      }
    })

    // RESET (fallback)
    this.app.get('/api/reset-whatsapp', async (req, res) => {
      if (!this.isFallbackEnabled) return res.status(503).json({ success: false, error: 'Fallback desabilitado (WA_CLIENT_AUTOSTART=0).' })
      const wa = this.initWhatsApp()
      try {
        await wa.clearSession()
        await wa.initialize()
        const ok = await wa.forceQRGeneration()
        return res.json({
          success: true,
          message: ok ? 'WhatsApp resetado com sucesso! Acesse /qr para escanear novo código.' : 'WhatsApp resetado. Aguarde alguns segundos e tente /qr novamente.',
          timestamp: new Date().toISOString(),
          action: ok ? 'qr_ready' : 'qr_pending'
        })
      } catch (e) {
        console.error('❌ reset-whatsapp:', e)
        return res.status(500).json({ success: false, error: e?.message || String(e) })
      }
    })

    // Força QR (fallback)
    this.app.get('/api/force-qr', async (req, res) => {
      if (!this.isFallbackEnabled) return res.status(503).json({ success: false, error: 'Fallback desabilitado (WA_CLIENT_AUTOSTART=0).' })
      const wa = this.initWhatsApp()
      try {
        const ok = await wa.forceQRGeneration()
        if (ok) return res.json({ success: true, message: 'QR preparado. Acesse /qr.', qrAvailable: true, timestamp: new Date().toISOString() })
        return res.json({ success: false, message: 'Falha ao gerar QR Code. Tente novamente.', qrAvailable: false, timestamp: new Date().toISOString() })
      } catch (e) {
        console.error('❌ force-qr:', e)
        return res.status(500).json({ success: false, error: e?.message || String(e) })
      }
    })

    // QR SVG (fallback)
    this.app.get('/qr', async (req, res) => {
      if (!this.isFallbackEnabled) return res.status(503).json({ error: 'Fallback desabilitado (WA_CLIENT_AUTOSTART=0).' })
      const wa = this.initWhatsApp()
      try {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        let tries = 0
        while (!wa.getQRCode() && tries < 20) { await wait(300); tries++ }
        const qr = wa.getQRCode()
        if (!qr) return res.status(404).json({ error: 'QR Code não disponível', message: 'WhatsApp pode já estar conectado ou aguardando conexão' })
        const svg = await QRCode.toString(qr, { type: 'svg', margin: 1, width: 300 })
        res.set('Content-Type', 'image/svg+xml').send(svg)
      } catch (e) {
        console.error('❌ /qr:', e)
        res.status(500).json({ error: e?.message || String(e) })
      }
    })

    // Pairing code (fallback)
    this.app.get('/code', (req, res) => {
      if (!this.isFallbackEnabled) return res.status(503).json({ error: 'Fallback desabilitado (WA_CLIENT_AUTOSTART=0).' })
      const wa = this.initWhatsApp()
      const code = wa.getPairingCode()
      if (!code) return res.status(404).json({ error: 'Pairing code não disponível' })
      return res.json({ pairingCode: code })
    })

    // ===== GRUPOS =====
    this.app.get('/admin/groups', (_req, res) => {
      res.sendFile(path.join(__dirname, '../public/admin/groups.html'))
    })

    this.app.get('/api/groups/sync', async (_req, res) => {
      try {
        if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') {
          const st = await this.waAdmin.getStatus()
          if (st.connected) {
            const sock = this.waAdmin.getSock()
            const mp = await sock.groupFetchAllParticipating()
            const groups = Object.values(mp).map(g => ({ jid: g.id, name: g.subject, participants: g.participants?.length ?? g.size ?? 0, announce: !!g.announce }))
            const saved = settings.set({ groups, lastSyncAt: new Date().toISOString() })
            return res.json({ ok: true, groups, saved })
          }
        }

        if (this.isFallbackEnabled) {
          const wa = this.initWhatsApp()
          const okConn = await this.waitForWAConnected(wa, 8000)
          if (!okConn) {
            return res.status(503).json({ ok: false, error: 'WhatsApp ainda conectando… tente novamente em alguns segundos.' })
          }
          const groups = await wa.listGroups()
          const saved = settings.set({ groups, lastSyncAt: new Date().toISOString() })
          return res.json({ ok: true, groups, saved })
        }

        return res.status(503).json({ ok: false, error: 'Sem sessão disponível (admin desconectado e fallback desabilitado).' })
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) })
      }
    })

    this.app.get('/api/groups', (_req, res) => {
      res.json({ ok: true, settings: settings.get() })
    })

    this.app.post('/api/groups/select', (req, res) => {
      try {
        const { resultGroupJid, postGroupJids } = req.body || {}
        let list = Array.isArray(postGroupJids) ? postGroupJids : []
        if (!list.length && resultGroupJid) list = [String(resultGroupJid)]
        list = Array.from(new Set(list.map(s => s.trim()).filter(Boolean)))
        const out = settings.setPostGroups(list)
        res.json({ ok: true, settings: out, cleared: list.length === 0 })
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) })
      }
    })

    this.app.post('/api/groups/test-post', async (_req, res) => {
      try {
        const st = settings.get()
        const targets = (Array.isArray(st.postGroupJids) && st.postGroupJids.length) ? st.postGroupJids : (st.resultGroupJid ? [st.resultGroupJid] : [])
        if (!targets.length) { return res.status(400).json({ ok: false, error: 'Nenhum grupo selecionado' }) }

        if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') {
          const adminSt = await this.waAdmin.getStatus()
          if (adminSt.connected) {
            const sock = this.waAdmin.getSock()
            for (const jid of targets) { await sock.sendMessage(jid, { text: '🔔 Teste de postagem de sorteio (ok)' }) }
            return res.json({ ok: true, sentTo: targets.length, via: 'admin' })
          }
        }

        if (!this.isFallbackEnabled) { return res.status(503).json({ ok: false, error: 'Sem sessão disponível (admin desconectado e fallback desabilitado).' }) }

        const wa = this.initWhatsApp()
        if (!wa.isConnected) { return res.status(400).json({ ok: false, error: 'WhatsApp (fallback) não conectado' }) }

        for (const jid of targets) { await wa.sendToGroup(jid, '🔔 Teste de postagem de sorteio (ok)') }
        res.json({ ok: true, sentTo: targets.length, via: 'client' })
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) })
      }
    })

    // ===== ALERTAS =====
    this.app.post('/api/alerts/test', async (_req, res) => {
      if (!this.alertCfg.enabled) {
        return res.status(400).json({ ok:false, error:'Defina ALERT_WA_PHONES/ALERT_WA_PHONE (ou ALERT_WA_JID[S]) para habilitar alertas.' })
      }
      const ok = await this.sendAlert('🔔 Teste de alerta: sistema de sorteios online ✅')
      res.json({ ok, to: this.alertCfg.adminJids })
    })

    // job manual (POST)
    this.app.post('/api/jobs/run-once', async (req, res) => {
      try {
        const dry = ['1','true','yes'].includes(String(req.query.dry || '').toLowerCase())
        let canRun = false
        try { if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') { const st = await this.waAdmin.getStatus() ; canRun = !!st.connected } } catch (_) {}
        if (!canRun && this.isFallbackEnabled) { const wa = this.getClient({ create: false }); canRun = !!(wa?.isConnected) }
        if (!canRun) { return res.status(503).json({ ok:false, error:'Sem sessão conectada para executar o job.' }) }
        const out = await runOnce(this.app, { dryRun: dry })
        res.json(out)
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) })
      }
    })

    // 🔹 alias GET do job manual (para você chamar no navegador)
    this.app.get('/api/jobs/run-once', async (req, res) => {
      try {
        const dry = ['1','true','yes'].includes(String(req.query.dry || '').toLowerCase())
        let canRun = false
        try { if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') { const st = await this.waAdmin.getStatus() ; canRun = !!st.connected } } catch (_) {}
        if (!canRun && this.isFallbackEnabled) { const wa = this.getClient({ create: false }); canRun = !!(wa?.isConnected) }
        if (!canRun) { return res.status(503).json({ ok:false, error:'Sem sessão conectada para executar o job.' }) }
        const out = await runOnce(this.app, { dryRun: dry })
        res.json(out)
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) })
      }
    })

    // diagnóstico
    this.app.get('/debug/wa', async (_req, res) => {
      let admin = { available: false }
      try {
        if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') {
          const st = await this.waAdmin.getStatus()
          admin = { available: true, connected: !!st.connected, connecting: !!st.connecting, hasSock: !!this.waAdmin.getSock?.() }
        }
      } catch (e) {
        admin = { available: true, error: e?.message || String(e) }
      }

      const wa = this.getClient({ create: false })
      const sess = await hasSavedSession()
      const cfg = settings.get()

      res.json({
        admin,
        client: { enabled: this.isFallbackEnabled, initialized: !!wa?.sock, connected: !!wa?.isConnected, user: wa?.user || null },
        sessionDir: sess.dir, sessionFiles: sess.files,
        selectedGroups: cfg?.postGroupJids || (cfg?.resultGroupJid ? [cfg.resultGroupJid] : []),
        instanceId: WA_INSTANCE_ID,
        ts: new Date().toISOString()
      })
    })
  }

  // ==== helpers de autostart/watchdog por HTTP (usa fetch nativo do Node 18+) ====
  async callAdminStatus(baseUrl) {
    try {
      const r = await fetch(`${baseUrl}/admin/wa/status`, { method: 'GET' })
      if (!r.ok) return { ok: false, status: r.status }
      const j = await r.json()
      return { ok: true, data: j }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
  }
  async callAdminConnect(baseUrl) {
    try {
      const r = await fetch(`${baseUrl}/admin/wa/connect`, { method: 'POST' })
      return { ok: r.ok, status: r.status }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  async afterListen() {
    // Boot log útil
    const sess = await hasSavedSession()
    console.log(`🚀 Boot info -> Fallback: ${this.isFallbackEnabled ? 'ON' : 'OFF'} | sessionDir=${sess.dir || '(none)'} | files=${sess.files}`)

    // Inicia fallback somente se habilitado
    if (this.isFallbackEnabled) {
      const wa = this.initWhatsApp()
      // backup inicial opcional (cópia da sessão no estado atual)
      if (process.env.SESSION_BACKUP === '1') {
        try { await sessionBackup.backupDir(wa.sessionPath, 'boot'); } catch (_) {}
      }
    }

    // ---- Atendente (liga listener se módulo existir e estiver habilitado por env) ----
    try { if (typeof attachAssistant === 'function') attachAssistant(this) } catch (e) { console.warn('[assistant] attach skipped:', e?.message || e) }

    // === AUTOSTART do ADMIN via HTTP ===
    const wantAutoStart = envOn(process.env.WA_ADMIN_AUTOSTART, true)
    const autoStartDelay = Number(process.env.WA_AUTOSTART_DELAY_MS || 1500)
    const baseUrl = process.env.WA_SELF_BASE_URL || `http://127.0.0.1:${PORT}`

    if (wantAutoStart) {
      setTimeout(async () => {
        try {
          const st = await this.callAdminStatus(baseUrl)
          if (!st.ok) { console.log(`[WA-ADMIN] autostart: status indisponível (${st.status || st.error || 'erro'})`) ; return }
          if (!st.data?.connected) {
            if (sess.ok) {
              console.log('[WA-ADMIN] autostart: sessão encontrada; POST /admin/wa/connect…')
              const r = await this.callAdminConnect(baseUrl)
              console.log('[WA-ADMIN] autostart connect ->', r)
            } else {
              console.log('[WA-ADMIN] autostart: nenhuma sessão salva — aguarde QR.')
            }
          }
        } catch (e) {
          console.error('[WA-ADMIN] autostart erro:', e?.message || e)
        }
      }, autoStartDelay)
    }

    // === WATCHDOG: verifica a cada 30s e reconecta se houver sessão salva ===
    const watchdogOn = envOn(process.env.WA_ADMIN_WATCHDOG, true)
    if (watchdogOn) {
      setInterval(async () => {
        try {
          const st = await this.callAdminStatus(baseUrl)
          if (!st.ok) return
          const connected = !!st.data?.connected
          const now = Date.now()

          // atualiza estado de alerta
          if (this.alertState.lastConnected === null) {
            this.alertState.lastConnected = connected
            this.alertState.lastChangeAt = now
          } else if (connected !== this.alertState.lastConnected) {
            this.alertState.lastConnected = connected
            this.alertState.lastChangeAt = now
            // se voltou e já tínhamos avisado queda, manda "voltou"
            if (connected && this.alertState.downNotifiedAt && this.alertCfg.enabled) {
              await this.sendAlert('✅ WhatsApp (admin) reconectou e está online novamente.')
              this.alertState.downNotifiedAt = null
            }
          }

          // reconexão automática se há sessão salva
          if (!connected && !st.data?.connecting) {
            const s = await hasSavedSession()
            if (s.ok) {
              console.log('[WA-ADMIN] watchdog: desconectado + sessão presente → POST /admin/wa/connect')
              await this.callAdminConnect(baseUrl)
            }
          }

          // alerta de queda após grace
          if (!connected && this.alertCfg.enabled && !this.alertState.downNotifiedAt) {
            const elapsed = now - this.alertState.lastChangeAt
            if (elapsed >= this.alertCfg.graceMs) {
              const ok = await this.sendAlert('⚠️ WhatsApp (admin) está offline há alguns minutos. Tentando reconectar automaticamente.')
              if (ok) this.alertState.downNotifiedAt = now
            }
          }
        } catch (e) {
          console.error('[WA-ADMIN] watchdog erro:', e?.message || e)
        }
      }, 30_000)
    }

    // === (NOVO) Socket Watcher: detecta troca de socket e reanexa listeners ===
    try {
      const wantWatcher = envOn(process.env.WA_SOCKET_WATCHER, true) // ON por padrão
      if (wantWatcher) {
        const { startSocketWatcher } = require('./services/socket-watcher')
        startSocketWatcher(this)
      }
    } catch (e) { console.warn('[socket-watcher] não iniciado:', e?.message || e) }

    // Cron: só roda se houver sessão conectada
    cron.schedule('*/1 * * * *', async () => {
      try {
        let canRun = false
        try { if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') { const st = await this.waAdmin.getStatus(); canRun = !!st.connected } } catch (_) {}
        if (!canRun && this.isFallbackEnabled) { const wa = this.getClient({ create: false }); canRun = !!(wa?.isConnected) }
        if (canRun) { await runOnce(this.app) }
      } catch (e) {
        console.error('cron runOnce error:', e?.message || e)
      }
    })
  }

  listen() {
    this.server = this.app.listen(PORT, () => {
      console.log(`🌐 Server listening on :${PORT}`)
      this.afterListen()
    })
  }
}

// Exporta instância global para módulos que precisem consultar o app/sock sem re-requerer o arquivo.
const __appInstance = new App();
globalThis.__waApp = __appInstance;
__appInstance.listen();
```

---

## public/js/hub.js

```js
// Conecta no SSE para status do WhatsApp (QR/connected/disconnected)
(function(){
  try {
    const es = new EventSource('/api/whatsapp/stream');

    es.addEventListener('status', (ev) => {
      try {
        const data = JSON.parse(ev.data || '{}');
        console.debug('[SSE][status]', data);
        // se existir elemento #wa-status, atualiza
        const el = document.querySelector('#wa-status');
        if (el) {
          el.textContent = data.connected ? 'Conectado' : 'Desconectado';
          el.className = data.connected ? 'ok' : 'fail';
        }
      } catch (e) { console.warn('[SSE] parse error', e); }
    });

    es.onopen = () => console.log('[SSE] aberto');
    es.onerror = (e) => console.warn('[SSE] erro', e);
  } catch (e) {
    console.warn('[SSE] init erro', e);
  }
})();
```

---

## src/routes/admin.js

```js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const database = require('../config/database');
const logger = require('../config/logger');
const SorteiosModule = require('../modules/sorteios');

const router = express.Router();
const INSTANCE_ID = process.env.WA_INSTANCE_ID || 'default';

// Middleware de autenticação
const authenticateAdmin = async (req, res, next) => {
  try {
    const token = req.session.adminToken || req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ error: 'Token de acesso necessário' });
      }
      return res.redirect('/admin/login');
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'whatsapp-automation-secret');
    if (decoded.exp && Date.now() >= decoded.exp * 1000) {
      req.session.destroy();
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ error: 'Sessão expirada' });
      }
      return res.redirect('/admin/login');
    }

    req.admin = decoded;
    next();
  } catch (error) {
    logger.error('❌ Erro na autenticação admin:', error);
    req.session.destroy();
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ error: 'Token inválido' });
    }
    return res.redirect('/admin/login');
  }
};

// Página de login
router.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Login - WhatsApp Automation</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center}.login-container{background:#fff;padding:2rem;border-radius:10px;box-shadow:0 10px 25px rgba(0,0,0,.1);width:100%;max-width:400px}.logo{text-align:center;margin-bottom:2rem;color:#333}.form-group{margin-bottom:1rem}label{display:block;margin-bottom:.5rem;color:#555;font-weight:500}input{width:100%;padding:.75rem;border:2px solid #e1e5e9;border-radius:5px;font-size:1rem;transition:border-color .3s}input:focus{outline:none;border-color:#667eea}.btn{width:100%;padding:.75rem;background:#667eea;color:#fff;border:none;border-radius:5px;font-size:1rem;cursor:pointer;transition:background .3s}.btn:hover{background:#5a6fd8}.error{color:#e74c3c;margin-top:.5rem;font-size:.9rem}</style></head><body><div class="login-container"><div class="logo"><h1>🤖 WhatsApp Automation</h1><p>Painel Administrativo</p></div><form id="loginForm"><div class="form-group"><label for="username">Usuário:</label><input type="text" id="username" name="username" required placeholder="Digite seu usuário"></div><div class="form-group"><label for="password">Senha:</label><input type="password" id="password" name="password" required placeholder="Digite sua senha"></div><button type="submit" class="btn">Entrar</button><div id="error" class="error"></div></form></div><script>document.getElementById('loginForm').addEventListener('submit',async(e)=>{e.preventDefault();const username=document.getElementById('username').value;const password=document.getElementById('password').value;const errorDiv=document.getElementById('error');try{const response=await fetch('/admin/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});const data=await response.json();if(response.ok){window.location.href='/admin/dashboard'}else{errorDiv.textContent=data.error||'Usuário ou senha incorretos'}}catch(error){errorDiv.textContent='Erro de conexão'}});</script></body></html>`);
});

// Autenticação
router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    if (username !== adminUsername || password !== adminPassword) {
      logger.audit('admin_login_failed', `Tentativa de login falhada: ${username}`, username, req.ip);
      return res.status(401).json({ error: 'Usuário ou senha incorretos' });
    }

    const token = jwt.sign({ admin: true, username, timestamp: Date.now() }, process.env.JWT_SECRET || 'whatsapp-automation-secret', { expiresIn: '24h' });
    req.session.adminToken = token;
    logger.audit('admin_login_success', `Login realizado com sucesso: ${username}`, username, req.ip);
    res.json({ success: true, token, username, message: 'Login realizado com sucesso' });
  } catch (error) {
    logger.error('❌ Erro no login admin:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Logout
router.post('/auth/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

// Dashboard principal
router.get('/dashboard', authenticateAdmin, async (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    const jobScheduler = req.app.locals.jobScheduler;
    const whatsappStatus = whatsappClient?.getConnectionStatus?.() || {};
    const jobsStatus = jobScheduler?.getJobsStatus?.() || {};
    res.send(await generateDashboardHTML(whatsappStatus, jobsStatus));
  } catch (error) {
    logger.error('❌ Erro ao carregar dashboard:', error);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

// API: Status do sistema
router.get('/api/status', authenticateAdmin, async (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    const jobScheduler = req.app.locals.jobScheduler;
    const sorteiosModule = new SorteiosModule();

    const status = {
      whatsapp: whatsappClient?.getConnectionStatus?.() || {},
      jobs: jobScheduler?.getJobsStatus?.() || {},
      sorteios: await sorteiosModule.obterEstatisticas(INSTANCE_ID),
      timestamp: new Date().toISOString()
    };
    res.json(status);
  } catch (error) {
    logger.error('❌ Erro ao obter status:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Grupos WhatsApp
router.get('/api/grupos', authenticateAdmin, async (req, res) => {
  try {
    const db = await database.getConnection();
    const grupos = await db.all(`
      SELECT jid, nome, ativo_sorteios, enabled, created_at
      FROM grupos_whatsapp
      WHERE instance_id = ? OR (SELECT COUNT(1) FROM pragma_table_info('grupos_whatsapp') WHERE name='instance_id')=0
      ORDER BY nome
    `, [INSTANCE_ID]);
    res.json(grupos);
  } catch (error) {
    logger.error('❌ Erro ao obter grupos:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Atualizar grupo
router.put('/api/grupos/:jid', authenticateAdmin, async (req, res) => {
  try {
    const { jid } = req.params;
    const { ativo_sorteios, enabled } = req.body;
    const db = await database.getConnection();
    await db.run(`
      UPDATE grupos_whatsapp SET ativo_sorteios = ?, enabled = ?, instance_id = COALESCE(instance_id, ?)
      WHERE jid = ? AND (instance_id = ? OR (SELECT COUNT(1) FROM pragma_table_info('grupos_whatsapp') WHERE name='instance_id')=0)
    `, [ativo_sorteios ? 1 : 0, enabled ? 1 : 0, INSTANCE_ID, jid, INSTANCE_ID]);
    logger.audit('grupo_updated', `Grupo ${jid} atualizado`, 'admin', req.ip);
    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Erro ao atualizar grupo:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Sincronizar grupos do WhatsApp
router.post('/api/grupos/sync', authenticateAdmin, async (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    if (!whatsappClient || !whatsappClient.isConnected) {
      return res.status(400).json({ error: 'WhatsApp não está conectado' });
    }

    const grupos = await whatsappClient.getGroups?.() || await whatsappClient.listGroups?.();
    const db = await database.getConnection();
    let novosGrupos = 0;

    for (const grupo of grupos) {
      const existe = await db.get('SELECT jid FROM grupos_whatsapp WHERE jid = ? AND (instance_id = ? OR (SELECT COUNT(1) FROM pragma_table_info("grupos_whatsapp") WHERE name="instance_id")=0)', [grupo.jid, INSTANCE_ID]);
      if (!existe) {
        await db.run(`
          INSERT INTO grupos_whatsapp (jid, nome, ativo_sorteios, enabled, instance_id)
          VALUES (?, ?, 0, 1, ?)
        `, [grupo.jid, grupo.nome || grupo.name, INSTANCE_ID]);
        novosGrupos++;
      } else {
        await db.run('UPDATE grupos_whatsapp SET nome = ?, instance_id = COALESCE(instance_id, ?) WHERE jid = ?', [grupo.nome || grupo.name, INSTANCE_ID, grupo.jid]);
      }
    }

    logger.audit('grupos_sync', `${novosGrupos} novos grupos sincronizados`, 'admin', req.ip);
    res.json({ success: true, novosGrupos, totalGrupos: grupos.length });
  } catch (error) {
    logger.error('❌ Erro ao sincronizar grupos:', error);
    res.status(500).json({ error: error.message });
  }
});

// (demais rotas mantidas 100%)

// API: Textos de sorteios
router.get('/api/textos', authenticateAdmin, async (req, res) => {
  try {
    const db = await database.getConnection();
    const textos = await db.all(`SELECT * FROM textos_sorteios ORDER BY id`);
    res.json(textos);
  } catch (error) {
    logger.error('❌ Erro ao obter textos:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Criar/Atualizar texto
router.post('/api/textos', authenticateAdmin, async (req, res) => {
  try {
    const { id, texto_template, ativo } = req.body;
    const db = await database.getConnection();
    if (id) {
      await db.run(`UPDATE textos_sorteios SET texto_template = ?, ativo = ? WHERE id = ?`, [texto_template, ativo ? 1 : 0, id]);
    } else {
      await db.run(`INSERT INTO textos_sorteios (texto_template, ativo) VALUES (?, ?)`, [texto_template, ativo ? 1 : 0]);
    }
    logger.audit('texto_updated', `Texto ${id ? 'atualizado' : 'criado'}`, 'admin', req.ip);
    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Erro ao salvar texto:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Deletar texto
router.delete('/api/textos/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const db = await database.getConnection();
    await db.run('DELETE FROM textos_sorteios WHERE id = ?', [id]);
    logger.audit('texto_deleted', `Texto ${id} deletado`, 'admin', req.ip);
    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Erro ao deletar texto:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Cupons
router.get('/api/cupons', authenticateAdmin, async (req, res) => {
  try {
    const db = await database.getConnection();
    const cupom = await db.get(`SELECT * FROM cupons_atuais ORDER BY atualizado_em DESC LIMIT 1`);
    res.json(cupom || { cupom1: '', cupom2: '' });
  } catch (error) {
    logger.error('❌ Erro ao obter cupons:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Atualizar cupons
router.post('/api/cupons', authenticateAdmin, async (req, res) => {
  try {
    const { cupom1, cupom2 } = req.body;
    const db = await database.getConnection();
    await db.run(`INSERT INTO cupons_atuais (cupom1, cupom2) VALUES (?, ?)`, [cupom1, cupom2]);
    logger.audit('cupons_updated', 'Cupons atualizados', 'admin', req.ip);
    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Erro ao atualizar cupons:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Executar job manualmente
router.post('/api/jobs/:name/run', authenticateAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    const jobScheduler = req.app.locals.jobScheduler;
    if (!jobScheduler) { return res.status(400).json({ error: 'Agendador não disponível' }); }
    await jobScheduler.runJobNow(name);
    logger.audit('job_manual_run', `Job ${name} executado manualmente`, 'admin', req.ip);
    res.json({ success: true });
  } catch (error) {
    logger.error(`❌ Erro ao executar job ${req.params.name}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// API: Processar sorteio manual
router.post('/api/sorteios/processar', authenticateAdmin, async (req, res) => {
  try {
    const { codigo } = req.body;
    const sorteiosModule = new SorteiosModule();
    const resultado = await sorteiosModule.processarSorteioManual(codigo);
    logger.audit('sorteio_manual', `Sorteio ${codigo} processado manualmente`, 'admin', req.ip);
    res.json(resultado);
  } catch (error) {
    logger.error('❌ Erro ao processar sorteio manual:', error);
    res.status(500).json({ error: error.message });
  }
});

// (HTML de dashboard público e privado permanecem conforme você enviou)
// Rota principal /admin - redireciona para dashboard
router.get('/', authenticateAdmin, (req, res) => { res.redirect('/admin/dashboard'); });

module.exports = router;
```

---

## src/modules/sorteios.js

```js
const logger = require('../config/logger');
const database = require('../config/database');
const DateUtils = require('../utils/date');
const GoogleSheetsService = require('../services/google-sheets');
const ScraperService = require('../services/scraper');
const ImageGeneratorService = require('../services/image-generator-simple');
const metricsService = require('../services/metrics'); // shim → telemetry/metrics

const INSTANCE_ID = process.env.WA_INSTANCE_ID || 'default';
const WA_POST_TO = (process.env.WA_POST_TO || '').trim();

function phoneToJid(v){ if(!v) return null; const s=String(v).trim(); if(s.includes('@')) return s; const d=s.replace(/\D/g,''); if(!d) return null; return `${d}@s.whatsapp.net`; }
function parsePhonesToJids(value){ if(!value) return []; return String(value).split(/[\,\s;]+/).map(s=>s.trim()).filter(Boolean).map(v=>v.includes('@')?v:phoneToJid(v)).filter(Boolean); }

function getApp(){ try { return globalThis.__waApp || null } catch { return null } }
function pickSock(){ const app = getApp(); try { if(app?.waAdmin?.getSock){ const s = app.waAdmin.getSock(); if(s) return s; } } catch(_){} try { if(app?.whatsappClient?.sock) return app.whatsappClient.sock; } catch(_){} return null }

class SorteiosModule {
  constructor() {
    this.googleSheets = new GoogleSheetsService();
    this.scraper = new ScraperService();
    this.imageGenerator = new ImageGeneratorService();
    this.textosBase = [];
    this.cupomAtual = null;
  }

  async monitorarSorteiosElegiveis(executionId) {
    const startTime = Date.now();
    try {
      logger.info('🔍 Iniciando monitoramento de sorteios elegíveis...');
      const sorteiosElegiveis = await this.googleSheets.getSorteiosElegiveis();
      if (sorteiosElegiveis.length === 0) {
        logger.info('ℹ️ Nenhum sorteio elegível encontrado para processamento');
        metricsService.recordSorteioProcessado('no_eligible');
        return { processados: 0, total: 0 };
      }
      logger.info(`🎯 ${sorteiosElegiveis.length} sorteios elegíveis encontrados`);
      const resultados = [];
      for (const sorteio of sorteiosElegiveis) {
        try {
          logger.info(`🔄 Processando sorteio elegível: ${sorteio.codigo} (${sorteio.motivoElegivel})`);
          const resultado = await this.processarSorteioElegivel(sorteio);
          resultados.push(resultado);
          metricsService.recordSorteioProcessado('success');
        } catch (error) {
          logger.error(`❌ Erro ao processar sorteio elegível ${sorteio.codigo}:`, error);
          metricsService.recordSorteioProcessado('error');
        }
      }
      const duration = (Date.now() - startTime) / 1000;
      metricsService.recordJobDuration('monitor-sorteios', 'completed', duration);
      logger.info(`✅ Monitoramento concluído: ${resultados.length}/${sorteiosElegiveis.length} sorteios processados`);
      return { total: sorteiosElegiveis.length, processados: resultados.length, resultados, executionId };
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      metricsService.recordJobDuration('monitor-sorteios', 'failed', duration);
      logger.error('❌ Erro no monitoramento de sorteios elegíveis:', error);
      throw error;
    }
  }

  async processarSorteioElegivel(sorteioElegivel) {
    const { codigo } = sorteioElegivel;
    try {
      logger.info(`🎯 Processando sorteio elegível: ${codigo}`);
      const jaProcessado = await this.verificarSeJaProcessado(codigo);
      if (jaProcessado) { logger.info(`ℹ️ Sorteio ${codigo} já foi processado (double-check)`); return { codigo, status: 'already_processed' }; }
      const dadosCompletos = await this.scraper.obterDadosCompletos(sorteioElegivel);
      const imagePath = await this.imageGenerator.gerarImagemSorteio(dadosCompletos);
      const mensagem = await this.prepararMensagem(dadosCompletos);
      const resultadoEnvio = await this.enviarParaGrupos(dadosCompletos, imagePath, mensagem);
      await this.registrarComoProcessado(dadosCompletos);
      await this.googleSheets.marcarComoPostado(codigo, new Date());
      logger.info(`✅ Sorteio elegível ${codigo} processado com sucesso`);
      return { codigo, status: 'success', ganhador: dadosCompletos.ganhador, gruposEnviados: resultadoEnvio.sucessos.length, imagePath, horarioOriginal: sorteioElegivel.horarioCompleto, horarioProcessamento: new Date() };
    } catch (error) { logger.error(`❌ Erro ao processar sorteio elegível ${codigo}:`, error); throw error; }
  }

  async processarSorteiosDiarios(executionId) {
    const startTime = Date.now();
    try {
      logger.info('🎯 Iniciando processamento diário de sorteios...');
      const sorteiosPlanilha = await this.googleSheets.getSorteiosProcessadosHoje();
      if (sorteiosPlanilha.length === 0) { logger.info('ℹ️ Nenhum sorteio encontrado para hoje'); metricsService.recordSorteioProcessado('no_sorteios'); return; }
      logger.info(`📊 ${sorteiosPlanilha.length} sorteios encontrados na planilha`);
      const resultados = [];
      for (const sorteio of sorteiosPlanilha) {
        try { const resultado = await this.processarSorteioIndividual(sorteio); resultados.push(resultado); metricsService.recordSorteioProcessado('success'); }
        catch (error) { logger.error(`❌ Erro ao processar sorteio ${sorteio.codigo}:`, error); metricsService.recordSorteioProcessado('error'); }
      }
      const duration = (Date.now() - startTime) / 1000; metricsService.recordJobDuration('sorteios-diarios', 'completed', duration);
      logger.info(`✅ Processamento concluído: ${resultados.length}/${sorteiosPlanilha.length} sorteios processados`);
      return { total: sorteiosPlanilha.length, processados: resultados.length, executionId };
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000; metricsService.recordJobDuration('sorteios-diarios', 'failed', duration);
      logger.error('❌ Erro no processamento diário de sorteios:', error); throw error;
    }
  }

  async processarSorteioIndividual(sorteioBase) {
    const { codigo } = sorteioBase;
    try {
      logger.info(`🎯 Processando sorteio individual: ${codigo}`);
      const jaProcessado = await this.verificarSeJaProcessado(codigo);
      if (jaProcessado) { logger.info(`ℹ️ Sorteio ${codigo} já foi processado hoje`); return { codigo, status: 'already_processed' }; }
      const dadosCompletos = await this.scraper.obterDadosCompletos(sorteioBase);
      const imagePath = await this.imageGenerator.gerarImagemSorteio(dadosCompletos);
      const mensagem = await this.prepararMensagem(dadosCompletos);
      const resultadoEnvio = await this.enviarParaGrupos(dadosCompletos, imagePath, mensagem);
      await this.registrarComoProcessado(dadosCompletos);
      logger.info(`✅ Sorteio ${codigo} processado com sucesso`);
      return { codigo, status: 'success', ganhador: dadosCompletos.ganhador, gruposEnviados: resultadoEnvio.sucessos.length, imagePath };
    } catch (error) { logger.error(`❌ Erro ao processar sorteio ${codigo}:`, error); throw error; }
  }

  async verificarSeJaProcessado(codigo) {
    const db = await database.getConnection();
    const resultado = await db.get(`
      SELECT codigo_sorteio FROM sorteios_processados
      WHERE codigo_sorteio = ? AND date(processed_at) = date('now')
        AND (instance_id = ? OR (SELECT COUNT(1) FROM pragma_table_info('sorteios_processados') WHERE name='instance_id')=0)
    `, [codigo, INSTANCE_ID]);
    return !!resultado;
  }

  async registrarComoProcessado(d) {
    const db = await database.getConnection();
    await db.run(`
      INSERT OR REPLACE INTO sorteios_processados (codigo_sorteio, data_sorteio, nome_premio, ganhador, processed_at, instance_id)
      VALUES (?, ?, ?, ?, datetime('now','utc'), ?)
    `, [d.codigo, d.data, d.premio, d.ganhador, INSTANCE_ID]);
    logger.info(`📝 Sorteio ${d.codigo} registrado como processado`);
  }

  async prepararMensagem(dadosSorteio) {
    try {
      const textosBase = await this.obterTextosBase();
      if (textosBase.length === 0) throw new Error('Nenhum texto base encontrado');
      const textoEscolhido = textosBase[Math.floor(Math.random() * textosBase.length)];
      const cupom = await this.obterCupomAtual();
      let mensagem = textoEscolhido.texto_template;
      mensagem = mensagem.replace(/\{NOME_GANHADOR\}/g, dadosSorteio.ganhador)
                         .replace(/\{PREMIO\}/g, dadosSorteio.premio)
                         .replace(/\{LINK_RESULTADO\}/g, dadosSorteio.urlCompleta)
                         .replace(/\{CUPOM\}/g, cupom || 'PEGAJ')
                         .replace(/\{DATA_SORTEIO\}/g, dadosSorteio.data)
                         .replace(/\{CODIGO_SORTEIO\}/g, dadosSorteio.codigo);
      logger.info(`📝 Mensagem preparada para sorteio ${dadosSorteio.codigo}`);
      return mensagem;
    } catch (error) {
      logger.error('❌ Erro ao preparar mensagem:', error);
      return `🎉 Parabéns ${dadosSorteio.ganhador}!\nVocê ganhou o ${dadosSorteio.premio}!\n\n🔗 Veja o resultado completo:\n${dadosSorteio.urlCompleta}\n\n📞 Fale comigo no WhatsApp: (48) 9 9178-4733`;
    }
  }

  async obterTextosBase() {
    const db = await database.getConnection();
    const textos = await db.all(`SELECT * FROM textos_sorteios WHERE ativo = 1 ORDER BY id`);
    return textos;
  }

  async obterCupomAtual() {
    const db = await database.getConnection();
    const cupom = await db.get(`SELECT cupom1 FROM cupons_atuais ORDER BY atualizado_em DESC LIMIT 1`);
    return cupom?.cupom1 || 'PEGAJ';
  }

  async enviarParaGrupos(dadosSorteio, imagePath, mensagem) {
    try {
      // 1) Alvo por EV (sobrepõe DB) — aceita números, JIDs, separados por vírgula/; ou espaço
      let gruposAtivos = [];
      if (WA_POST_TO) {
        const jids = parsePhonesToJids(WA_POST_TO);
        gruposAtivos = jids.map(jid => ({ jid, nome: jid }));
      } else {
        gruposAtivos = await this.obterGruposAtivos();
      }

      if (gruposAtivos.length === 0) { logger.warn('⚠️ Nenhum grupo ativo encontrado'); return { sucessos: [], erros: [] }; }
      logger.info(`📤 Enviando para ${gruposAtivos.length} grupos ativos...`);

      // 2) Cliente WhatsApp (prefere admin.sock; senão fallback)
      const app = getApp();
      const waClient = app?.whatsappClient || null;
      const sock = pickSock();
      if (!waClient && !sock) throw new Error('WhatsApp não está conectado');

      const sucessos = []; const erros = [];
      for (const grupo of gruposAtivos) {
        const idempotencyKey = `${INSTANCE_ID}:${dadosSorteio.codigo}:${grupo.jid}:${DateUtils.getHojeBrasil()}`;
        try {
          const ja = await this.verificarSeJaEnviado(idempotencyKey);
          if (ja) { logger.info(`ℹ️ Mensagem já enviada para grupo ${grupo.nome}`); continue; }
          await this.registrarTentativaEnvio(idempotencyKey, dadosSorteio.codigo, grupo.jid);

          let result = null;
          if (waClient?.sendImageMessage) {
            result = await waClient.sendImageMessage(grupo.jid, imagePath, mensagem, { quoted: null });
          } else if (sock) {
            const { default: fs } = await import('node:fs');
            const buf = fs.readFileSync(imagePath);
            result = await sock.sendMessage(grupo.jid, { image: buf, caption: mensagem });
          } else { throw new Error('Sem cliente nem socket'); }

          await this.atualizarStatusEnvio(idempotencyKey, 'sent', result?.key?.id || null);
          sucessos.push({ grupo: grupo.nome, jid: grupo.jid, messageId: result?.key?.id || null });
          metricsService.recordMessageSent(grupo.nome, dadosSorteio.codigo);
          logger.info(`✅ Enviado para grupo: ${grupo.nome}`);
          await this.sleep(30000); // 30s entre envios
        } catch (error) {
          await this.atualizarStatusEnvio(idempotencyKey, 'failed_perm', null, error.message);
          erros.push({ grupo: grupo.nome, jid: grupo.jid, erro: error.message });
          metricsService.recordMessageFailed(grupo.nome, error.name || 'unknown', dadosSorteio.codigo);
          logger.error(`❌ Erro ao enviar para grupo ${grupo.nome}:`, error);
        }
      }

      logger.info(`📊 Envio concluído: ${sucessos.length} sucessos, ${erros.length} erros`);
      return { sucessos, erros };
    } catch (error) { logger.error('❌ Erro ao enviar para grupos:', error); throw error; }
  }

  async obterGruposAtivos() {
    const db = await database.getConnection();
    const grupos = await db.all(`
      SELECT jid, nome FROM grupos_whatsapp
      WHERE ativo_sorteios = 1 AND enabled = 1
        AND (instance_id = ? OR (SELECT COUNT(1) FROM pragma_table_info('grupos_whatsapp') WHERE name='instance_id')=0)
      ORDER BY nome
    `, [INSTANCE_ID]);
    return grupos;
  }

  async verificarSeJaEnviado(idempotencyKey) {
    const db = await database.getConnection();
    const r = await db.get(`
      SELECT id FROM envios_whatsapp
      WHERE idempotency_key = ? AND status IN ('sent','delivered')
        AND (instance_id = ? OR (SELECT COUNT(1) FROM pragma_table_info('envios_whatsapp') WHERE name='instance_id')=0)
    `, [idempotencyKey, INSTANCE_ID]);
    return !!r;
  }

  async registrarTentativaEnvio(idempotencyKey, codigoSorteio, grupoJid) {
    const db = await database.getConnection();
    await db.run(`
      INSERT OR IGNORE INTO envios_whatsapp (idempotency_key, codigo_sorteio, grupo_jid, status, tentativas, instance_id)
      VALUES (?, ?, ?, 'pending', 0, ?)
    `, [idempotencyKey, codigoSorteio, grupoJid, INSTANCE_ID]);
  }

  async atualizarStatusEnvio(idempotencyKey, status, messageKeyId = null, erro = null) {
    const db = await database.getConnection();
    await db.run(`
      UPDATE envios_whatsapp
      SET status = ?, message_key_id = ?, ultimo_erro = ?,
          enviado_em = CASE WHEN ? = 'sent' THEN datetime('now','utc') ELSE enviado_em END,
          instance_id = COALESCE(instance_id, ?)
      WHERE idempotency_key = ?
    `, [status, messageKeyId, erro, status, INSTANCE_ID, idempotencyKey]);
  }

  async processarSorteioManual(codigoSorteio) {
    try {
      logger.info(`🔧 Processamento manual do sorteio: ${codigoSorteio}`);
      const dadosScraping = await this.scraper.scrapeSorteio(codigoSorteio);
      const dadosBase = { codigo: codigoSorteio, data: DateUtils.getHojeBrasil(), premio: dadosScraping.premio, urlResultado: dadosScraping.urlCompleta };
      const resultado = await this.processarSorteioIndividual(dadosBase);
      logger.info(`✅ Processamento manual concluído para ${codigoSorteio}`);
      return resultado;
    } catch (error) { logger.error(`❌ Erro no processamento manual de ${codigoSorteio}:`, error); throw error; }
  }

  async obterEstatisticas() {
    const db = await database.getConnection();
    const stats = await db.get(`
      SELECT
        COUNT(*) as total_processados,
        COUNT(CASE WHEN date(processed_at) = date('now') THEN 1 END) as hoje,
        COUNT(CASE WHEN date(processed_at) = date('now','-1 day') THEN 1 END) as ontem,
        COUNT(CASE WHEN date(processed_at) >= date('now','-7 days') THEN 1 END) as ultima_semana
      FROM sorteios_processados
      WHERE (instance_id = ? OR (SELECT COUNT(1) FROM pragma_table_info('sorteios_processados') WHERE name='instance_id')=0)
    `, [INSTANCE_ID]);

    const envios = await db.get(`
      SELECT
        COUNT(*) as total_envios,
        COUNT(CASE WHEN status = 'sent' THEN 1 END) as enviados,
        COUNT(CASE WHEN status LIKE 'failed%' THEN 1 END) as falhados
      FROM envios_whatsapp
      WHERE date(created_at) >= date('now','-7 days')
        AND (instance_id = ? OR (SELECT COUNT(1) FROM pragma_table_info('envios_whatsapp') WHERE name='instance_id')=0)
    `, [INSTANCE_ID]);

    return { sorteios: stats, envios, timestamp: new Date().toISOString() };
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = SorteiosModule;
```

---

## src/modules/assistant-bot.js

```js
// src/modules/assistant-bot.js
// Liga entrada (mensagens 1:1) -> coalesce/greet -> intents -> OpenAI -> reply-queue

const fs = require('fs');
const axios = require('axios');
const { pushIncoming, markGreeted } = require('../services/inbox-state');
const { enqueueText } = require('../services/reply-queue');
const { fetchTopCoupons } = require('../services/coupons');
const { detectIntent } = require('../services/intent-registry');
const { securityReply } = require('../services/security');

let transcribeAudioIfAny = null; try { ({ transcribeAudioIfAny } = require('../services/audio-transcriber')); } catch (_) {}
let nameUtils = null; try { nameUtils = require('../services/name-utils'); } catch (_) {}
let heuristics = null; try { heuristics = require('../services/heuristics'); } catch (_) {}

const ASSISTANT_ENABLED = String(process.env.ASSISTANT_ENABLED || '0') === '1';
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL      = process.env.OPENAI_MODEL || 'gpt-4o';
const ASSISTANT_TEMP    = Number(process.env.ASSISTANT_TEMPERATURE || 0.6);
const ASSISTANT_QUEUE_CAP = Math.max(0, Number(process.env.ASSISTANT_QUEUE_CAP || 0)); // 0 = sem limite

const GREET_TEXT = (process.env.ASSISTANT_GREET_TEXT || '').trim();
const RULE_GREETING_ON = String(process.env.ASSISTANT_RULE_GREETING || '0') === '1';

const LINKS = {
  promosProgressivo: 'https://www.natura.com.br/c/promocao-da-semana?consultoria=clubemac',
  promosGerais:      'https://www.natura.com.br/c/promocoes?consultoria=clubemac',
  monteSeuKit:       'https://www.natura.com.br/c/monte-seu-kit?consultoria=clubemac',
  sabonetes:         'https://www.natura.com.br/c/corpo-e-banho-sabonete-barra?consultoria=clubemac',
  cuponsSite:        'https://bit.ly/cupons-murilo',
  sorteioWhats:      'https://wa.me/5548991021707',
  sorteioInsta:      'https://ig.me/m/murilo_cerqueira_consultoria',
  sorteioMsg:        'http://m.me/murilocerqueiraconsultor',
  grupoResultados:   'https://chat.whatsapp.com/JSBFWPmUdCZ2Ef5saq0kE6',
  insta:             'https://www.instagram.com/murilo_cerqueira_consultoria',
  tiktok:            'https://www.tiktok.com/@murilocerqueiraconsultor',
  whatsMurilo:       'https://wa.me/5548991111707',
  grupoMurilo:       'https://chat.whatsapp.com/E51Xhe0FS0e4Ii54i71NjG'
};

function loadSystemText() {
  try { const file = (process.env.ASSISTANT_SYSTEM_FILE || '').trim(); if (file) { const txt = fs.readFileSync(file, 'utf8'); if (txt && txt.trim()) return txt.trim(); } } catch (_) {}
  const envTxt = (process.env.ASSISTANT_SYSTEM || '').trim(); if (envTxt) return envTxt;
  return 'Você é o atendente virtual do Murilo Cerqueira (Natura). Siga as regras do arquivo assistant-system.txt. Não invente links; use apenas os oficiais com ?consultoria=clubemac.';
}
const SYSTEM_TEXT = loadSystemText();

// ───────── Intents rápidas (compat) ─────────
function wantsCoupon(text){ const s=String(text||'').toLowerCase(); return /\b(cupom|cupon|cupum|cupao|coupon|kupon|coupom|coupoin)s?\b/.test(s); }
function wantsPromos(text){ const s=String(text||'').toLowerCase(); return /(promo(ç|c)[aã]o|promos?\b|oferta|desconto|liquid(a|ã)c?[aã]o|sale)/i.test(s); }
function wantsRaffle(text){ const s=String(text||'').toLowerCase().trim(); if(/^[\s7]+$/.test(s)) return true; if(/\bsete\b/.test(s)) return true; return /(sorteio|participar.*sorteio|quero.*sorteio|ganhar.*sorteio|\benviar\b.*\b7\b|\bmandar\b.*\b7\b)/i.test(s); }
function wantsThanks(text){ const s=String(text||'').toLowerCase().trim(); return /(^|\b)(obrigad[oa]|obg|valeu|vlw|🙏|❤|❤️)($|\b)/i.test(s); }
function wantsSocial(text){ const s=String(text||'').toLowerCase(); return /(instagram|insta\b|ig\b|tiktok|tik[\s-]?tok|whatsapp|zap|grupo)/i.test(s); }
function wantsSoap(text){ const s=String(text||'').toLowerCase(); return /(sabonete|sabonetes)/i.test(s); }
function wantsCouponProblem(text){ const s=String(text||'').toLowerCase(); return /(cupom|codigo|código).*(n[aã]o.*(aplic|funcion)|erro)|erro.*(cupom|c[oó]digo)/i.test(s); }
function wantsOrderSupport(text){ const s=String(text||'').toLowerCase(); return /(pedido|compra|encomenda|pacote|entrega|nota fiscal|pagamento|boleto).*(problema|atras|n[aã]o chegou|nao recebi|erro|sumiu|cad[eê])|rastre(i|ei)o|codigo de rastreio|transportadora/.test(s); }

function wantsProductTopic(text){ const s=String(text||'').toLowerCase(); return /(hidrat\w+|perfum\w+|desodorant\w+|sabonete\w*|cabel\w+|maquiag\w+|barb\w+|infantil\w*|present\w*|kit\w*|aura\b|ekos\b|kaiak\b|essencial\b|luna\b|tododia\b|mam[aã]e.*beb[eê]\b|una\b|faces\b|chronos\b|lumina\b|biome\b|bothanica\b)/i.test(s); }

const USE_BUTTONS = String(process.env.ASSISTANT_USE_BUTTONS || '0') === '1';
async function sendUrlButtons(sock, jid, headerText, buttons, footer = 'Murilo • Natura') {
  try { await sock.sendMessage(jid, { text: headerText, footer, templateButtons: buttons }); return true; } catch (e) { console.error('[assistant] buttons send error:', e?.message || e); return false; }
}

async function replaceCouponMarkers(text) {
  try {
    if (!text || !/\{\{\s*CUPOM\s*\}\}/i.test(text)) return text;
    const list = await fetchTopCoupons(2);
    const cup = Array.isArray(list) && list.length ? (list.length > 1 ? `${list[0]} ou ${list[1]}` : list[0]) : 'CLUBEMAC';
    return text.replace(/\{\{\s*CUPOM\s*\}\}/gi, cup);
  } catch (_) { return text; }
}

async function replyCoupons(sock, jid) {
  let list = []; try { list = await fetchTopCoupons(2); } catch (_) {}
  const nota = 'Obs.: os cupons só funcionam no meu Espaço Natura — na tela de pagamento, procure por "Murilo Cerqueira".';
  const promoLine = `Promoções do dia: ${LINKS.promosGerais}`;
  if (Array.isArray(list) && list.length) {
    const [c1, c2] = list;
    const linha = c2 ? `Tenho dois cupons agora: *${c1}* ou *${c2}* 😉` : `Tenho um cupom agora: *${c1}* 😉`;
    if (USE_BUTTONS) {
      const ok = await sendUrlButtons(sock, jid, `${linha}\n${nota}`, [
        { index: 1, urlButton: { displayText: 'Ver promoções', url: LINKS.promosGerais } },
        { index: 2, urlButton: { displayText: 'Mais cupons',    url: LINKS.cuponsSite   } },
      ]); if (ok) return true;
    }
    safeEnqueue(sock, jid, `${linha}\n${nota}`);
    safeEnqueue(sock, jid, `Mais cupons: ${LINKS.cuponsSite}`);
    safeEnqueue(sock, jid, promoLine); return true;
  }
  const header = 'No momento não consigo listar um código agora. Veja os cupons atuais aqui:';
  if (USE_BUTTONS) {
    const ok = await sendUrlButtons(sock, jid, `${header}\n${LINKS.cuponsSite}\n${nota}`, [
      { index: 1, urlButton: { displayText: 'Ver cupons',    url: LINKS.cuponsSite   } },
      { index: 2, urlButton: { displayText: 'Ver promoções', url: LINKS.promosGerais } },
    ]); if (ok) return true;
  }
  safeEnqueue(sock, jid, `${header} ${LINKS.cuponsSite}\n${nota}`);
  safeEnqueue(sock, jid, promoLine);
  return true;
}

async function replyPromos(sock, jid) {
  const header = 'Ofertas do dia (consultoria ativa):\n' +
    `• Desconto progressivo ➡️ ${LINKS.promosProgressivo}\n` +
    `  Observação: o desconto máximo (pode chegar a 50%) costuma exigir 3 a 4 produtos dentre 328 disponíveis e há frete grátis aplicando cupom.\n` +
    `• Produtos em promoção ➡️ ${LINKS.promosGerais}\n` +
    `  Observação: 723 itens com até 70% OFF e frete grátis aplicando cupom.\n` +
    `• Monte seu kit ➡️ ${LINKS.monteSeuKit}\n` +
    `  Observação: comprando 4 itens (dentre 182), ganha 40% OFF e frete grátis.`;
  if (USE_BUTTONS) {
    const ok = await sendUrlButtons(sock, jid, header, [
      { index: 1, urlButton: { displayText: 'Ver promoções',        url: LINKS.promosGerais      } },
      { index: 2, urlButton: { displayText: 'Desconto progressivo', url: LINKS.promosProgressivo } },
      { index: 3, urlButton: { displayText: 'Monte seu kit',        url: LINKS.monteSeuKit       } },
    ]); await replyCoupons(sock, jid); if (ok) return;
  }
  safeEnqueue(sock, jid, header);
  await replyCoupons(sock, jid);
}

function replySoap(sock, jid){ safeEnqueue(sock, jid, `Sabonetes em promoção ➡️ ${LINKS.sabonetes}`); return replyCoupons(sock, jid); }
function replyRaffle(sock, jid){ safeEnqueue(sock, jid, `Para participar do sorteio, envie **7** (apenas o número) em UMA ou MAIS redes:\n• WhatsApp: ${LINKS.sorteioWhats}\n• Instagram: ${LINKS.sorteioInsta}\n• Messenger: ${LINKS.sorteioMsg}\n\nCada rede vale *1 chance extra*. Resultados são divulgados no grupo: ${LINKS.grupoResultados} 🎉`); }
function replyThanks(sock, jid){ safeEnqueue(sock, jid, 'Por nada! ❤️ Conte comigo sempre!'); }
function replySocial(sock, jid, text){ const s=(text||'').toLowerCase(); if(/instagram|insta\b|^ig$/.test(s)) return safeEnqueue(sock,jid,`Instagram ➡️ ${LINKS.insta}`); if(/tiktok|tik[\s-]?tok/.test(s)) return safeEnqueue(sock,jid,`Tiktok ➡️ ${LINKS.tiktok}`); if(/grupo/.test(s)) return safeEnqueue(sock,jid,`Grupo de Whatsapp ➡️ ${LINKS.grupoMurilo}`); if(/whatsapp|zap/.test(s)) return safeEnqueue(sock,jid,`Whatsapp ➡️ ${LINKS.whatsMurilo}`); safeEnqueue(sock,jid,`Minhas redes:\nInstagram ➡️ ${LINKS.insta}\nTiktok ➡️ ${LINKS.tiktok}\nWhatsapp ➡️ ${LINKS.whatsMurilo}\nGrupo de Whatsapp ➡️ ${LINKS.grupoMurilo}`) }
function replyCouponProblem(sock, jid){ safeEnqueue(sock, jid, `O cupom só funciona no meu Espaço Natura. Na tela de pagamento, procure por *Murilo Cerqueira* ou, em "Minha Conta", escolha seu consultor.\nTente outro cupom e veja mais em: ${LINKS.cuponsSite}\nSe puder, feche e abra o app/navegador ou troque entre app e navegador.\nAcesse promoções com a consultoria correta: ${LINKS.promosGerais}`) }
function replyOrderSupport(sock, jid){ safeEnqueue(sock, jid, `Pagamentos, nota fiscal, pedido e entrega são tratados pelo suporte oficial da Natura:\nhttps://www.natura.com.br/ajuda-e-contato\nDica: no chat, digite 4x “Falar com atendente” para acelerar o atendimento humano.\nVisualizar seus pedidos: https://www.natura.com.br/meus-dados/pedidos?consultoria=clubemac`) }
async function replyBrand(sock, jid, brandName){ safeEnqueue(sock,jid,`Posso te ajudar com a linha *${brandName}* 😊\nVocê pode conferir os itens em promoção aqui: ${LINKS.promosGerais}\nSe quiser, me diga qual produto da linha que você procura.`); await replyCoupons(sock,jid); }

async function askOpenAI({ prompt, userName, isNewTopic }) {
  const fallback = 'Estou online! Se quiser, posso buscar promoções, cupons ou tirar dúvidas rápidas. 🙂✨';
  if (!OPENAI_API_KEY) return fallback;
  const rules = [
    SYSTEM_TEXT,'','Regras de execução:',
    `- Nome do cliente: ${userName || '(desconhecido)'}`,
    `- isNewTopic=${isNewTopic ? 'true' : 'false'}`,
    '- Use SOMENTE os links listados nas seções 3/4/5/6/8, sempre com ?consultoria=clubemac. Se não houver link específico, não forneça link.',
    '- Nunca formate link como markdown/âncora. Exiba o texto exato do link.',
    '- Se precisar de cupom, escreva exatamente o marcador {{CUPOM}} que o sistema substituirá pelo(s) código(s).'
  ].join('\n');
  try {
    const { data } = await axios.post('https://api.openai.com/v1/chat/completions', { model: OPENAI_MODEL, temperature: ASSISTANT_TEMP, messages: [ { role: 'system', content: rules }, { role: 'user', content: String(prompt || '').trim() } ] }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 25000 });
    const out = data?.choices?.[0]?.message?.content?.trim();
    return out || fallback;
  } catch (e) {
    console.error('[assistant] openai error:', e?.response?.data || e?.message || e);
    return 'Desculpe, algo deu errado 😅. Pode tentar novamente em instantes?';
  }
}

function extractText(msg){ try{ const m0=msg?.message||{}; const m=m0.ephemeralMessage?.message||m0; if(m.conversation) return m.conversation; if(m.extendedTextMessage?.text) return m.extendedTextMessage.text; if(m.imageMessage?.caption) return m.imageMessage.caption; if(m.videoMessage?.caption) return m.videoMessage.caption; if(m.documentMessage?.caption) return m.documentMessage.caption; }catch(_){} return '' }
function hasMedia(msg){ try{ const m0=msg?.message||{}; const m=m0.ephemeralMessage?.message||m0; return !!(m.imageMessage||m.videoMessage||m.documentMessage||m.audioMessage||m.stickerMessage) }catch(_){ return false } }
function isGroup(jid){ return String(jid).endsWith('@g.us') }
function isStatus(jid){ return String(jid||'')==='status@broadcast' }
function isFromMe(msg){ return !!msg?.key?.fromMe }

// Limite de enfileiramento simples por JID (não interfere no reply-queue real)
const _capMap = new Map();
function safeEnqueue(sock, jid, text){
  if (!ASSISTANT_QUEUE_CAP) return enqueueText(sock, jid, text);
  const k = String(jid);
  const used = _capMap.get(k) || 0;
  if (used >= ASSISTANT_QUEUE_CAP) return false;
  _capMap.set(k, used + 1);
  return enqueueText(sock, jid, text);
}

function buildUpsertHandler(getSock) {
  return async (ev) => {
    try {
      if (!ev?.messages?.length) return;
      const m = ev.messages[0];
      const jid = m?.key?.remoteJid;
      if (!jid || isFromMe(m) || isGroup(jid) || isStatus(jid)) return;

      let text = extractText(m);
      if ((!text || !text.trim()) && typeof transcribeAudioIfAny === 'function') {
        try { const sockNow0 = getSock(); text = await transcribeAudioIfAny(sockNow0, m); } catch (_) {}
      }
      if (!text || !text.trim()) return;

      const rawName = (m.pushName || '').trim();
      const hadMedia = hasMedia(m);

      pushIncoming(jid, text, async (batch, ctx) => {
        const sockNow = getSock(); if (!sockNow) return;
        const joined = batch.join(' ').trim();
        const intent = detectIntent ? detectIntent(joined) : { type: null, data: null };

        if (intent.type === 'security') { safeEnqueue(sockNow, jid, securityReply()); return; }
        if (intent.type === 'thanks' || wantsThanks(joined))                { replyThanks(sockNow, jid); return; }
        if (intent.type === 'coupon_problem' || wantsCouponProblem(joined)) { replyCouponProblem(sockNow, jid); return; }
        if (intent.type === 'order_support'  || wantsOrderSupport(joined))  { replyOrderSupport(sockNow, jid); return; }
        if (intent.type === 'raffle'         || wantsRaffle(joined))        { replyRaffle(sockNow, jid); return; }
        if (intent.type === 'coupon'         || wantsCoupon(joined))        { await replyCoupons(sockNow, jid); return; }
        if (intent.type === 'promos'         || wantsPromos(joined))        { await replyPromos(sockNow, jid); return; }
        if (intent.type === 'social'         || wantsSocial(joined))        { replySocial(sockNow, jid, joined); return; }
        if (intent.type === 'soap'           || wantsSoap(joined))          { await replySoap(sockNow, jid); return; }
        if (intent.type === 'brand')                                           { await replyBrand(sockNow, jid, intent.data.name); return; }

        let isNewTopicForAI = ctx.shouldGreet;
        if (ctx.shouldGreet && RULE_GREETING_ON && nameUtils && typeof nameUtils.buildRuleGreeting === 'function') {
          const first = (nameUtils.pickDisplayName && nameUtils.pickDisplayName(rawName)) || '';
          const greetMsg = nameUtils.buildRuleGreeting(first);
          markGreeted(jid); safeEnqueue(sockNow, jid, greetMsg); isNewTopicForAI = false;
        } else if (ctx.shouldGreet && GREET_TEXT) {
          markGreeted(jid); safeEnqueue(sockNow, jid, GREET_TEXT); isNewTopicForAI = false;
        }

        const rawOut = await askOpenAI({
          prompt: joined,
          userName: (nameUtils && nameUtils.pickDisplayName ? nameUtils.pickDisplayName(rawName) : rawName),
          isNewTopic: isNewTopicForAI
        });

        const out = await replaceCouponMarkers(rawOut);
        if (out && out.trim()) {
          safeEnqueue(sockNow, jid, out.trim());
          if (ctx.shouldGreet && !GREET_TEXT && !(RULE_GREETING_ON && nameUtils)) markGreeted(jid);
        }
        void hadMedia; void heuristics; void wantsProductTopic;
      });
    } catch (e) { console.error('[assistant] upsert error', e?.message || e); }
  };
}

function attachAssistant(appInstance) {
  if (!ASSISTANT_ENABLED) { console.log('[assistant] disabled (ASSISTANT_ENABLED!=1)'); return; }
  console.log('[assistant] enabled (rewire:', String(process.env.ASSISTANT_REWIRE_MODE || 'auto').toLowerCase(), ', interval:', Math.max(5000, Number(process.env.ASSISTANT_REWIRE_INTERVAL_MS || 15000)|0), ')');

  const getSock = () => (appInstance?.waAdmin?.getSock && appInstance.waAdmin.getSock()) || (appInstance?.whatsappClient?.sock);
  let currentSocketRef = null, upsertHandler = null, connHandler = null;

  const offSafe = (sock, event, handler) => { try { if (!sock?.ev || !handler) return; if (typeof sock.ev.off === 'function') sock.ev.off(event, handler); else if (typeof sock.ev.removeListener === 'function') sock.ev.removeListener(event, handler); } catch (_) {} };

  const wireToSock = (sock) => {
    if (!sock || !sock.ev || typeof sock.ev.on !== 'function') return false;
    if (currentSocketRef === sock && upsertHandler) return true;
    if (currentSocketRef) { offSafe(currentSocketRef, 'messages.upsert', upsertHandler); offSafe(currentSocketRef, 'connection.update', connHandler); }
    upsertHandler = buildUpsertHandler(getSock);
    connHandler = (ev) => { if (ev?.connection === 'open') setTimeout(() => ensureWired(), 200); };
    sock.ev.on('messages.upsert', upsertHandler);
    if (typeof sock.ev.on === 'function') { sock.ev.on('connection.update', connHandler); }
    currentSocketRef = sock;
    const sid = (sock?.user && (sock.user.id || sock.user.jid)) || (sock?.authState && sock.authState.creds?.me?.id) || 'unknown-sock';
    console.log('[assistant] wired to sock', sid);
    return true;
  };

  const ensureWired = () => { const sock = getSock(); if (!sock) return false; if (sock !== currentSocketRef) return wireToSock(sock); try { const hasOn = !!sock?.ev && typeof sock.ev.on === 'function'; const needRewire = !hasOn || !upsertHandler; if (needRewire) return wireToSock(sock); } catch (_) {} return true; };
  const mode = String(process.env.ASSISTANT_REWIRE_MODE || 'auto').toLowerCase();
  const interval = Math.max(5000, Number(process.env.ASSISTANT_REWIRE_INTERVAL_MS || 15000)|0);
  if (mode === 'auto') { ensureWired(); setInterval(() => { try { ensureWired(); } catch (_) {} }, interval); }
  else { const tryOnce = () => { const sock = getSock(); if (sock) wireToSock(sock); }; tryOnce(); setTimeout(tryOnce, 2000); }
}

module.exports = { attachAssistant };
```

---

## src/services/whatsapp-client.js

```js
const fs = require('fs');
const path = require('path');
const P = require('@whiskeysockets/baileys');
const sessionBackup = require('./session-backup');

const { makeWASocket, Browsers, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = P;

class WhatsAppClient {
  constructor() {
    this.sessionPath = process.env.WHATSAPP_SESSION_PATH || '/tmp/whatsapp-session';
    this.sock = null;
    this.isConnected = false;
    this.qrCodeGenerated = false;
    this.currentQRCode = null;
    this.currentPairingCode = null;
    this.user = null;
    this.currentRetry = 0;
    this.maxRetries = Number(process.env.WHATSAPP_RETRY_ATTEMPTS || 3);
    this.circuitBreaker = 'CLOSED';
  }

  async initialize() {
    fs.mkdirSync(this.sessionPath, { recursive: true });
    const probe = path.join(this.sessionPath, '.__rwtest');
    fs.writeFileSync(probe, String(Date.now()));
    fs.rmSync(probe, { force: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({ version, auth: state, browser: Browsers.appropriate('Chrome'), printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: true });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update = {}) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { this.currentQRCode = qr; this.qrCodeGenerated = true; }
      if (connection === 'open') {
        this.isConnected = true; this.user = this.sock?.user || null; this.currentRetry = 0; this.qrCodeGenerated = false; this.currentQRCode = null; this.currentPairingCode = null;
        if (process.env.SESSION_BACKUP === '1') { try { await sessionBackup.backupDir(this.sessionPath, 'on-connect'); } catch (_) {} }
      }
      if (connection === 'close') {
        this.isConnected = false; this.user = null;
        const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.code;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        if (shouldReconnect && this.currentRetry < this.maxRetries) { this.currentRetry++; setTimeout(() => this.initialize().catch(() => {}), 1500); }
      }
    });

    await this.tryPairingIfConfigured().catch(() => {});
  }

  async forceQRGeneration() {
    try {
      this.currentQRCode = null; this.qrCodeGenerated = false;
      if (!this.sock) await this.initialize();
      if (this.isConnected) return false;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 20 && !this.currentQRCode; i++) { await wait(300); }
      return !!this.currentQRCode;
    } catch { return false; }
  }

  getQRCode() { return this.currentQRCode || null; }
  getPairingCode() { return this.currentPairingCode || null; }

  async tryPairingIfConfigured() {
    const phone = (process.env.WHATSAPP_PHONE_NUMBER || '').trim();
    if (!phone) return false;
    try {
      if (!this.isConnected && this.sock?.requestPairingCode) {
        const code = await this.sock.requestPairingCode(phone);
        if (code) { this.currentPairingCode = code; this.currentQRCode = null; this.qrCodeGenerated = false; return true; }
      }
    } catch { /* se falhar, /qr continua funcionando */ }
    return false;
  }

  async clearSession() {
    try {
      if (this.sock?.end) { try { this.sock.end(); } catch {} }
      this.sock = null;
      fs.rmSync(this.sessionPath, { recursive: true, force: true });
      fs.mkdirSync(this.sessionPath, { recursive: true });
      this.isConnected = false; this.qrCodeGenerated = false; this.currentQRCode = null; this.currentPairingCode = null; this.user = null; this.currentRetry = 0;
    } catch (e) { console.error('clearSession error:', e?.message || e); }
  }

  // ========= GRUPOS =========
  async listGroups() {
    if (!this.sock) throw new Error('WhatsApp não inicializado');
    const map = await this.sock.groupFetchAllParticipating();
    const items = Object.values(map || {});
    const groups = items.map((g) => ({ jid: g.id, name: g.subject || g.name || 'Sem nome', participants: Array.isArray(g.participants) ? g.participants.length : (g.size || 0), isCommunity: !!g.community, announce: !!g.announce }));
    const seen = new Set();
    const unique = groups.filter((g) => (seen.has(g.jid) ? false : seen.add(g.jid)));
    unique.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    return unique;
  }

  async sendToGroup(jid, text) {
    if (!this.isConnected) throw new Error('WhatsApp não está conectado');
    if (!jid) throw new Error('jid do grupo não informado');
    await this.sock.sendMessage(jid, { text: String(text) });
  }

  // ========= Envio de imagem com legenda =========
  async sendImageMessage(jid, imagePath, caption, options = {}) {
    if (!this.isConnected) throw new Error('WhatsApp não está conectado');
    const buf = fs.readFileSync(imagePath);
    return this.sock.sendMessage(jid, { image: buf, caption: caption || '' }, options);
  }
}

module.exports = WhatsAppClient;
```

---

## src/services/session-backup.js (novo)

```js
// Cópia simples do diretório de sessão para uma pasta de backups, com retenção.
// Sem dependências externas.
const fs = require('fs');
const path = require('path');

const DEF_BASE = process.env.SESSION_BACKUP_PATH || path.join(process.cwd(), 'data', 'backups');
const KEEP = Math.max(1, Number(process.env.SESSION_BACKUP_KEEP || 3));

function ts(){ const d=new Date(); const p=(n)=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}` }

async function ensureDir(p){ await fs.promises.mkdir(p, { recursive: true }) }

async function copyRecursive(src, dst){
  const st = await fs.promises.stat(src);
  if (st.isDirectory()) {
    await ensureDir(dst);
    const list = await fs.promises.readdir(src);
    for (const name of list) { await copyRecursive(path.join(src, name), path.join(dst, name)); }
  } else if (st.isFile()) {
    await fs.promises.copyFile(src, dst);
  }
}

async function pruneOldBackups(base){
  try {
    const list = (await fs.promises.readdir(base)).filter(n=>n.startsWith('wa-session-')).sort();
    const excess = list.length - KEEP;
    for (let i=0; i<excess; i++) { const dir = path.join(base, list[i]); await fs.promises.rm(dir, { recursive: true, force: true }); }
  } catch (_) {}
}

async function backupDir(sessionDir, label='manual'){
  if (String(process.env.SESSION_BACKUP || '0') !== '1') return false;
  if (!sessionDir) return false;
  const base = DEF_BASE;
  await ensureDir(base);
  const dst = path.join(base, `wa-session-${label}-${ts()}`);
  await copyRecursive(sessionDir, dst);
  await pruneOldBackups(base);
  return dst;
}

module.exports = { backupDir };
```

---

## src/telemetry/metrics.js (novo)

```js
// Métricas simples (no-op + console). Pode ser trocado por Prometheus/Grafana depois.

function recordSorteioProcessado(status){ try { console.log('[metrics] sorteio_processado:', status); } catch(_){} }
function recordJobDuration(job, status, seconds){ try { console.log('[metrics] job_duration:', { job, status, seconds }); } catch(_){} }
function recordMessageSent(groupName, codigo){ try { console.log('[metrics] msg_sent:', { groupName, codigo }); } catch(_){} }
function recordMessageFailed(groupName, reason, codigo){ try { console.log('[metrics] msg_failed:', { groupName, reason, codigo }); } catch(_){} }

module.exports = { recordSorteioProcessado, recordJobDuration, recordMessageSent, recordMessageFailed };
```

---

## src/services/metrics.js (shim p/ compat)

```js
// Encaminha para telemetry/metrics, mantendo require('../services/metrics') compatível.
module.exports = require('../telemetry/metrics');
```

---

## src/lib/idempotency.js (novo)

```js
// Utilitário genérico de idempotência (chave + guarda)
const crypto = require('crypto');
const INSTANCE_ID = process.env.WA_INSTANCE_ID || 'default';

function makeKey(parts){
  const raw = Array.isArray(parts) ? parts.join('|') : String(parts||'');
  const base = `${INSTANCE_ID}:${raw}`;
  return crypto.createHash('sha1').update(base).digest('hex');
}

// Padrão de uso opcional
// withIdempotency({ key, check: async()=>bool, run: async()=>any, mark: async()=>void })
async function withIdempotency({ key, check, run, mark }){
  const exists = await (check?.(key));
  if (exists) return { skipped: true };
  const out = await (run?.());
  await (mark?.(key));
  return { skipped: false, result: out };
}

module.exports = { makeKey, withIdempotency };
```

---

## src/migrations/00X\_add\_instance\_id.sql (novo)

```sql
-- Índices e preparações para multi-instância e idempotência.
-- Colunas serão adicionadas por src/scripts/migrate.js (SQLite não tem IF NOT EXISTS em ADD COLUMN).

-- envios_whatsapp
CREATE INDEX IF NOT EXISTS idx_envios_idem ON envios_whatsapp(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_envios_instance ON envios_whatsapp(instance_id);

-- grupos_whatsapp
CREATE INDEX IF NOT EXISTS idx_grupos_instance ON grupos_whatsapp(instance_id);

-- sorteios_processados
CREATE INDEX IF NOT EXISTS idx_sorteios_instance ON sorteios_processados(instance_id);
```

---

## src/scripts/migrate.js (novo)

```js
#!/usr/bin/env node
// Executa migrações pontuais (adicionar colunas instance_id e índices)
const fs = require('fs');
const path = require('path');
const database = require('../config/database');

async function hasColumn(db, table, name){
  const rows = await db.all(`PRAGMA table_info('${table}')`);
  return rows.some(r => String(r.name) === String(name));
}

async function addColumnIfMissing(db, table, colDef){
  const [name] = colDef.split(/\s+/, 1);
  const exists = await hasColumn(db, table, name);
  if (!exists) { await db.run(`ALTER TABLE ${table} ADD COLUMN ${colDef}`); console.log(`[migrate] ${table}: coluna adicionada -> ${colDef}`); }
}

async function applySqlFile(db, file){
  const sql = fs.readFileSync(file, 'utf8');
  await db.run('BEGIN');
  try {
    await db.exec(sql);
    await db.run('COMMIT');
  } catch (e) {
    await db.run('ROLLBACK');
    throw e;
  }
}

(async () => {
  const db = await database.getConnection();

  // Colunas instance_id
  await addColumnIfMissing(db, 'grupos_whatsapp', "instance_id TEXT DEFAULT 'default'");
  await addColumnIfMissing(db, 'envios_whatsapp', "instance_id TEXT DEFAULT 'default'");
  await addColumnIfMissing(db, 'sorteios_processados', "instance_id TEXT DEFAULT 'default'");

  // Arquivo SQL (índices)
  const mig = path.join(__dirname, '..', 'migrations', '00X_add_instance_id.sql');
  if (fs.existsSync(mig)) { await applySqlFile(db, mig); console.log('[migrate] índices aplicados'); }

  console.log('✅ Migração concluída.');
  process.exit(0);
})().catch((e)=>{ console.error('❌ Migração falhou:', e); process.exit(1); });
```

---

## src/services/instance-registry.js (sem mudanças funcionais — mantendo)

```js
// whatsapp-automation/src/services/instance-registry.js
// Fonte: ENV WA_INSTANCE_IDS ou arquivo JSON (opcional).

const fs = require('fs');
const path = require('path');

const FILE_CANDIDATES = [
  path.resolve('/data/wa-instances.json'),
  path.resolve(process.cwd(), 'data', 'wa-instances.json'),
];

let cache = [];
let lastSource = 'env';

function parseFromEnv() {
  const csv = (process.env.WA_INSTANCE_IDS || '').trim();
  if (!csv) return [];
  return csv
    .split(',')
    .map((raw, i) => {
      const id = raw.trim();
      return id ? { id, label: i === 0 ? 'Celular 1' : `whatsapp ${i + 1}`, enabled: true } : null;
    })
    .filter(Boolean);
}

function readJsonIfExists(file) {
  try {
    if (fs.existsSync(file)) {
      const txt = fs.readFileSync(file, 'utf8');
      const arr = JSON.parse(txt);
      if (Array.isArray(arr)) return arr;
    }
  } catch (_) {}
  return null;
}

function load() {
  const fromEnv = parseFromEnv();
  if (fromEnv.length > 0) { cache = fromEnv; lastSource = 'env'; return; }
  for (const f of FILE_CANDIDATES) {
    const arr = readJsonIfExists(f);
    if (arr && arr.length) { cache = arr; lastSource = f; return; }
  }
  cache = []; lastSource = 'none';
}

function listInstances() { if (!cache.length) load(); return cache.slice(); }
function getInstance(id) { if (!cache.length) load(); return cache.find(x => x.id === id) || null; }
function addInstance(obj){ if (!cache.length) load(); if(!cache.some(x=>x.id===obj.id)) cache.push({ ...obj, enabled: obj.enabled !== false }); return listInstances(); }
function removeInstance(id){ if (!cache.length) load(); cache = cache.filter(x=>x.id!==id); return listInstances(); }
function reload(){ cache = []; load(); return listInstances(); }

load();

module.exports = { listInstances, getInstance, addInstance, removeInstance, reload, _lastSource: () => lastSource };
```

---

## src/services/socket-watcher.js (sem mudanças — mantendo)

```js
// src/services/socket-watcher.js
const DEF = {
  intervalMs: Number(process.env.WA_WATCHER_INTERVAL_MS || 2500),
  adminReconnect: String(process.env.WA_WATCHER_ADMIN_RECONNECT || '1') === '1',
  reconnectCooldownMs: Number(process.env.WA_WATCHER_RECONNECT_COOLDOWN_MS || 30000),
};

function startSocketWatcher(appInstance) {
  if (!appInstance) { console.warn('[socket-watcher] appInstance ausente – ignorando.'); return { stop() {} }; }
  const baseUrl = process.env.WA_SELF_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
  let lastSock = null; let lastReconnectAt = 0;
  const getSock = () => { try { if (appInstance.waAdmin?.getSock) { const s = appInstance.waAdmin.getSock(); if (s) return s; } if (appInstance.whatsappClient?.sock) { return appInstance.whatsappClient.sock; } } catch (_) {} return null };
  const softAdminReconnect = async () => { if (!DEF.adminReconnect) return; const now = Date.now(); if (now - lastReconnectAt < DEF.reconnectCooldownMs) return; lastReconnectAt = now; try { await fetch(`${baseUrl}/admin/wa/connect`, { method: 'POST' }); console.log('[socket-watcher] POST /admin/wa/connect disparado (soft).'); } catch (e) { console.warn('[socket-watcher] falha ao chamar /admin/wa/connect:', e?.message || e); } };
  const wireSockListeners = (sock) => { try { if (!sock?.ev || typeof sock.ev.on !== 'function') return; const FLAG='__sw_attached'; if (sock[FLAG]) return; sock[FLAG]=true; sock.ev.on('connection.update', (u) => { const err=u?.lastDisconnect?.error; const status= err?.output?.statusCode || err?.statusCode || err?.reason?.statusCode || err?.data?.status || null; if (status) { console.log('[socket-watcher] lastDisconnect status =', status); if ([401,428,503,515].includes(Number(status))) { softAdminReconnect(); } } }); } catch (e) { console.warn('[socket-watcher] wireSockListeners erro:', e?.message || e); } };
  const rewireAssistant = () => { try { const mod = require('../modules/assistant-bot'); if (typeof mod.attachAssistant === 'function') { mod.attachAssistant(appInstance); console.log('[socket-watcher] attachAssistant() chamado novamente (rewire).'); } } catch (_) {} };
  const timer = setInterval(() => { try { const s = getSock(); if (!s) return; if (s !== lastSock) { lastSock = s; console.log('[socket-watcher] novo socket detectado – preparando listeners.'); wireSockListeners(s); rewireAssistant(); } } catch (e) { console.warn('[socket-watcher] loop erro:', e?.message || e); } }, DEF.intervalMs);
  console.log('[socket-watcher] iniciado (intervalo =', DEF.intervalMs, 'ms).');
  return { stop() { clearInterval(timer); } };
}

module.exports = { startSocketWatcher };
```

---

## src/services/wa-multi.js (sem mudanças — mantendo)

```js
// src/services/wa-multi.js
const fs = require('fs');
const path = require('path');

const SESSION_BASE = process.env.WA_SESSION_BASE || '/data/wa-sessions';
const LABELS_FILE = process.env.WA_LABELS_FILE || path.join(SESSION_BASE, '..', 'wa-instance-labels.json');

function getEnvInstanceIds(){ const raw=String(process.env.WA_INSTANCE_IDS||'').trim(); if(!raw) return []; return raw.split(',').map(s=>s.trim()).filter(Boolean); }
function readLabels(){ try{ return JSON.parse(fs.readFileSync(LABELS_FILE,'utf8')); }catch{ return {}; } }
function writeLabels(obj){ try{ fs.mkdirSync(path.dirname(LABELS_FILE), { recursive: true }); }catch{} fs.writeFileSync(LABELS_FILE, JSON.stringify(obj,null,2)); }
function listInstances(){ try{ const reg=require('./instance-registry'); if(typeof reg.listInstances==='function'){ const arr=reg.listInstances()||[]; if(arr.length) return arr.map(i=>({ id:i.id, label:i.label||i.id })); } }catch(_){} const ids=getEnvInstanceIds(); const labels=readLabels(); return ids.map((id,idx)=>({ id, label: labels[id] || (idx===0?'Celular 1':`whatsapp ${idx+1}`) })); }
function sessionPathFor(id){ const clean=String(id||'').trim(); if(!clean) return null; return path.join(SESSION_BASE, clean); }
function hasSavedSession(id){ const dir=sessionPathFor(id); if(!dir) return { ok:false, dir:null, files:0 }; try{ const files=fs.readdirSync(dir); const ok=files.some(f=>/creds|app-state-sync|pre-key|sender-key/i.test(f)); return { ok, dir, files: files.length }; }catch{ return { ok:false, dir, files:0 }; } }
function clearSession(id){ const dir=sessionPathFor(id); if(!dir) return false; try{ fs.rmSync(dir,{recursive:true,force:true}); fs.mkdirSync(dir,{recursive:true}); return true; }catch{ return false; } }
function setLabel(id,label){ const labels=readLabels(); labels[String(id)] = String(label||'').trim() || String(id); writeLabels(labels); return labels[String(id)]; }

module.exports = { SESSION_BASE, LABELS_FILE, getEnvInstanceIds, readLabels, writeLabels, listInstances, sessionPathFor, hasSavedSession, clearSession, setLabel };
```

---

## EVs novas (para cadastrar agora)

```ini
# ====== Postagem direcionada (sobrescreve grupos do banco) ======
# Aceita JIDs ou números (com DDI), separados por vírgula, espaço ou ponto-e-vírgula.
# Ex.: "5548999999999, 5548888888888" ou "5548999999999@s.whatsapp.net"
WA_POST_TO=

# ====== Backup automático da sessão WhatsApp ======
# 1 = ligado, 0 = desligado. Se ligado, faz cópia em: SESSION_BACKUP_PATH (padrão: ./data/backups)
SESSION_BACKUP=1
# Caminho base dos backups (opcional)
SESSION_BACKUP_PATH=./data/backups
# Quantidade de cópias a manter (opcional)
SESSION_BACKUP_KEEP=5

# ====== Limite de mensagens enfileiradas pelo atendente (opcional) ======
# Máximo de mensagens que o bot tentará enfileirar por conversa/jid a cada interação.
# 0 = sem limite (comportamento atual)
ASSISTANT_QUEUE_CAP=3

# ====== Identificador lógico da instância (multi-conta) ======
# Usado nas tabelas para segregar dados.
WA_INSTANCE_ID=default
```

---

## Como aplicar

```bash
# 1) Rodar migração
node src/scripts/migrate.js

# 2) (opcional) Ativar backup de sessão
export SESSION_BACKUP=1

# 3) Subir a app
node src/app.js
```
