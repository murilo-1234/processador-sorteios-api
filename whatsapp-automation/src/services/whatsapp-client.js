const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');

const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const logger = require('../config/logger');

class WhatsAppClient extends EventEmitter {
  shouldUsePairing() {
    const phone = (process.env.WHATSAPP_PHONE_NUMBER || '').trim();
    return !!phone && phone.replace(/\D/g, '').length >= 10;
  }

  constructor() {
    super();
    this.sock = null;
    this.isConnected = false;

    // Auth / sessão
    this.sessionPath = process.env.WHATSAPP_SESSION_PATH || '/data/whatsapp-session';

    // Pairing & QR
    this.qrCodeGenerated = false;
    this.currentQRCode = null;
    this.currentPairingCode = null;
    this.usePairingCode = this.shouldUsePairing();

    // Retry/reconnect
    this.retryAttempts = parseInt(process.env.WHATSAPP_RETRY_ATTEMPTS || '5', 10);
    this.retryDelay = parseInt(process.env.WHATSAPP_RETRY_DELAY_MS || '5000', 10);
    this.currentRetry = 0;
    this.reconnectTimer = null;
    this.initializing = false;

    // Rate limit / fila de envio
    this.messageQueue = [];
    this.isProcessingQueue = false;
    this.messagesPerMinute = parseInt(process.env.WHATSAPP_RATE_LIMIT_MESSAGES_PER_MINUTE || '10', 10);
    this.messageInterval = Math.max(1000, Math.floor(60000 / this.messagesPerMinute));

    // Circuit breaker
    this.circuitBreakerState = 'CLOSED'; // CLOSED | OPEN | HALF_OPEN
    this.failureCount = 0;
    this.failureThreshold = 5;
    this.circuitBreakerTimeout = 60_000;
    this.lastFailureTime = null;

    // Creds hook
    this._saveCreds = null;
  }

  /**
   * Inicializa o socket (com proteção para não criar múltiplas instâncias).
   */
  async initialize() {
    logger.info(`🔧 Auth dir: ${this.sessionPath}`);
    try { fs.mkdirSync(this.sessionPath, { recursive: true }); const p = `${this.sessionPath}/.__rwtest`; fs.writeFileSync(p, String(Date.now())); fs.rmSync(p, {force:true}); } catch(e){ logger.error('❌ Sessão sem permissão de escrita:', e?.message); throw e; }

    if (this.initializing) {
      logger.debug('⚙️ initialize() já em andamento; ignorando chamada duplicada.');
      return;
    }
    this.initializing = true;

    try {
      logger.info('🚀 Inicializando cliente WhatsApp...');

      if (!fs.existsSync(this.sessionPath)) {
        fs.mkdirSync(this.sessionPath, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
      this._saveCreds = saveCreds;

      const { version, isLatest } = await fetchLatestBaileysVersion();
      logger.info(`📱 Baileys v${version.join('.')} (latest=${isLatest})`);

      this.sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, undefined), // Remove logger problemático
        },
        browser: Browsers.macOS('Desktop'),
        printQRInTerminal: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 60_000,
        keepAliveIntervalMs: 30_000,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        // Configurações para resolver mutations
        retryRequestDelayMs: 5000,
        maxMsgRetryCount: 3,
        connectTimeoutMs: 60_000,
        // Logger undefined para evitar erros
        logger: undefined,
        getMessage: async () => ({ conversation: 'Mensagem não encontrada' }),
      });

      this.setupEventListeners();
      this.startMessageQueueProcessor();

