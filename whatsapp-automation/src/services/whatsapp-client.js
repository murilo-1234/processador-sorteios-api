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

class WhatsAppClient {
  constructor() {
    this.sessionPath = process.env.WHATSAPP_SESSION_PATH || '/tmp/whatsapp-session';
    this.sock = null;

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

    // eventos
    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update || {};

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

        const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.code;
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
      if (this.isConnected) return false;

      // pequena espera para o evento chegar (normalmente rápido)
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      let tries = 0;
      while (!this.currentQRCode && tries < 15) {
        await wait(200);
        tries++;
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
      // apenas se não conectado e se a lib expõe o método
      if (!this.isConnected && this.sock?.requestPairingCode) {
        const code = await this.sock.requestPairingCode(phone);
        if (code) {
          this.currentPairingCode = code;
          this.currentQRCode = null; // quando pairing está ativo, não usamos QR
          this.qrCodeGenerated = false;
          return true;
        }
      }
    } catch (_) {
      // ignore; se falhar, o /qr ainda poderá tentar o QR normal
    }
    return false;
  }

  async clearSession() {
    try {
      if (this.sock?.end) {
        try { this.sock.end(); } catch (_) {}
      }
      this.sock = null;
      // remove diretório de sessão
      fs.rmSync(this.sessionPath, { recursive: true, force: true });
      fs.mkdirSync(this.sessionPath, { recursive: true });

      // zera estado
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

  // =========================
  // NOVAS FUNÇÕES PARA GRUPOS
  // =========================

  // Lista todos os grupos que a conta participa (jid, nome, total de participantes)
  async listGroups() {
    if (!this.sock) throw new Error('WhatsApp não inicializado');
    const participating = await this.sock.groupFetchAllParticipating();
    const groups = Object.values(participating || {}).map(g => ({
      jid: g.id,
      name: g.subject,
      participants: Array.isArray(g.participants) ? g.participants.length : (g.size || 0)
    }));
    // ordena alfabeticamente
    return groups.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  // Envia mensagem de texto para um grupo específico
  async sendToGroup(jid, text) {
    if (!this.isConnected) throw new Error('WhatsApp não está conectado');
    if (!jid) throw new Error('jid do grupo não informado');
    await this.sock.sendMessage(jid, { text: String(text) });
  }
}

module.exports = WhatsAppClient;
