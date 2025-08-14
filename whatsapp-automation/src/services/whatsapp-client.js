const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');
const EventEmitter = require('events');

class WhatsAppClient extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.isConnected = false;
    this.qrCodeGenerated = false;
    this.sessionPath = process.env.WHATSAPP_SESSION_PATH || './data/whatsapp-session';
    this.retryAttempts = parseInt(process.env.WHATSAPP_RETRY_ATTEMPTS) || 3;
    this.retryDelay = parseInt(process.env.WHATSAPP_RETRY_DELAY_MS) || 5000;
    this.currentRetry = 0;
    this.connectionPromise = null;
    
    // Rate limiting
    this.messageQueue = [];
    this.isProcessingQueue = false;
    this.messagesPerMinute = parseInt(process.env.WHATSAPP_RATE_LIMIT_MESSAGES_PER_MINUTE) || 10;
    this.messageInterval = 60000 / this.messagesPerMinute; // ms entre mensagens
    
    // Circuit breaker
    this.circuitBreakerState = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0;
    this.failureThreshold = 5;
    this.circuitBreakerTimeout = 60000; // 1 minuto
    this.lastFailureTime = null;
  }

  /**
   * Inicializar cliente WhatsApp
   */
  async initialize() {
    try {
      logger.info('🚀 Inicializando cliente WhatsApp...');
      
      // Garantir que o diretório de sessão existe
      if (!fs.existsSync(this.sessionPath)) {
        fs.mkdirSync(this.sessionPath, { recursive: true });
      }

      // Configurar autenticação multi-arquivo
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
      
      // Obter versão mais recente do Baileys
      const { version, isLatest } = await fetchLatestBaileysVersion();
      logger.info(`📱 Usando Baileys v${version.join('.')}, latest: ${isLatest}`);

      // Criar socket WhatsApp
      this.sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        browser: Browsers.macOS('Desktop'),
        printQRInTerminal: false, // Vamos gerar nosso próprio QR
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        getMessage: async (key) => {
          // Implementar cache de mensagens se necessário
          return { conversation: 'Mensagem não encontrada' };
        }
      });

      // Configurar event listeners
      this.setupEventListeners(saveCreds);
      
      // Iniciar processamento da fila de mensagens
      this.startMessageQueueProcessor();
      
      logger.info('✅ Cliente WhatsApp inicializado com sucesso');
      
    } catch (error) {
      logger.error('❌ Erro ao inicializar cliente WhatsApp:', error);
      throw error;
    }
  }

  /**
   * Configurar event listeners do Baileys
   */
  setupEventListeners(saveCreds) {
    // Atualização de conexão
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr && !this.qrCodeGenerated) {
        logger.info('📱 QR Code gerado para autenticação');
        console.log('\n🔗 ESCANEIE O QR CODE ABAIXO COM SEU WHATSAPP:\n');
        qrcode.generate(qr, { small: true });
        console.log('\n📱 Abra o WhatsApp > Aparelhos Conectados > Conectar Aparelho\n');
        this.qrCodeGenerated = true;
        this.emit('qr-code', qr);
      }

      if (connection === 'close') {
        this.isConnected = false;
        this.qrCodeGenerated = false;
        
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        const reason = lastDisconnect?.error?.output?.statusCode;
        
        logger.warn(`🔌 Conexão fechada. Motivo: ${reason}. Reconectar: ${shouldReconnect}`);
        
        if (shouldReconnect) {
          await this.handleReconnection(reason);
        } else {
          logger.error('❌ Usuário deslogado. Necessário escanear QR Code novamente.');
          this.emit('logged-out');
        }
      } else if (connection === 'open') {
        this.isConnected = true;
        this.currentRetry = 0;
        this.resetCircuitBreaker();
        logger.info('✅ WhatsApp conectado com sucesso!');
        this.emit('connected');
      } else if (connection === 'connecting') {
        logger.info('🔄 Conectando ao WhatsApp...');
        this.emit('connecting');
      }
    });

    // Salvar credenciais quando atualizadas
    this.sock.ev.on('creds.update', saveCreds);

    // Log de mensagens recebidas (para debug)
    this.sock.ev.on('messages.upsert', (m) => {
      const messages = m.messages;
      if (messages && messages.length > 0) {
        logger.debug(`📨 ${messages.length} mensagem(ns) recebida(s)`);
      }
    });

    // Atualização de grupos
    this.sock.ev.on('groups.update', (updates) => {
      logger.debug(`👥 ${updates.length} grupo(s) atualizado(s)`);
      this.emit('groups-updated', updates);
    });
  }

  /**
   * Lidar com reconexão automática
   */
  async handleReconnection(reason) {
    if (this.currentRetry >= this.retryAttempts) {
      logger.error(`❌ Máximo de tentativas de reconexão atingido (${this.retryAttempts})`);
      this.emit('max-retries-reached');
      return;
    }

    this.currentRetry++;
    const delay = this.retryDelay * this.currentRetry; // Backoff exponencial
    
    logger.info(`🔄 Tentativa de reconexão ${this.currentRetry}/${this.retryAttempts} em ${delay}ms`);
    
    setTimeout(async () => {
      try {
        await this.initialize();
      } catch (error) {
        logger.error(`❌ Erro na tentativa de reconexão ${this.currentRetry}:`, error);
        await this.handleReconnection(reason);
      }
    }, delay);
  }

  /**
   * Obter lista de grupos
   */
  async getGroups() {
    if (!this.isConnected) {
      throw new Error('WhatsApp não está conectado');
    }

    try {
      const groups = await this.sock.groupFetchAllParticipating();
      const groupList = Object.values(groups).map(group => ({
        jid: group.id,
        nome: group.subject,
        participantes: group.participants?.length || 0,
        isAdmin: group.participants?.some(p => 
          p.id === this.sock.user?.id && (p.admin === 'admin' || p.admin === 'superadmin')
        ) || false
      }));

      logger.info(`👥 ${groupList.length} grupos encontrados`);
      return groupList;
    } catch (error) {
      logger.error('❌ Erro ao obter grupos:', error);
      throw error;
    }
  }

  /**
   * Enviar mensagem com imagem para um grupo
   */
  async sendImageMessage(groupJid, imagePath, caption, options = {}) {
    return new Promise((resolve, reject) => {
      const messageData = {
        groupJid,
        imagePath,
        caption,
        options,
        resolve,
        reject,
        timestamp: Date.now()
      };

      this.messageQueue.push(messageData);
      logger.info(`📤 Mensagem adicionada à fila. Posição: ${this.messageQueue.length}`);
    });
  }

  /**
   * Processar fila de mensagens com rate limiting
   */
  async startMessageQueueProcessor() {
    if (this.isProcessingQueue) return;
    
    this.isProcessingQueue = true;
    logger.info('🔄 Iniciando processador de fila de mensagens');

    const processNext = async () => {
      if (this.messageQueue.length === 0) {
        setTimeout(processNext, 1000); // Verificar novamente em 1s
        return;
      }

      if (!this.isConnected) {
        logger.warn('⚠️ WhatsApp desconectado. Aguardando reconexão...');
        setTimeout(processNext, 5000);
        return;
      }

      if (this.circuitBreakerState === 'OPEN') {
        if (Date.now() - this.lastFailureTime > this.circuitBreakerTimeout) {
          this.circuitBreakerState = 'HALF_OPEN';
          logger.info('🔄 Circuit breaker mudou para HALF_OPEN');
        } else {
          setTimeout(processNext, 5000);
          return;
        }
      }

      const messageData = this.messageQueue.shift();
      
      try {
        await this.processMessage(messageData);
        
        if (this.circuitBreakerState === 'HALF_OPEN') {
          this.resetCircuitBreaker();
        }
        
        // Aguardar intervalo entre mensagens
        setTimeout(processNext, this.messageInterval);
        
      } catch (error) {
        this.handleMessageFailure(error, messageData);
        setTimeout(processNext, this.messageInterval);
      }
    };

    processNext();
  }

  /**
   * Processar uma mensagem individual
   */
  async processMessage(messageData) {
    const { groupJid, imagePath, caption, options, resolve, reject } = messageData;
    
    try {
      logger.info(`📤 Enviando mensagem para grupo: ${groupJid}`);
      
      // Verificar se o arquivo de imagem existe
      if (!fs.existsSync(imagePath)) {
        throw new Error(`Arquivo de imagem não encontrado: ${imagePath}`);
      }

      // Ler arquivo de imagem
      const imageBuffer = fs.readFileSync(imagePath);
      
      // Enviar mensagem
      const result = await this.sock.sendMessage(groupJid, {
        image: imageBuffer,
        caption: caption,
        ...options
      });

      logger.info(`✅ Mensagem enviada com sucesso para ${groupJid}`);
      logger.whatsapp('MESSAGE_SENT', { groupJid, messageId: result.key.id });
      
      resolve(result);
      
    } catch (error) {
      logger.error(`❌ Erro ao enviar mensagem para ${groupJid}:`, error);
      this.recordFailure();
      reject(error);
    }
  }

  /**
   * Lidar com falha no envio de mensagem
   */
  handleMessageFailure(error, messageData) {
    this.recordFailure();
    
    // Rejeitar a promise
    messageData.reject(error);
    
    // Log do erro
    logger.error('❌ Falha no envio de mensagem:', error);
    logger.whatsapp('MESSAGE_FAILED', { 
      groupJid: messageData.groupJid, 
      error: error.message 
    });
  }

  /**
   * Registrar falha para circuit breaker
   */
  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.failureCount >= this.failureThreshold) {
      this.circuitBreakerState = 'OPEN';
      logger.warn(`⚠️ Circuit breaker ABERTO após ${this.failureCount} falhas`);
      this.emit('circuit-breaker-open');
    }
  }

  /**
   * Resetar circuit breaker
   */
  resetCircuitBreaker() {
    this.failureCount = 0;
    this.circuitBreakerState = 'CLOSED';
    this.lastFailureTime = null;
    logger.info('✅ Circuit breaker resetado');
  }

  /**
   * Verificar status da conexão
   */
  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      qrCodeGenerated: this.qrCodeGenerated,
      currentRetry: this.currentRetry,
      maxRetries: this.retryAttempts,
      circuitBreakerState: this.circuitBreakerState,
      failureCount: this.failureCount,
      queueLength: this.messageQueue.length,
      user: this.sock?.user || null
    };
  }

  /**
   * Desconectar cliente
   */
  async disconnect() {
    if (this.sock) {
      logger.info('🔌 Desconectando cliente WhatsApp...');
      await this.sock.logout();
      this.isConnected = false;
      this.sock = null;
      logger.info('✅ Cliente WhatsApp desconectado');
    }
  }

  /**
   * Limpar sessão (forçar novo QR Code)
   */
  async clearSession() {
    logger.info('🗑️ Limpando sessão WhatsApp...');
    
    if (this.sock) {
      await this.disconnect();
    }
    
    // Remover arquivos de sessão
    if (fs.existsSync(this.sessionPath)) {
      fs.rmSync(this.sessionPath, { recursive: true, force: true });
      logger.info('✅ Sessão WhatsApp removida');
    }
    
    this.qrCodeGenerated = false;
    this.currentRetry = 0;
    this.resetCircuitBreaker();
  }
}

module.exports = WhatsAppClient;

