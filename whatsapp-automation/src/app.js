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

const express = require('express');
const morgan = require('morgan');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');
const WhatsAppClient = require('./services/whatsapp-client');

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
  }

  listen() {
    this.initWhatsApp();
    this.app.listen(PORT, () => {
      console.log(`🚀 Server listening on :${PORT}`);
    });
  }
}

new App().listen();
