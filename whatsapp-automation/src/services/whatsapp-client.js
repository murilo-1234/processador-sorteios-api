// src/services/whatsapp-client.js
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
  constructor(options = {}) {
    // NOVO: Suporte multi-instância mantendo retrocompatibilidade TOTAL
    this.instanceId = options.instanceId || 'default';
    
    // NOVO: Path de sessão baseado em instanceId
    if (this.instanceId === 'default') {
      // MANTÉM comportamento original EXATO para sistema existente
      this.sessionPath = process.env.WHATSAPP_SESSION_PATH || '/tmp/whatsapp-session';
    } else {
      // NOVO comportamento apenas para Hub
      const baseDir = process.env.WA_SESSION_BASE || './data/baileys';
      this.sessionPath = path.join(baseDir, this.instanceId);
    }
    
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

    // fila opcional (compat c/ dashboards que leem queueLength)
    this.queueLength = 0;
    
    // NOVO: Callbacks opcionais para eventos (usado pelo Hub)
    this.onQRCode = options.onQRCode || null;
    this.onConnected = options.onConnected || null;
    this.onDisconnected = options.onDisconnected || null;
    this.onMessage = options.onMessage || null;
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
        // NOVO: Callback opcional para Hub
        if (this.onQRCode) {
          this.onQRCode(qr, this.instanceId);
        }
      }

      if (connection === 'open') {
        this.isConnected = true;
        this.user = this.sock?.user || null;
        this.currentRetry = 0;
        this.qrCodeGenerated = false;
        this.currentQRCode = null;
        this.currentPairingCode = null;
        // NOVO: Callback opcional para Hub
        if (this.onConnected) {
          this.onConnected(this.instanceId, this.user);
        }
      }

      if (connection === 'close') {
        this.isConnected = false;
        this.user = null;
        // NOVO: Callback opcional para Hub
        if (this.onDisconnected) {
          this.onDisconnected(this.instanceId);
        }

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

    // NOVO: Hook de mensagens para assistant-bot (apenas se configurado)
    if (this.onMessage) {
      this.sock.ev.on('messages.upsert', async (upsert) => {
        const messages = upsert.messages || [];
        for (const msg of messages) {
          // Ignora mensagens próprias e de status
          if (msg.key.fromMe || msg.key.participant) continue;
          if (msg.key.remoteJid === 'status@broadcast') continue;
          
          try {
            await this.onMessage(msg, this.instanceId);
          } catch (error) {
            console.error(`[${this.instanceId}] Error in message handler:`, error);
          }
        }
      });
    }

    await this.tryPairingIfConfigured().catch(() => {});
  }

  // ======== helpers de status (para dashboards) ========
  getConnectionStatus() {
    return {
      isConnected: !!this.isConnected,
      queueLength: Number(this.queueLength || 0),
      circuitBreakerState: this.circuitBreaker || 'CLOSED',
      user: this.user || null,
      instanceId: this.instanceId, // NOVO: identificação da instância
    };
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
      nome: g.subject || g.name || 'Sem nome', // alias p/ compat com rotas antigas
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

  // Alias de compatibilidade (admin usa getGroups)
  async getGroups() {
    return this.listGroups();
  }

  // ========= ENVIO DE MENSAGENS =========
  async sendToGroup(jid, text) {
    if (!this.isConnected) throw new Error('WhatsApp não está conectado');
    if (!jid) throw new Error('jid do grupo não informado');
    await this.sock.sendMessage(jid, { text: String(text) });
  }

  async sendTextMessage(jid, text, opts = {}) {
    if (!this.isConnected) throw new Error('WhatsApp não está conectado');
    return this.sock.sendMessage(jid, { text: String(text) }, opts);
  }

  async sendImageMessage(jid, fileOrPath, caption = '', opts = {}) {
    if (!this.isConnected) throw new Error('WhatsApp não está conectado');
    if (!jid) throw new Error('jid não informado');

    let imageData = null;
    if (Buffer.isBuffer(fileOrPath)) {
      imageData = fileOrPath;
    } else if (typeof fileOrPath === 'string') {
      imageData = fs.readFileSync(fileOrPath);
    } else if (fileOrPath && typeof fileOrPath === 'object' && fileOrPath.data) {
      imageData = fileOrPath.data; // { data: Buffer }
    }

    if (!imageData) throw new Error('Arquivo de imagem inválido');

    return this.sock.sendMessage(
      jid,
      { image: imageData, caption: caption || '' },
      opts
    );
  }
}

module.exports = WhatsAppClient;
