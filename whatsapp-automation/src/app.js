// src/app.js

// ======================= WebCrypto SHIM (antes de qualquer import do Baileys) =======================
try {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    const { webcrypto } = require('crypto');
    globalThis.crypto = webcrypto;
  }
} catch (_) {
  // silencioso
}
// ===================================================================================================

const path = require('path');
const fs = require('fs/promises');
const express = require('express');
const morgan = require('morgan');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

const WhatsAppClient = require('./services/whatsapp-client');
const settings = require('./services/settings');
const { runOnce } = require('./jobs/post-winner');

// SSE hub (novo, não-intrusivo)
const { addClient: sseAddClient, broadcast: sseBroadcast } = require('./services/wa-sse');

const PORT = process.env.PORT || 3000;

// util: interpreta booleanos em env
function envOn(v, def = false) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return def;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

class App {
  constructor() {
    this.app = express();
    this.whatsappClient = null;
    this.waAdmin = null; // <<< referência ao admin bundle
    this.isFallbackEnabled =
      envOn(process.env.WA_CLIENT_AUTOSTART, false) || // recomendado
      envOn(process.env.WA_FALLBACK_ENABLED, false);   // alias opcional

    const limiter = rateLimit({
      windowMs: 60 * 1000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
      validate: false
    });

    this.app.use(limiter);
    this.app.use(morgan('dev'));
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    this.app.use(express.static(path.join(__dirname, '../public')));

    const tp = process.env.TRUST_PROXY === '1' ? 1 : false;
    this.app.set('trust proxy', tp);

    // === PAINEL ADMIN (WhatsApp) ===
    try {
      const waAdmin = require('../admin-wa-bundle.js'); // arquivo na raiz do repo
      this.waAdmin = waAdmin;                            // <<< guardamos para usar nas rotas /api
      this.app.locals.waAdmin = waAdmin;                // <<< acessível para jobs/rotas
      this.app.use('/admin', waAdmin);                  // monta em /admin (rotas existentes mantidas)
    } catch (e) {
      console.warn('⚠️ Admin bundle indisponível:', e?.message || e);
    }
    // === fim do bloco ===

    this.routes();
  }

  // cria o cliente interno APENAS se fallback estiver habilitado
  initWhatsApp() {
    if (!this.isFallbackEnabled) return null;
    if (!this.whatsappClient) {
      this.whatsappClient = new WhatsAppClient();
      this.app.locals.whatsappClient = this.whatsappClient;
      this.whatsappClient.initialize().catch((e) => {
        console.error('❌ Falha inicial ao iniciar WhatsApp (fallback):', e?.message || e);
      });
    }
    return this.whatsappClient;
  }

  // obtém o cliente interno sem criar (a não ser que create=true e fallback esteja habilitado)
  getClient({ create = false } = {}) {
    if (this.whatsappClient) return this.whatsappClient;
    if (create) return this.initWhatsApp();
    return null;
  }

