const fs = require('fs');
const path = require('path');
const P = require('@whiskeysockets/baileys');

const {
  makeWASocket,
  Browsers,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = P;

/**
 * Tenta obter makeInMemoryStore em diferentes pontos do pacote,
 * pois algumas versões não o exportam na raiz.
 */
function resolveMakeInMemoryStore() {
  try {
    const mod = require('@whiskeysockets/baileys');
    if (typeof mod.makeInMemoryStore === 'function') return mod.makeInMemoryStore;
  } catch (_) {}
  try {
    const mod = require('@whiskeysockets/baileys/lib/Store');
    if (typeof mod.makeInMemoryStore === 'function') return mod.makeInMemoryStore;
  } catch (_) {}
  return null; // sem store — seguimos com fallback
}

const makeInMemoryStore = resolveMakeInMemoryStore();

class WhatsAppClient {
  constructor() {
    this.sessionPath = process.env.WHATSAPP_SESSION_PATH || '/tmp/whatsapp-session';
    this.sock = null;

    // store do Baileys (se indisponível, usamos um "no-op" para não quebrar)
    this.store = makeInMemoryStore
      ? makeInMemoryStore({ logger: undefined })
      : {
          chats: { all: () => [] },
          bind: () => {}
        };

    // estado
    this.isConnected = false;
    this.qrCodeGenerated = false;
    this.currentQRCode = null;
    this.currentPairingCode = null;
    this.user = null;

    // controles simples
    this.currentRetry = 0;
    this.maxRetries = Number(process.env.WHATSAPP_RETRY_ATTEMPTS || 3);
    this.circuitBreaker = 'CLOSED';
  }

  async initialize() {
    // garante diretório
    fs.mkdirSync(this.sessionPath, { recursive: true });
    // teste de escrita (falha cedo se não puder)
    const probe = path.join(this.sessionPath, '.__rwtest');
    fs.writeFileSync(probe, String(Date.now()));
    fs.rmSync(probe, { force: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      printQRInTerminal: false,
      auth: state,
      browser: Browsers.appropriate('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    // bind da store aos eventos do socket (se existir)
    if (this.store && typeof this.store.bind === 'function') {
      this.store.bind(this.sock.ev);
    }

    // eventos
    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update = {}) => {
      const { connection, lastDisconnect, qr } = update;

      // >>>>>>> CAPTURA DO QR <<<<<<<
      if (qr) {
        this.currentQRCode = qr;
        this.qrCodeGenerated = true;
      }

      if (connection === 'open') {
        this.isConnected = true;
        this.currentQRCode = null;
        this.qrCodeGenerated = false;
        this.currentPairingCode = null;
        this.user = this.sock?.user || null;
        this.currentRetry = 0;
      }

      if (connection === 'close') {
        this.isConnected = false;
        this.user = null;

        const code =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.code;

        const shouldReconnect = code !== DisconnectReason.loggedOut;

        if (shouldReconnect && this.currentRetry < this.maxRetries) {
          this.currentRetry++;
          setTimeout(() => this.initialize().catch(() => {}), 1500);
        }
      }
    });

    // Tenta emparelhamento por número se a env existir
    await this.tryPairingIfConfigured().catch(() => {});
  }

  // Força que o Baileys “emita” algo de QR logo após reset/init
  async forceQRGeneration() {
    try {
      // zerar flags para garantir que o /qr vá buscar o novo QR
      this.currentQRCode = null;
      this.qrCodeGenerated = false;

      if (!this.sock) await this.initialize();

      // Se já estiver conectado, não há QR
