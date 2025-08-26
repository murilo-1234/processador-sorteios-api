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
const express = require('express');
const morgan = require('morgan');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

const WhatsAppClient = require('./services/whatsapp-client');
const settings = require('./services/settings');
const { runOnce } = require('./jobs/post-winner');

const PORT = process.env.PORT || 3000;

class App {
  constructor() {
    this.app = express();
    this.whatsappClient = null;

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

    this.routes();
  }

  initWhatsApp() {
    if (!this.whatsappClient) {
      this.whatsappClient = new WhatsAppClient();
      this.app.locals.whatsappClient = this.whatsappClient;
      this.whatsappClient.initialize().catch((e) => {
        console.error('❌ Falha inicial ao iniciar WhatsApp:', e?.message || e);
      });
    }
    return this.whatsappClient;
  }

  async waitForWAConnected(wa, timeoutMs = 8000) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const start = Date.now();
    while ((!wa.isConnected || !wa.sock) && Date.now() - start < timeoutMs) {
      await wait(250);
    }
    return wa.isConnected && !!wa.sock;
  }

  routes() {
    // Health
    this.app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

    // Status
    this.app.get('/api/whatsapp/status', (req, res) => {
      const wa = this.initWhatsApp();
      res.json({
        isConnected: wa.isConnected,
        qrCodeGenerated: wa.qrCodeGenerated,
        currentRetry: wa.currentRetry || 0,
        maxRetries: wa.maxRetries || 3,
        circuitBreakerState: wa.circuitBreaker || 'CLOSED',
        failureCount: wa.failureCount || 0,
        queueLength: 0,
        user: wa.user || null
      });
    });

    // Status detalhado
    this.app.get('/api/whatsapp/session-status', (req, res) => {
      const wa = this.initWhatsApp();
      res.json({
        initialized: !!wa.sock,
        connected: wa.isConnected,
        qrAvailable: !!wa.getQRCode(),
        pairingAvailable: !!wa.getPairingCode(),
        qrCode: null,
        pairingCode: null,
        retryCount: wa.currentRetry || 0,
        maxRetries: wa.maxRetries || 3,
        circuitBreaker: wa.circuitBreaker || 'CLOSED',
        user: wa.user || null,
        timestamp: new Date().toISOString()
      });
    });

    // Reset
    this.app.get('/api/reset-whatsapp', async (req, res) => {
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

    // Força QR
    this.app.get('/api/force-qr', async (req, res) => {
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

    // QR SVG
    this.app.get('/qr', async (req, res) => {
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

    // Pairing code
    this.app.get('/code', (req, res) => {
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

    this.app.get('/api/groups/sync', async (_req, res) => {
      try {
        const wa = this.initWhatsApp();
        const okConn = await this.waitForWAConnected(wa, 8000);
        if (!okConn) return res.status(503).json({ ok: false, error: 'WhatsApp ainda conectando… tente novamente em alguns segundos.' });

        const groups = await wa.listGroups();
        const saved = settings.set({ groups, lastSyncAt: new Date().toISOString() });
        res.json({ ok: true, groups, saved });
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
      }
    });

    this.app.get('/api/groups', (_req, res) => {
      res.json({ ok: true, settings: settings.get() });
    });

    // >>> Atualizado: aceita vários grupos (postGroupJids) ou um (resultGroupJid)
    this.app.post('/api/groups/select', (req, res) => {
      try {
        const { resultGroupJid, postGroupJids } = req.body || {};
        let list = Array.isArray(postGroupJids) ? postGroupJids : [];
        if (!list.length && resultGroupJid) list = [String(resultGroupJid)];
        list = Array.from(new Set(list.map(s => String(s).trim()).filter(Boolean)));
        if (!list.length) return res.status(400).json({ ok: false, error: 'Informe pelo menos um JID de grupo' });

        const out = settings.setPostGroups(list);
        res.json({ ok: true, settings: out });
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
      }
    });

    // >>> Teste: envia mensagem de teste para TODOS os grupos salvos
    this.app.post('/api/groups/test-post', async (_req, res) => {
      try {
        const wa = this.initWhatsApp();
        const st = settings.get();
        if (!wa.isConnected) return res.status(400).json({ ok: false, error: 'WhatsApp não conectado' });

        const targets = (Array.isArray(st.postGroupJids) && st.postGroupJids.length)
          ? st.postGroupJids
          : (st.resultGroupJid ? [st.resultGroupJid] : []);

        if (!targets.length) return res.status(400).json({ ok: false, error: 'Nenhum grupo selecionado' });

        for (const jid of targets) {
          await wa.sendToGroup(jid, '🔔 Teste de postagem de sorteio (ok)');
        }
        res.json({ ok: true, sentTo: targets.length });
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
      }
    });

    // ========= job manual =========
    this.app.post('/api/jobs/run-once', async (req, res) => {
      try {
        const out = await runOnce(this.app);
        res.json(out);
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
      }
    });
  }

  listen() {
    this.initWhatsApp();

    cron.schedule('*/1 * * * *', async () => {
      try { await runOnce(this.app); }
      catch (e) { console.error('cron runOnce error:', e?.message || e); }
    });

    this.app.listen(PORT, () => {
      console.log(`🚀 Server listening on :${PORT}`);
    });
  }
}

new App().listen();