  async waitForWAConnected(wa, timeoutMs = 8000) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const start = Date.now();
    while ((!wa?.isConnected || !wa?.sock) && Date.now() - start < timeoutMs) {
      await wait(250);
    }
    return !!(wa?.isConnected && wa?.sock);
  }

  // pega status consolidado (prioriza admin), sem quebrar campos existentes
  async consolidatedStatus() {
    // 1) tentar admin
    try {
      if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') {
        const st = await this.waAdmin.getStatus();
        if (st && typeof st === 'object') {
          return {
            ok: true,
            connected: !!st.connected,
            connecting: !!st.connecting,
            hasSock: !!st.hasSock,
            msisdn: st.msisdn || null,

            // compat com clientes antigos:
            isConnected: !!st.connected,
            qrCodeGenerated: !!st.qr,
            currentRetry: 0,
            maxRetries: 3,
            circuitBreakerState: 'CLOSED',
            failureCount: 0,
            queueLength: 0,
            user: st.user || null
          };
        }
      }
    } catch (_) {}

    // 2) fallback (somente se estiver habilitado E já existir/for permitido criar)
    if (this.isFallbackEnabled) {
      const wa = this.getClient({ create: false }); // não criar só por status
      if (wa) {
        const user = wa.user || null;
        const msisdn = (function (u) {
          try {
            const raw = String(u?.id || '')
              .replace('@s.whatsapp.net', '')
              .replace(/^55/, '');
            const m = /(\d{2})(\d{4,5})(\d{4})/.exec(raw);
            if (m) return `${m[1]} ${m[2]}-${m[3]}`;
          } catch (_) {}
          return null;
        })(user);

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
        };
      }
    }

    // sem admin e sem fallback ativo -> status "desligado"
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
    };
  }

  routes() {
    // Health
    this.app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

    // =========================
    //   STATUS (compat + msisdn)
    // =========================
    this.app.get('/api/whatsapp/status', async (_req, res) => {
      try {
        const st = await this.consolidatedStatus();
        return res.json(st);
      } catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
      }
    });

    // Status detalhado (mantido) — não cria fallback se desabilitado
    this.app.get('/api/whatsapp/session-status', (req, res) => {
      const wa = this.getClient({ create: false });
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
      });
    });

    // ======================================================
    //   SSE (novo): atualiza UI sem F5 após parear/desparear
    // ======================================================
    this.app.get('/api/whatsapp/stream', async (req, res) => {
      const inst = (req.query.inst || 'default').toString();
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      sseAddClient(inst, res);

      // empurra estado inicial
      try {
        const s = await this.consolidatedStatus();
        res.write(`event: status\ndata: ${JSON.stringify(s)}\n\n`);
      } catch (_) {}
    });

    // =====================================================================
    //   DISCONNECT (opcional): proxy para desconectar e limpar a sessão
    //   -> NÃO substitui /admin/wa/reset (apenas complemento)
    // =====================================================================
    this.app.post('/api/whatsapp/disconnect', async (_req, res) => {
      try {
        // tenta usar admin (se exportar disconnect)
        if (this.waAdmin?.disconnect) {
          await this.waAdmin.disconnect();
        }
        // limpeza do diretório de sessão — cobre os dois nomes + fallbacks
        const dirCandidates = [
          process.env.WA_SESSION_PATH,
          process.env.WHATSAPP_SESSION_PATH,
          path.join(process.cwd(), 'data', 'baileys'),
          path.join(process.cwd(), 'data', 'whatsapp-session'),
        ].filter(Boolean);
        for (const d of dirCandidates) {
          try { await fs.rm(d, { recursive: true, force: true }); } catch {}
        }

        // avisa front via SSE
        sseBroadcast('default', { type: 'status', payload: { ok: true, connected: false, connecting: false, hasSock: false } });
        return res.json({ ok: true });
      } catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
      }
    });

    // =========================
    //   RESET (mantido) — depende de fallback
    // =========================
    this.app.get('/api/reset-whatsapp', async (req, res) => {
      if (!this.isFallbackEnabled) return res.status(503).json({ success: false, error: 'Fallback desabilitado (WA_CLIENT_AUTOSTART=0).' });
      const wa = this.initWhatsApp();
      try {
        await wa.clearSession();
        await wa.initialize();
        const ok = await wa.forceQRGeneration();
        return res.json({
          success: true,
          message: ok
            ? 'WhatsApp resetado com sucesso! Acesse /qr para escanear novo código.'
            : 'WhatsApp resetado. Aguarde alguns segundos e tente /qr novamente.',
          timestamp: new Date().toISOString(),
          action: ok ? 'qr_ready' : 'qr_pending'
        });
      } catch (e) {
        console.error('❌ reset-whatsapp:', e);
        return res.status(500).json({ success: false, error: e?.message || String(e) });
      }
    });

    // Força QR (mantido) — depende de fallback
    this.app.get('/api/force-qr', async (req, res) => {
      if (!this.isFallbackEnabled) return res.status(503).json({ success: false, error: 'Fallback desabilitado (WA_CLIENT_AUTOSTART=0).' });
      const wa = this.initWhatsApp();
      try {
        const ok = await wa.forceQRGeneration();
        if (ok) {
          return res.json({ success: true, message: 'QR preparado. Acesse /qr.', qrAvailable: true, timestamp: new Date().toISOString() });
        }
        return res.json({ success: false, message: 'Falha ao gerar QR Code. Tente novamente.', qrAvailable: false, timestamp: new Date().toISOString() });
      } catch (e) {
        console.error('❌ force-qr:', e);
        return res.status(500).json({ success: false, error: e?.message || String(e) });
      }
    });

    // QR SVG (mantido) — depende de fallback
    this.app.get('/qr', async (req, res) => {
      if (!this.isFallbackEnabled) return res.status(503).json({ error: 'Fallback desabilitado (WA_CLIENT_AUTOSTART=0).' });
      const wa = this.initWhatsApp();
      try {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        let tries = 0;
        while (!wa.getQRCode() && tries < 20) { await wait(300); tries++; }
        const qr = wa.getQRCode();
        if (!qr) return res.status(404).json({ error: 'QR Code não disponível', message: 'WhatsApp pode já estar conectado ou aguardando conexão' });
        const svg = await QRCode.toString(qr, { type: 'svg', margin: 1, width: 300 });
        res.set('Content-Type', 'image/svg+xml').send(svg);
      } catch (e) {
        console.error('❌ /qr:', e);
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // Pairing code (mantido) — depende de fallback
    this.app.get('/code', (req, res) => {
      if (!this.isFallbackEnabled) return res.status(503).json({ error: 'Fallback desabilitado (WA_CLIENT_AUTOSTART=0).' });
      const wa = this.initWhatsApp();
      const code = wa.getPairingCode();
      if (!code) return res.status(404).json({ error: 'Pairing code não disponível' });
      return res.json({ pairingCode: code });
    });

    // ==========================
    //     ROTAS PARA GRUPOS
    // ==========================
    this.app.get('/admin/groups', (_req, res) => {
      res.sendFile(path.join(__dirname, '../public/admin/groups.html'));
    });

    // SINCRONIZAÇÃO — prioriza o socket do ADMIN (mantido)
    this.app.get('/api/groups/sync', async (_req, res) => {
      try {
        // 1) admin bundle
        if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') {
          const st = await this.waAdmin.getStatus();
          if (st.connected) {
            const sock = this.waAdmin.getSock();
            const mp = await sock.groupFetchAllParticipating();
            const groups = Object.values(mp).map(g => ({
              jid: g.id,
              name: g.subject,
              participants: g.participants?.length ?? g.size ?? 0,
              announce: !!g.announce
            }));
            const saved = settings.set({ groups, lastSyncAt: new Date().toISOString() });
            return res.json({ ok: true, groups, saved });
          }
        }

        // 2) fallback (opcional)
        if (this.isFallbackEnabled) {
          const wa = this.initWhatsApp();
          const okConn = await this.waitForWAConnected(wa, 8000);
          if (!okConn) {
            return res.status(503).json({ ok: false, error: 'WhatsApp ainda conectando… tente novamente em alguns segundos.' });
          }
          const groups = await wa.listGroups();
          const saved = settings.set({ groups, lastSyncAt: new Date().toISOString() });
          return res.json({ ok: true, groups, saved });
        }

        return res.status(503).json({ ok: false, error: 'Sem sessão disponível (admin desconectado e fallback desabilitado).' });
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
      }
    });

    this.app.get('/api/groups', (_req, res) => {
      res.json({ ok: true, settings: settings.get() });
    });

    // aceita lista vazia (limpa seleção)
    this.app.post('/api/groups/select', (req, res) => {
      try {
        const { resultGroupJid, postGroupJids } = req.body || {};
        let list = Array.isArray(postGroupJids) ? postGroupJids : [];
        if (!list.length && resultGroupJid) list = [String(resultGroupJid)];
        list = Array.from(new Set(list.map(s => String(s).trim()).filter(Boolean)));

        const out = settings.setPostGroups(list);
        res.json({ ok: true, settings: out, cleared: list.length === 0 });
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
      }
    });

    this.app.post('/api/groups/test-post', async (_req, res) => {
      try {
        const st = settings.get();
        const targets = (Array.isArray(st.postGroupJids) && st.postGroupJids.length)
          ? st.postGroupJids
          : (st.resultGroupJid ? [st.resultGroupJid] : []);
        if (!targets.length) {
          return res.status(400).json({ ok: false, error: 'Nenhum grupo selecionado' });
        }

        // 1) Preferir a sessão conectada via /admin/whatsapp
        if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') {
          const adminSt = await this.waAdmin.getStatus();
          if (adminSt.connected) {
            const sock = this.waAdmin.getSock();
            for (const jid of targets) {
              await sock.sendMessage(jid, { text: '🔔 Teste de postagem de sorteio (ok)' });
            }
            return res.json({ ok: true, sentTo: targets.length, via: 'admin' });
          }
        }

        // 2) Fallback: cliente interno (apenas se habilitado)
        if (!this.isFallbackEnabled) {
          return res.status(503).json({ ok: false, error: 'Sem sessão disponível (admin desconectado e fallback desabilitado).' });
        }
        const wa = this.initWhatsApp();
        if (!wa.isConnected) {
          return res.status(400).json({ ok: false, error: 'WhatsApp (fallback) não conectado' });
        }
        for (const jid of targets) {
          await wa.sendToGroup(jid, '🔔 Teste de postagem de sorteio (ok)');
        }
        res.json({ ok: true, sentTo: targets.length, via: 'client' });
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
      }
    });

    // ====== VÍDEO TESTE VIA CREATOMATE (mantido) ======
    this.app.post('/api/posts/test-video', async (_req, res) => {
      try {
        const st = settings.get();
        const targets = (Array.isArray(st.postGroupJids) && st.postGroupJids.length)
          ? st.postGroupJids
          : (st.resultGroupJid ? [st.resultGroupJid] : []);
        if (!targets.length) return res.status(400).json({ ok:false, error:'Nenhum grupo selecionado' });

        const { makeCreatomateVideo } = require('./services/creatomate');
        const fs = require('fs');

        const videoPath = await makeCreatomateVideo({
          headline: '🎉 Resultado do Sorteio',
          premio: 'Produto de Teste',
          winner: 'Fulano de Tal',
          productImageUrl: 'https://picsum.photos/1080'
        });

        let sock = null;
        if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') {
          const stAdmin = await this.waAdmin.getStatus();
          if (stAdmin.connected) sock = this.waAdmin.getSock();
        }
        if (!sock) {
          if (!this.isFallbackEnabled) {
            return res.status(503).json({ ok:false, error:'Sem sessão disponível (admin desconectado e fallback desabilitado).' });
          }
          const wa = this.initWhatsApp();
          sock = wa?.sock || null;
        }
        if (!sock) return res.status(400).json({ ok:false, error:'WhatsApp não conectado' });

        for (const jid of targets) {
          await sock.sendMessage(jid, { video: fs.createReadStream(videoPath), caption: '🔔 Teste de vídeo (Creatomate)' });
        }
        res.json({ ok:true, sentTo: targets.length, path: videoPath });
      } catch (e) {
        res.status(500).json({ ok:false, error: e?.message || String(e) });
      }
    });

    // ========= job manual =========
    this.app.post('/api/jobs/run-once', async (req, res) => {
      try {
        const dry = ['1','true','yes'].includes(String(req.query.dry || '').toLowerCase());

        // roda só se existir sessão (admin OU fallback habilitado & conectado)
        let canRun = false;

        try {
          if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') {
            const st = await this.waAdmin.getStatus();
            canRun = !!st.connected;
          }
        } catch (_) {}

        if (!canRun && this.isFallbackEnabled) {
          const wa = this.getClient({ create: false });
          canRun = !!(wa?.isConnected);
        }

        if (!canRun) {
          return res.status(503).json({ ok:false, error:'Sem sessão conectada para executar o job.' });
        }

        const out = await runOnce(this.app, { dryRun: dry });
        res.json(out);
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
      }
    });

    // ========= diagnóstico admin vs client =========
    this.app.get('/debug/wa', async (_req, res) => {
      let admin = { available: false };
      try {
        if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') {
          const st = await this.waAdmin.getStatus();
          admin = { available: true, connected: !!st.connected, connecting: !!st.connecting, hasSock: !!this.waAdmin.getSock?.() };
        }
      } catch (e) {
        admin = { available: true, error: e?.message || String(e) };
      }

      const wa = this.getClient({ create: false });

      res.json({
        admin,
        client: {
          enabled: this.isFallbackEnabled,
          initialized: !!wa?.sock,
          connected: !!wa?.isConnected,
          user: wa?.user || null
        },
        selectedGroups: settings.get()?.postGroupJids || (settings.get()?.resultGroupJid ? [settings.get().resultGroupJid] : []),
        ts: new Date().toISOString()
      });
    });
  }

  listen() {
    // <<< IMPORTANTE: não inicia o cliente interno por padrão
    if (this.isFallbackEnabled) {
      this.initWhatsApp();
    }

    // Cron: roda só se houver sessão conectada
    cron.schedule('*/1 * * * *', async () => {
      try {
        let canRun = false;

        try {
          if (this.waAdmin && typeof this.waAdmin.getStatus === 'function') {
            const st = await this.waAdmin.getStatus();
            canRun = !!st.connected;
          }
        } catch (_) {}

        if (!canRun && this.isFallbackEnabled) {
          const wa = this.getClient({ create: false });
          canRun = !!(wa?.isConnected);
        }

        if (canRun) {
          await runOnce(this.app);
        }
      } catch (e) {
        console.error('cron runOnce error:', e?.message || e);
      }
    });

    this.app.listen(PORT, () => {
      console.log(`🚀 Server listening on :${PORT}  |  Fallback enabled: ${this.isFallbackEnabled ? 'yes' : 'no'}`);
    });
  }
}

new App().listen();
