// whatsapp-automation/src/services/whatsapp-client.js
// 
// VERSÃO CORRIGIDA - Mudanças:
// - Removida reconexão automática interna (agora controlada pelo bots/index.js)
// - Adicionado callback onConnectionChange para o controlador externo
// - Melhor tratamento de erros
// - Mantidas todas as funcionalidades existentes (grupos, QR, pairing, etc)

const fs = require('fs');
const path = require('path');

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

    // controles de reconexão (mantidos para compatibilidade, mas não usados internamente)
    this.currentRetry = 0;
    this.maxRetries = Number(process.env.WHATSAPP_RETRY_ATTEMPTS || 3);
    this.circuitBreaker = 'CLOSED';

    // NOVO: Callback para notificar mudanças de conexão (usado pelo bots/index.js)
    this.onConnectionChange = null;

    // NOVO: Último erro para diagnóstico
    this.lastError = null;

    // módulo Baileys (carregado sob demanda para evitar ERR_REQUIRE_ESM)
    this._baileys = null;
    
    // NOVO: Flag para evitar inicializações simultâneas
    this._initializing = false;
  }

  async _loadBaileys() {
    if (!this._baileys) {
      // importa ESM em runtime dentro do CJS
      this._baileys = await import('@whiskeysockets/baileys');
    }
    return this._baileys;
  }

  async initialize() {
    // NOVO: Evita inicializações simultâneas
    if (this._initializing) {
      console.log('[WhatsAppClient] Já está inicializando, ignorando chamada duplicada');
      return;
    }
    
    this._initializing = true;
    
    try {
      const B = await this._loadBaileys();
      const {
        makeWASocket,
        Browsers,
        useMultiFileAuthState,
        fetchLatestBaileysVersion,
        DisconnectReason,
      } = B;

      // garante diretório e RW
      fs.mkdirSync(this.sessionPath, { recursive: true });
      const probe = path.join(this.sessionPath, '.__rwtest');
      fs.writeFileSync(probe, String(Date.now()));
      fs.rmSync(probe, { force: true });

      const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
      
      // MODIFICADO: Tratamento de erro ao buscar versão
      let version;
      try {
        const vRes = await fetchLatestBaileysVersion();
        version = vRes.version;
      } catch (e) {
        console.warn('[WhatsAppClient] Erro ao buscar versão do Baileys, usando padrão:', e?.message);
        version = [2, 3000, 1015901307];
      }

      // NOVO: Fecha socket anterior se existir (evita conexões duplicadas)
      if (this.sock) {
        try {
          this.sock.end();
        } catch (_) {}
        this.sock = null;
      }

      this.sock = makeWASocket({
        version,
        auth: state,
        browser: Browsers.appropriate('Chrome'),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        // manter histórico completo (quando suportado)
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
          this.lastError = null;
          
          // NOVO: Notifica callback externo
          if (typeof this.onConnectionChange === 'function') {
            this.onConnectionChange({ status: 'connected', user: this.user });
          }
        }

        if (connection === 'close') {
          this.isConnected = false;
          this.user = null;

          const error = lastDisconnect?.error;
          const code =
            error?.output?.statusCode ||
            error?.code;

          // NOVO: Guarda o erro para diagnóstico
          this.lastError = {
            code,
            message: error?.message || 'Conexão fechada',
            isLoggedOut: code === DisconnectReason.loggedOut,
            isConflict: error?.message?.includes('conflict') || error?.message?.includes('replaced'),
            isCryptoError: 
              error?.message?.includes('unable to authenticate') ||
              error?.message?.includes('Unsupported state') ||
              error?.message?.includes('bad mac'),
          };

          // REMOVIDO: Reconexão automática interna
          // Agora o bots/index.js controla isso de forma inteligente
          // 
          // ANTES:
          // if (shouldReconnect && this.currentRetry < this.maxRetries) {
          //   this.currentRetry++;
          //   setTimeout(() => this.initialize().catch(() => {}), 1500);
          // }
          //
          // AGORA: Apenas notifica o callback externo

          // NOVO: Notifica callback externo
          if (typeof this.onConnectionChange === 'function') {
            this.onConnectionChange({ 
              status: 'disconnected', 
              error: this.lastError,
              shouldReconnect: code !== DisconnectReason.loggedOut
            });
          }
        }
      });

      await this.tryPairingIfConfigured().catch(() => {});
      
    } finally {
      this._initializing = false;
    }
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

  // exposto para a página /admin calcular o badge de status
  getConnectionStatus() {
    return {
      isConnected: !!this.isConnected,
      user: this.user,
      currentRetry: this.currentRetry,
      lastError: this.lastError,  // NOVO: inclui último erro
    };
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
      this.lastError = null;
    } catch (e) {
      console.error('clearSession error:', e?.message || e);
    }
  }

  // ========= GRUPOS =========

  /**
   * Lista todos os grupos que a conta participa.
   */
  async listGroups() {
    if (!this.sock) throw new Error('WhatsApp não inicializado');

    const map = await this.sock.groupFetchAllParticipating();
    const items = Object.values(map || {});

    const groups = items.map((g) => ({
      jid: g.id,
      name: g.subject || g.name || 'Sem nome',
      participants: Array.isArray(g.participants) ? g.participants.length : (g.size || 0),
      isCommunity: !!g.community,
      announce: !!g.announce,
    }));

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
}

module.exports = WhatsAppClient;
