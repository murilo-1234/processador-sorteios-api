// ======================= WebCrypto SHIM (antes de qualquer import do Baileys) =======================
try {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    const { webcrypto } = require('crypto');
    globalThis.crypto = webcrypto;
  }
} catch (_) {
  // silencioso: apenas garante que globalThis.crypto exista em Node 18 no Render
}
// ===================================================================================================

const path = require('path');
const express = require('express');
const morgan = require('morgan');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');                 // <<< NOVO

const WhatsAppClient = require('./services/whatsapp-client');
const settings = require('./services/settings');   // << persistência de seleção de grupos
const { runOnce } = require('./jobs/post-winner'); // <<< NOVO

const PORT = process.env.PORT || 3000;

class App {
  constructor() {
    this.app = express();
    this.whatsappClient = null;

    // segurança básica do rate limit (sem validação de proxy chata)
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

    // servir estáticos (páginas em /public)
    this.app.use(express.static(path.join(__dirname, '../public')));

    // trust proxy só se explicitamente habilitado (evita warnings)
    const tp = process.env.TRUST_PROXY === '1' ? 1 : false;
    this.app.set('trust proxy', tp);

    this.routes();
  }

  initWhatsApp() {
    if (!this.whatsappClient) {
      this.whatsappClient = new WhatsAppClient();
      this.app.locals.whatsappClient = this.whatsappClient;
      // inicializa em background
      this.whatsappClient.initialize().catch((e) => {
        console.error('❌ Falha inicial ao iniciar WhatsApp:', e?.message || e);
      });
    }
    return this.whatsappClient;
  }

  routes() {
    // Health simples
    this.app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

    // Status enxuto
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

    // Status detalhado da sessão
    this.app.get('/api/whatsapp/session-status', (req, res) => {
      const wa = this.initWhatsApp();
      res.json({
        initialized: !!wa.sock,
        connected: wa.isConnected,
        qrAvailable: !!wa.getQRCode(),
        pairingAvailable: !!wa.getPairingCode(),
        qrCode: null, // nunca exponha o texto do QR aqui
        pairingCode: null, // idem
        retryCount: wa.currentRetry || 0,
        maxRetries: wa.maxRetries || 3,
        circuitBreaker: wa.circuitBreaker || 'CLOSED',
        user: wa.user || null,
        timestamp: new Date().toISOString()
      });
    });

    // Reset: limpa sessão e re-inicializa; tenta já forçar geração do QR
    this.app.get('/api/reset-whatsapp', async (req, res) => {
      const wa = this.initWhatsApp();
      try {
        await wa.clearSession();
        await wa.initialize();
        // tenta provocar evento de QR imediatamente
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

    // Força tentativa de QR (útil se você não usa pairing)
    this.app.get('/api/force-qr', async (req, res) => {
      const wa = this.initWhatsApp();
      try {
        const ok = await wa.forceQRGeneration();
        if (ok) {
          return res.json({
            success: true,
            message: 'QR preparado. Acesse /qr.',
            qrAvailable: true,
            timestamp: new Date().toISOString()
          });
        }
        return res.json({
          success: false,
          message: 'Falha ao gerar QR Code. Tente novamente.',
          qrAvailable: false,
          timestamp: new Date().toISOString()
        });
      } catch (e) {
        console.error('❌ force-qr:', e);
        return res.status(500).json({ success: false, error: e?.message || String(e) });
      }
    });

    // Exibe o QR (SVG). Espera alguns ciclos para dar tempo do Baileys emitir o evento.
    this.app.get('/qr', async (req, res) => {
      const wa = this.initWhatsApp();
      try {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        let tries = 0;

        // aguarda até ~6s (20 * 300ms)
        while (!wa.getQRCode() && tries < 20) {
          await wait(300);
          tries++;
        }

        const qr = wa.getQRCode();
        if (!qr) {
          return res
            .status(404)
            .json({ error: 'QR Code não disponível', message: 'WhatsApp pode já estar conectado ou aguardando conexão' });
        }

        const svg = await QRCode.toString(qr, { type: 'svg', margin: 1, width: 300 });
        res.set('Content-Type', 'image/svg+xml').send(svg);
      } catch (e) {
        console.error('❌ /qr:', e);
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // (Opcional) Mostra Pairing Code, se habilitado por env e disponível
    this.app.get('/code', (req, res) => {
      const wa = this.initWhatsApp();
      const code = wa.getPairingCode();
      if (!code) return res.status(404).json({ error: 'Pairing code não disponível' });
      return res.json({ pairingCode: code });
    });

    // ==========================
    //     ROTAS PARA GRUPOS
    // ==========================

    // Página administrativa de grupos
    this.app.get('/admin/groups', (_req, res) => {
      res.sendFile(path.join(__dirname, '../public/admin/groups.html'));
    });

    // Sincroniza grupos a partir do WhatsApp e salva em /data/config/settings.json
    this.app.get('/api/groups/sync', async (_req, res) => {
      try {
        const wa = this.initWhatsApp();
        if (!wa.isConnected) return res.status(400).json({ ok: false, error: 'WhatsApp não conectado' });

        const groups = await wa.listGroups();
        const saved = settings.set({ groups, lastSyncAt: new Date().toISOString() });
        res.json({ ok: true, groups, saved });
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
      }
    });

    // Retorna grupos salvos + seleção atual
    this.app.get('/api/groups', (_req, res) => {
      res.json({ ok: true, settings: settings.get() });
    });

    // Define o grupo de resultados dos sorteios
    this.app.post('/api/groups/select', (req, res) => {
      try {
        const { resultGroupJid } = req.body || {};
        if (!resultGroupJid) return res.status(400).json({ ok: false, error: 'resultGroupJid é obrigatório' });
        const out = settings.set({ resultGroupJid });
        res.json({ ok: true, settings: out });
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
      }
    });

    // Envia uma mensagem de teste para o grupo escolhido
    this.app.post('/api/groups/test-post', async (_req, res) => {
      try {
        const wa = this.initWhatsApp();
        const st = settings.get();
        if (!wa.isConnected) return res.status(400).json({ ok: false, error: 'WhatsApp não conectado' });
        if (!st.resultGroupJid) return res.status(400).json({ ok: false, error: 'Nenhum grupo selecionado' });

        await wa.sendToGroup(st.resultGroupJid, '🔔 Teste de postagem de sorteio (ok)');
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
      }
    });

    // ========= NOVO: rodar o job 1x manual =========
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

    // ========= NOVO: cron a cada 1 minuto =========
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