      logger.info('✅ Cliente WhatsApp inicializado');
    } catch (error) {
      logger.error('❌ Erro ao inicializar cliente WhatsApp (retry em 10s):', error);
      setTimeout(() => this.initialize().catch(() => {}), 10_000);
    } finally {
      this.initializing = false;
    }
  }

  /**
   * Eventos do Baileys.
   */
  setupEventListeners() {
    if (!this.sock) return;

    // Salvar credenciais sempre que alteradas
    if (this._saveCreds) {
      this.sock.ev.on('creds.update', this._saveCreds);
    }

    // Conexão
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Pairing code quando não registrado e permitido por env
      if (!this.isConnected && !this.sock.authState.creds.registered && this.usePairingCode) {
        await this._tryRequestPairingCodeOnce();
      }

      // QR Code - SEMPRE gerar quando disponível (correção definitiva)
      if (qr) { this.lastQRAt = Date.now();
        this.currentQRCode = qr;
        this.qrCodeGenerated = true;
        logger.info('📱 QR Code gerado! Escaneie no WhatsApp.');
        qrcode.generate(qr, { small: true });
        this.emit('qr-code', qr);
      }

      // Forçar geração de QR se não conectado e não tem QR (correção adicional)
      if (!this.isConnected && !qr && !this.sock.authState.creds.registered && !this.usePairingCode) {
        logger.info('🔄 Forçando nova tentativa de QR Code...');
        setTimeout(() => {
          if (!this.isConnected && !this.qrCodeGenerated) {
            this.initialize().catch(() => {});
          }
        }, 3000);
      }

      if (connection === 'open') {
        this.isConnected = true;
        this.currentRetry = 0;
        this.qrCodeGenerated = false;
        this.currentQRCode = null;
        this.currentPairingCode = null;
        this.resetCircuitBreaker();
        logger.info('✅ WhatsApp conectado!');
        this.emit('connected');
        return;
      }

      if (connection === 'connecting') {
        logger.info('🔄 Conectando ao WhatsApp...');
        this.emit('connecting');
        return;
      }

      if (connection === 'close') {
        this.isConnected = false;
        this.qrCodeGenerated = false;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode ??
          lastDisconnect?.error?.status ??
          lastDisconnect?.statusCode ??
          lastDisconnect?.code;

        const loggedOut = statusCode === DisconnectReason.loggedOut;
        logger.warn(`🔌 Conexão fechada (code=${statusCode}). loggedOut=${loggedOut}`);

        if (loggedOut) {
          // Não tente reconectar: precisa revalidar (QR/Pairing)
          this.emit('logged-out');
          return;
        }

        // Reconexão automática
        this.handleReconnection();
      }
    });

    // Mensagens recebidas (debug)
    this.sock.ev.on('messages.upsert', (m) => {
      if (m?.messages?.length) {
        logger.debug(`📨 ${m.messages.length} mensagem(ns) recebida(s)`);
      }
    });

    // Grupos
    this.sock.ev.on('groups.update', (updates) => {
      logger.debug(`👥 ${updates.length} grupo(s) atualizado(s)`);
      this.emit('groups-updated', updates);
    });
  }

  /**
   * Gera Pairing Code apenas uma vez por ciclo.
   */
  async _tryRequestPairingCodeOnce() {
    if (!this.usePairingCode) return;
    if (this.currentPairingCode) return;

    try {
      const phoneNumber = (process.env.WHATSAPP_PHONE_NUMBER || '').trim();
      if (!phoneNumber) return;

      logger.info('📱 Solicitando Pairing Code...');
      const code = await this.sock.requestPairingCode(phoneNumber);
      this.currentPairingCode = code;

      logger.info('✅ Pairing Code gerado!');
      this.emit('pairing-code', code);

      // Dica no console
      console.log('\n🔗 PAIRING CODE PARA WHATSAPP\n');
      console.log(`📱 Código: ${code}\n`);
      console.log('Como usar: WhatsApp > Aparelhos conectados > Conectar com código\n');
    } catch (err) {
      logger.error('❌ Erro ao solicitar Pairing Code (usará QR como fallback):', err);
      // Se falhar, libera QR como fallback:
      this.usePairingCode = false;
    }
  }

  /**
   * Reconexão com backoff.
   */
  handleReconnection() {
    if (this.reconnectTimer) {
      logger.debug('⏳ Reconexão já agendada.');
      return;
    }

    if (this.currentRetry >= this.retryAttempts) {
      logger.error(`❌ Máximo de tentativas de reconexão atingido (${this.retryAttempts}).`);
      this.emit('max-retries-reached');
      return;
    }

    this.currentRetry += 1;
    const delay = this.retryDelay * this.currentRetry; // backoff linear

    logger.info(`🔁 Tentativa de reconexão ${this.currentRetry}/${this.retryAttempts} em ${delay}ms`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.initialize();
      } catch (err) {
        logger.error(`❌ Erro na reconexão (${this.currentRetry}):`, err);
        this.handleReconnection();
      }
    }, delay);
  }

  /**
   * Fila / rate limit — processamento
   */
  startMessageQueueProcessor() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;
    logger.info('🔄 Iniciando processador da fila de mensagens');

    const loop = async () => {
      try {
        if (this.messageQueue.length === 0) {
          setTimeout(loop, 1000);
          return;
        }

        if (!this.isConnected) {
          logger.warn('⚠️ WhatsApp desconectado. Aguardando reconexão para enviar...');
          setTimeout(loop, 5000);
          return;
        }

        if (this.circuitBreakerState === 'OPEN') {
          if (Date.now() - this.lastFailureTime > this.circuitBreakerTimeout) {
            this.circuitBreakerState = 'HALF_OPEN';
            logger.info('🟡 Circuit breaker HALF_OPEN');
          } else {
            setTimeout(loop, 5000);
            return;
          }
        }

        const item = this.messageQueue.shift();
        await this.processMessage(item);

        if (this.circuitBreakerState === 'HALF_OPEN') {
          this.resetCircuitBreaker();
        }

        setTimeout(loop, this.messageInterval);
      } catch (err) {
        logger.error('❌ Erro no loop da fila:', err);
        setTimeout(loop, this.messageInterval);
      }
    };

    loop();
  }

  /**
   * Enfileira uma mensagem com imagem para grupo.
   */
  async sendImageMessage(groupJid, imagePath, caption, options = {}) {
    return new Promise((resolve, reject) => {
      const messageData = { groupJid, imagePath, caption, options, resolve, reject, ts: Date.now() };
      this.messageQueue.push(messageData);
      logger.info(`📤 Mensagem enfileirada (pos=${this.messageQueue.length})`);
    });
  }

  /**
   * Envia uma mensagem (chamado pelo loop da fila).
   */
  async processMessage({ groupJid, imagePath, caption, options, resolve, reject }) {
    try {
      if (!fs.existsSync(imagePath)) {
        throw new Error(`Arquivo de imagem não encontrado: ${imagePath}`);
      }

      const imageBuffer = fs.readFileSync(imagePath);
      const result = await this.sock.sendMessage(groupJid, { image: imageBuffer, caption, ...options });

      logger.info(`✅ Mensagem enviada para ${groupJid}`);
      logger.whatsapp?.('MESSAGE_SENT', { groupJid, messageId: result?.key?.id });
      resolve(result);
    } catch (error) {
      this.recordFailure();
      logger.error(`❌ Falha ao enviar para ${groupJid}:`, error);
      logger.whatsapp?.('MESSAGE_FAILED', { groupJid, error: error.message });
      reject(error);
    }
  }

  /**
   * Circuit breaker — falha
   */
  recordFailure() {
    this.failureCount += 1;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.circuitBreakerState = 'OPEN';
      logger.warn(`🔴 Circuit breaker ABERTO (${this.failureCount} falhas)`);
      this.emit('circuit-breaker-open');
    }
  }

  /**
   * Circuit breaker — reset
   */
  resetCircuitBreaker() {
    this.failureCount = 0;
    this.circuitBreakerState = 'CLOSED';
    this.lastFailureTime = null;
    logger.info('🟢 Circuit breaker resetado');
  }

  /**
   * Listar grupos com retry automático
   */
  async getGroups() {
    if (!this.isConnected) throw new Error('WhatsApp não está conectado');
    
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      try {
        logger.info(`🔍 Buscando grupos (tentativa ${attempts + 1}/${maxAttempts})...`);
        
        // Aguardar um pouco antes de buscar grupos
        if (attempts > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        const groups = await this.sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).map((g) => ({
          jid: g.id,
          nome: g.subject,
          participantes: g.participants?.length || 0,
          isAdmin:
            g.participants?.some(
              (p) => p.id === this.sock.user?.id && (p.admin === 'admin' || p.admin === 'superadmin')
            ) || false,
        }));
        
        logger.info(`✅ ${groupList.length} grupos encontrados`);
        return groupList;
        
      } catch (error) {
        attempts++;
        logger.warn(`⚠️ Erro ao buscar grupos (tentativa ${attempts}):`, error.message);
        
        if (attempts >= maxAttempts) {
          logger.error('❌ Falha ao buscar grupos após todas as tentativas');
          throw new Error(`Falha ao buscar grupos: ${error.message}`);
        }
        
        // Aguardar antes da próxima tentativa
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  // ===== utilitários expostos para as rotas =====

  getPairingCode() {
    return this.currentPairingCode;
  }

  getQRCode() {
    return this.currentQRCode;
  }

  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      qrCodeGenerated: this.qrCodeGenerated,
      currentRetry: this.currentRetry,
      maxRetries: this.retryAttempts,
      circuitBreakerState: this.circuitBreakerState,
      failureCount: this.failureCount,
      queueLength: this.messageQueue.length,
      user: this.sock?.user || null,
    };
  }

  async disconnect() {
    if (!this.sock) return;
    try {
      logger.info('🔌 Desconectando WhatsApp...');
      await this.sock.logout();
    } catch (e) {
      logger.warn('⚠️ Erro ao deslogar (ignorando):', e?.message);
    }
    this.isConnected = false;
    this.sock = null;
    logger.info('✅ Desconectado');
  }

  async clearSession() {
    logger.info('🗑️ Limpando sessão WhatsApp...');
    if (this.sock) await this.disconnect();

    try {
      if (fs.existsSync(this.sessionPath)) {
        fs.rmSync(this.sessionPath, { recursive: true, force: true });
      }
      logger.info('✅ Sessão removida');
    } catch (e) {
      logger.warn('⚠️ Erro ao remover sessão:', e?.message);
    }

    // Reset completo de estados
    this.qrCodeGenerated = false;
    this.currentQRCode = null;
    this.currentPairingCode = null;
    this.currentRetry = 0;
    this.isConnected = false;
    this.initializing = false;
    this.resetCircuitBreaker();
    
    logger.info('🔄 Estados resetados - pronto para nova inicialização');
  }

  // Método para forçar geração de QR Code
  async forceQRGeneration() {
    logger.info('🔄 Forçando geração de QR Code...');
    
    // Limpar sessão primeiro
    await this.clearSession();
    
    // Aguardar um pouco
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Reinicializar com foco em QR
    this.usePairingCode = false; // Garantir que use QR
    await this.initialize();
    
    // Aguardar geração do QR
    let attempts = 0;
    const maxAttempts = 10;
    
    while (!this.qrCodeGenerated && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
      logger.info(`⏳ Aguardando QR Code... (${attempts}/${maxAttempts})`);
    }
    
    if (this.qrCodeGenerated) {
      logger.info('✅ QR Code gerado com sucesso!');
      return true;
    } else {
      logger.warn('⚠️ QR Code não foi gerado após tentativas');
      return false;
    }
  }


