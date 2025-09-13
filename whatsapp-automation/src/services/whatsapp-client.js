const fs = require('fs');
const path = require('path');
const P = require('@whiskeysockets/baileys'); 

const {
  makeWASocket,
  Browsers,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = P;

class WhatsAppClient {
  constructor() {
    this.sessionPath = process.env.WHATSAPP_SESSION_PATH || '/tmp/whatsapp-session';
    this.sock = null;

    // estado de conexão
    this.isConnected = false;
    this.qrCodeGenerated = false;
    this.currentQRCode = null;
    this.currentPairingCode = null;
    this.user = null;

    // controles de reconexão
    this.currentRetry = 0;
    this.maxRetries = Number(process.env.WHATSAPP_RETRY_ATTEMPTS || 3);
    this.circuitBreaker = 'CLOSED';
  }

  async initialize() {
    // garante diretório e RW
    fs.mkdirSync(this.sessionPath, { recursive: true });
    const probe = path.join(this.sessionPath, '.__rwtest');
    fs.writeFileSync(probe, String(Date.now()));
    fs.rmSync(probe, { force: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      browser: Browsers.appropriate('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      // deixe true para garantir que o device puxe todos os chats/grupos
      syncFullHistory: true,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update = {}) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.currentQRCode = qr;
        this.qrCodeGenerated = true;
      }

      if (connection === 'open') {
        this.isConnected = true;
        this.user = this.sock?.user || null;
        this.currentRetry = 0;
        this.qrCodeGenerated = false;
        this.currentQRCode = null;
        this.currentPairingCode = null;
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

    await this.tryPairingIfConfigured().catch(() => {});
  }

  // tenta provocar a emissão de QR logo após reset/init
  async forceQRGeneration() {
    try {
      this.currentQRCode = null;
      this.qrCodeGenerated = false;

      if (!this.sock) await this.initialize();
      if (this.isConnected) return false;

      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 20 && !this.currentQRCode; i++) {
        await wait(300);
      }
      return !!this.currentQRCode;
    } catch {
      return false;
    }
  }

  getQRCode() {
    return this.currentQRCode || null;
  }

  getPairingCode() {
    return this.currentPairingCode || null;
  }

  async tryPairingIfConfigured() {
    const phone = (process.env.WHATSAPP_PHONE_NUMBER || '').trim();
    if (!phone) return false;

    try {
      if (!this.isConnected && this.sock?.requestPairingCode) {
        const code = await this.sock.requestPairingCode(phone);
        if (code) {
          this.currentPairingCode = code;
          this.currentQRCode = null;
          this.qrCodeGenerated = false;
          return true;
        }
      }
    } catch {
      // se falhar, /qr continua funcionando
    }
    return false;
  }

  async clearSession() {
    try {
      if (this.sock?.end) {
        try { this.sock.end(); } catch {}
      }
      this.sock = null;

      fs.rmSync(this.sessionPath, { recursive: true, force: true });
      fs.mkdirSync(this.sessionPath, { recursive: true });

      this.isConnected = false;
      this.qrCodeGenerated = false;
      this.currentQRCode = null;
      this.currentPairingCode = null;
      this.user = null;
      this.currentRetry = 0;
    } catch (e) {
      console.error('clearSession error:', e?.message || e);
    }
  }

  // ========= GRUPOS =========

  /**
   * Lista todos os grupos que a conta participa, incluindo
   * os "de avisos" de Comunidades, quando retornados pela API.
   */
  async listGroups() {
    if (!this.sock) throw new Error('WhatsApp não inicializado');

    // Busca no servidor (não apenas cache) — costuma incluir Comunidades/Anúncios
    const map = await this.sock.groupFetchAllParticipating();
    const items = Object.values(map || {});

    const groups = items.map((g) => ({
      jid: g.id,
      name: g.subject || g.name || 'Sem nome',
      participants: Array.isArray(g.participants) ? g.participants.length : (g.size || 0),
      isCommunity: !!g.community,
      announce: !!g.announce, // grupos somente avisos
    }));

    // remove duplicados por jid
    const seen = new Set();
    const unique = groups.filter((g) => (seen.has(g.jid) ? false : seen.add(g.jid)));

    // ordena por nome
    unique.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    return unique;
  }

  async sendToGroup(jid, text) {
    if (!this.isConnected) throw new Error('WhatsApp não está conectado');
    if (!jid) throw new Error('jid do grupo não informado');
    await this.sock.sendMessage(jid, { text: String(text) });
  }
}

module.exports = WhatsAppClient;
