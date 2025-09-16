// src/app.js

// ======================= WebCrypto SHIM (antes de qualquer import do Baileys) =======================
try {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    const { webcrypto } = require('crypto')
    globalThis.crypto = webcrypto
  }
} catch (_) {
  // silencioso
}
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
const { runOnce } = require('./jobs/post-winner')
const { runOnce: runPromoOnce } = require('./jobs/post-promo') // << NOVO
const promoSchedule = require('./services/promo-schedule')     // << NOVO

// SSE hub
const { addClient: sseAddClient, broadcast: sseBroadcast } = require('./services/wa-sse')

// === Atendente (opcional) – carregamento tolerante ===
let attachAssistant = null
try {
  ({ attachAssistant } = require('./modules/assistant-bot'))
} catch (_) {
  // módulo ainda não criado/implantado – ignorar sem quebrar outros serviços
}

const PORT = process.env.PORT || 3000

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
    .split(/[,\s;]+/)                 // vírgula, espaço ou ponto-e-vírgula
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
    this.isFallbackEnabled =
      envOn(process.env.WA_CLIENT_AUTOSTART, false) ||
      envOn(process.env.WA_FALLBACK_ENABLED, false)

    // ======= CONFIG DE ALERTA (via WhatsApp) =======
    const alertJidsMerged = [
      ...parsePhonesToJids(process.env.ALERT_WA_PHONES), // lista (novo)
      ...parsePhonesToJids(process.env.ALERT_WA_PHONE),  // 1 número (compat)
      ...parsePhonesToJids(process.env.ALERT_WA_JIDS),   // lista de JIDs (opcional)
      ...parsePhonesToJids(process.env.ALERT_WA_JID),    // 1 JID (compat)
    ]
    const uniqJids = [...new Set(alertJidsMerged)]

    this.alertCfg = {
      adminJids: uniqJids,                                         // agora é lista
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
    this.app.use(express.urlencoded({ extended: true }))
    this.app.use(express.static(path.join(__dirname, '../public')))

    const tp = process.env.TRUST_PROXY === '1' ? 1 : false
    this.app.set('trust proxy', tp)

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
          message: ok
            ? 'WhatsApp resetado com sucesso! Acesse /qr para escanear novo código.'
            : 'WhatsApp resetado. Aguarde alguns segundos e tente /qr novamente.',
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
            const groups = Object.values(mp).map(g => ({
              jid: g.id,
              name: g.subject,
              participants: g.participants?.length ?? g.size ?? 0,
              announce: !!g.announce
            }))
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
        list = Array.from(new Set(list.map(s => String(s).trim()).filter(Boolean)))
        const out = settings.setPostGroups(list)
        res.json({ ok: true, settings: out, cleared: list.length === 0 })
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) })
      }
    })

    this.app.post('/api/groups/test-post', async (_req, res) => {
      try {
        const st = settings.get()
        const targets = (Array.isArray(st.postGroupJids) && st.postGroupJids.length)
          ? st.postGroupJids
          : (st.resultGroupJid ? [st.resultGroupJid] : [])
        if (!targets.length) {
          return res.status(400).json({ ok: false, error: 'Nenhum grupo selecionado' })
        }

        if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') {
          const adminSt = await this.waAdmin.getStatus()
          if (adminSt.connected) {
            const sock = this.waAdmin.getSock()
            for (const jid of targets) {
              await sock.sendMessage(jid, { text: '🔔 Teste de postagem de sorteio (ok)' })
            }
            return res.json({ ok: true, sentTo: targets.length, via: 'admin' })
          }
        }

        if (!this.isFallbackEnabled) {
          return res.status(503).json({ ok: false, error: 'Sem sessão disponível (admin desconectado e fallback desabilitado).' })
        }
        const wa = this.initWhatsApp()
        if (!wa.isConnected) {
          return res.status(400).json({ ok: false, error: 'WhatsApp (fallback) não conectado' })
        }
        for (const jid of targets) {
          await wa.sendToGroup(jid, '🔔 Teste de postagem de sorteio (ok)')
        }
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

    // ===== PROMO SCHEDULE (lista/cancelar) — leve e isolado =====
    this.app.get('/api/promo/schedule', async (_req, res) => {
      try {
        const items = await promoSchedule.listScheduled()
        res.json({ ok: true, items })
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) })
      }
    })

    this.app.post('/api/promo/cancel', async (req, res) => {
      try {
        const { row, which } = req.body || {}
        const out = await promoSchedule.cancelScheduled(row, which)
        res.json({ ok: true, result: out })
      } catch (e) {
        res.status(400).json({ ok: false, error: e?.message || String(e) })
      }
    })

    // job manual (POST)
    this.app.post('/api/jobs/run-once', async (req, res) => {
      try {
        const dry = ['1','true','yes'].includes(String(req.query.dry || '').toLowerCase())
        let canRun = false

        try {
          if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') {
            const st = await this.waAdmin.getStatus()
            canRun = !!st.connected
          }
        } catch (_) {}

        if (!canRun && this.isFallbackEnabled) {
          const wa = this.getClient({ create: false })
          canRun = !!(wa?.isConnected)
        }

        if (!canRun) {
          return res.status(503).json({ ok:false, error:'Sem sessão conectada para executar o job.' })
        }

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

        try {
          if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') {
            const st = await this.waAdmin.getStatus()
            canRun = !!st.connected
          }
        } catch (_) {}

        if (!canRun && this.isFallbackEnabled) {
          const wa = this.getClient({ create: false })
          canRun = !!(wa?.isConnected)
        }

        if (!canRun) {
          return res.status(503).json({ ok:false, error:'Sem sessão conectada para executar o job.' })
        }

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
        client: {
          enabled: this.isFallbackEnabled,
          initialized: !!wa?.sock,
          connected: !!wa?.isConnected,
          user: wa?.user || null
        },
        sessionDir: sess.dir,
        sessionFiles: sess.files,
        selectedGroups: cfg?.postGroupJids || (cfg?.resultGroupJid ? [cfg.resultGroupJid] : []),
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
      this.initWhatsApp()
    }

    // ---- Atendente (liga listener se módulo existir e estiver habilitado por env) ----
    try {
      if (typeof attachAssistant === 'function') attachAssistant(this)
    } catch (e) {
      console.warn('[assistant] attach skipped:', e?.message || e)
    }

    // === AUTOSTART do ADMIN via HTTP ===
    const wantAutoStart = envOn(process.env.WA_ADMIN_AUTOSTART, true)
    const autoStartDelay = Number(process.env.WA_AUTOSTART_DELAY_MS || 1500)
    const baseUrl = process.env.WA_SELF_BASE_URL || `http://127.0.0.1:${PORT}`

    if (wantAutoStart) {
      setTimeout(async () => {
        try {
          const st = await this.callAdminStatus(baseUrl)
          if (!st.ok) {
            console.log(`[WA-ADMIN] autostart: status indisponível (${st.status || st.error || 'erro'})`)
            return
          }
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
    } catch (e) {
      console.warn('[socket-watcher] não iniciado:', e?.message || e)
    }

    // Cron: só roda se houver sessão conectada (POST WINNER)
    cron.schedule('*/1 * * * *', async () => {
      try {
        let canRun = false

        try {
          if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') {
            const st = await this.waAdmin.getStatus()
            canRun = !!st.connected
          }
        } catch (_) {}

        if (!canRun && this.isFallbackEnabled) {
          const wa = this.getClient({ create: false })
          canRun = !!(wa?.isConnected)
        }

        if (canRun) {
          await runOnce(this.app)
        }
      } catch (e) {
        console.error('cron runOnce error:', e?.message || e)
      }
    })

    // Cron: Divulgação 48h antes e no dia (09:00) — usa ENV PROMO_CRON ou padrão */10
    const promoCron = process.env.PROMO_CRON || '*/10 * * * *'
    cron.schedule(promoCron, async () => {
      try {
        let canRun = false
        try {
          if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') {
            const st = await this.waAdmin.getStatus()
            canRun = !!st.connected
          }
        } catch (_) {}

        if (!canRun && this.isFallbackEnabled) {
          const wa = this.getClient({ create: false })
          canRun = !!(wa?.isConnected)
        }

        if (canRun) {
          await runPromoOnce(this.app)
        }
      } catch (e) {
        console.error('[promo] cron error:', e?.message || e)
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

new App().listen()