// Tenta gerar Pairing Code se houver número configurado (E.164)
async tryPairingIfConfigured() {
  try {
    this.phoneNumber = process.env.WHATSAPP_PHONE_NUMBER || this.phoneNumber || null;
    if (!this.phoneNumber) return false;
    if (!this.sock) await this.initialize();
    if (!this.sock?.requestPairingCode) return false;
    const code = await this.sock.requestPairingCode(this.phoneNumber);
    if (code) {
      this.currentPairingCode = code;
      this.lastPairingAt = Date.now();
      this.qrCodeGenerated = false;
      return true;
    }
  } catch (e) {
    this.lastErrors.push({ ts: Date.now(), where: 'tryPairingIfConfigured', msg: e?.message });
    logger.warn('⚠️ Falha ao gerar pairing code:', e?.message);
  }
  return false;
}

getDebug() {
  try {
    const fs = require('fs');
    let files = [];
    try {
      files = fs.readdirSync(this.sessionPath);
    } catch(e) { files = ['<inacessível>']; }
    return {
      sessionPath: this.sessionPath,
      isConnected: this.isConnected,
      qrCodeGenerated: this.qrCodeGenerated,
      lastQRAt: this.lastQRAt,
      lastPairingAt: this.lastPairingAt,
      hasSock: !!this.sock,
      files,
      lastUpdate: this.lastUpdate,
      lastErrors: this.lastErrors.slice(-5),
    };
  } catch (e) {
    return { error: e?.message };
  }
}
}

module.exports = WhatsAppClient;
