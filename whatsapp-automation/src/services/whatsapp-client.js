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
    this.realConnectionStatus = false; // Status real da conexão

    // Auth / sessão
    this.sessionPath = process.env.WHATSAPP_SESSION_PATH || '/tmp/whatsapp-session';

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

    // HEARTBEAT - Detecção ativa de desconexão
    this.heartbeatInterval = null;
    this.heartbeatFrequency = 30000; // 30 segundos
    this.lastHeartbeatResponse = null;
    this.missedHeartbeats = 0;
    this.maxMissedHeartbeats = 3;

    // DETECÇÃO DE DESCONEXÃO MANUAL
    this.connectionCheckInterval = null;
    this.connectionCheckFrequency = 15000; // 15 segundos
    this.lastConnectionCheck = null;
    this.forceResetOnDisconnect = true;

    // Rate limit / fila de envio
    this.messageQueue = [];
    this.isProcessingQueue = false;
    this.messagesPerMinute = parseInt(process.env.WHATSAPP_RATE_LIMIT_MESSAGES_PER_MINUTE || '10', 10);
    this.messageInterval = Math.max(1000, Math.floor(60000 / this.messagesPerMinute));

    // Circuit breaker
    this.circuitBreakerState = 'CLOSED'; // CLOSED | OPEN | HALF_OPEN
    this.failureCount = 0;
    this.failureThreshold = parseInt(process.env.WHATSAPP_CIRCUIT_BREAKER_THRESHOLD || '3', 10);
    this.lastFailureTime = null;

    // Estado de sessão
    this.sessionCorrupted = false;
    this.lastSuccessfulConnection = null;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 10;
  }

  /**
   * Inicialização com detecção ativa
   */
  async initialize() {
    if (this.initializing) {
      logger.info('⏳ Inicialização já em andamento...');
      return;
    }

    this.initializing = true;
    this.connectionAttempts++;
    
    logger.info(`🚀 Inicializando cliente WhatsApp (tentativa ${this.connectionAttempts}/${this.maxConnectionAttempts})...`);

    try {
      // Verificar se sessão está corrompida
      if (this.sessionCorrupted) {
        logger.warn('🗑️ Sessão corrompida detectada, limpando...');
        await this.clearSession();
        this.sessionCorrupted = false;
      }

      // Garantir que diretório de sessão existe
      if (!fs.existsSync(this.sessionPath)) {
        fs.mkdirSync(this.sessionPath, { recursive: true });
      }

      // Buscar versão mais recente do Baileys
      const { version, isLatest } = await fetchLatestBaileysVersion();
      logger.info(`📱 Baileys v${version} (latest=${isLatest})`);

      // Configurar autenticação
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
      this._saveCreds = saveCreds;

      // Verificar se credenciais estão válidas
      if (state.creds && state.creds.registered && !this.isValidSession(state)) {
        logger.warn('⚠️ Credenciais inválidas detectadas, forçando reset...');
        await this.clearSession();
        return this.initialize();
      }

      // Criar socket
      this.sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: false,
        browser: Browsers.macOS('WhatsApp Automation'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        retryRequestDelayMs: 5000,
        maxMsgRetryCount: 3,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        logger: undefined,
        getMessage: async () => ({ conversation: 'Mensagem não encontrada' }),
      });

      this.setupEventListeners();
      this.startMessageQueueProcessor();
      
      // Iniciar monitoramento ativo
      this.startHeartbeat();
      this.startConnectionMonitoring();

      logger.info('✅ Cliente WhatsApp inicializado');
    } catch (error) {
      logger.error('❌ Erro ao inicializar cliente WhatsApp:', error);
      
      // Verificar se é erro de sessão corrompida
      if (this.isSessionCorruptionError(error)) {
        this.sessionCorrupted = true;
      }
      
      this.initializing = false;
      
      // Retry com backoff exponencial
      if (this.connectionAttempts < this.maxConnectionAttempts) {
        const delay = Math.min(this.retryDelay * Math.pow(2, this.connectionAttempts - 1), 60000);
        logger.info(`🔄 Tentando novamente em ${delay}ms...`);
        setTimeout(() => this.initialize().catch(() => {}), delay);
      } else {
        logger.error('❌ Máximo de tentativas de conexão atingido');
        this.emit('max-connection-attempts-reached');
      }
    }
  }

  /**
   * HEARTBEAT - Verificação ativa da conexão
   */
  startHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(async () => {
      if (!this.isConnected || !this.sock) {
        return;
      }

      try {
        logger.debug('💓 Enviando heartbeat...');
        
        // Tentar buscar informações básicas como teste de conectividade
        const startTime = Date.now();
        await this.sock.fetchStatus(this.sock.user.id);
        const responseTime = Date.now() - startTime;
        
        this.lastHeartbeatResponse = Date.now();
        this.missedHeartbeats = 0;
        
        logger.debug(`💓 Heartbeat OK (${responseTime}ms)`);
        
      } catch (error) {
        this.missedHeartbeats++;
        logger.warn(`💔 Heartbeat falhou (${this.missedHeartbeats}/${this.maxMissedHeartbeats}):`, error.message);
        
        if (this.missedHeartbeats >= this.maxMissedHeartbeats) {
          logger.error('💀 Conexão morta detectada via heartbeat');
          await this.handleDeadConnection('heartbeat_failure');
        }
      }
    }, this.heartbeatFrequency);

    logger.info(`💓 Heartbeat iniciado (${this.heartbeatFrequency}ms)`);
  }

  /**
   * MONITORAMENTO DE CONEXÃO - Verificação periódica do estado
   */
  startConnectionMonitoring() {
    if (this.connectionCheckInterval) {
      clearInterval(this.connectionCheckInterval);
    }

    this.connectionCheckInterval = setInterval(async () => {
      await this.checkRealConnectionStatus();
    }, this.connectionCheckFrequency);

    logger.info(`🔍 Monitoramento de conexão iniciado (${this.connectionCheckFrequency}ms)`);
  }

  /**
   * Verificar status real da conexão
   */
  async checkRealConnectionStatus() {
    if (!this.sock) {
      this.realConnectionStatus = false;
      return;
    }

    try {
      // Verificar se WebSocket está realmente conectado
      const wsState = this.sock.ws?.readyState;
      const isWSConnected = wsState === 1; // WebSocket.OPEN
      
      // Verificar se temos user info
      const hasUserInfo = !!this.sock.user;
      
      // Verificar se credenciais estão registradas
      const isRegistered = this.sock.authState?.creds?.registered;
      
      this.realConnectionStatus = isWSConnected && hasUserInfo && isRegistered;
      
      // Detectar inconsistência entre estado interno e real
      if (this.isConnected && !this.realConnectionStatus) {
        logger.warn('⚠️ INCONSISTÊNCIA DETECTADA: Sistema pensa que está conectado mas não está!');
        logger.warn(`WebSocket: ${wsState}, User: ${!!hasUserInfo}, Registered: ${isRegistered}`);
        
        // Forçar reset da conexão
        await this.handleDeadConnection('status_inconsistency');
      }
      
      this.lastConnectionCheck = Date.now();
      
    } catch (error) {
      logger.warn('⚠️ Erro ao verificar status real da conexão:', error.message);
      this.realConnectionStatus = false;
    }
  }

  /**
   * Lidar com conexão morta/inconsistente
   */
  async handleDeadConnection(reason) {
    logger.error(`💀 Conexão morta detectada (${reason}), iniciando reset forçado...`);
    
    // Parar monitoramento
    this.stopMonitoring();
    
    // Marcar como desconectado
    this.isConnected = false;
    this.realConnectionStatus = false;
    this.qrCodeGenerated = false;
    this.currentQRCode = null;
    
    // Emitir evento de desconexão forçada
    this.emit('forced-disconnect', reason);
    
    if (this.forceResetOnDisconnect) {
      // Limpar sessão e reinicializar
      await this.clearSession();
      
      // Aguardar um pouco antes de reinicializar
      setTimeout(() => {
        this.initialize().catch(err => {
          logger.error('❌ Erro na reinicialização após reset forçado:', err);
        });
      }, 3000);
    }
  }

  /**
   * Parar monitoramento
   */
  stopMonitoring() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      logger.info('💓 Heartbeat parado');
    }
    
    if (this.connectionCheckInterval) {
      clearInterval(this.connectionCheckInterval);
      this.connectionCheckInterval = null;
      logger.info('🔍 Monitoramento de conexão parado');
    }
  }

  /**
   * Verificar se sessão é válida
   */
  isValidSession(state) {
    try {
      if (!state.creds || !state.creds.noiseKey || !state.creds.signedIdentityKey) {
        return false;
      }
      
      // Verificar se não é muito antiga (mais de 30 dias)
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      if (state.creds.registrationId && state.creds.registrationId < thirtyDaysAgo) {
        return false;
      }
      
      return true;
    } catch (error) {
      logger.warn('⚠️ Erro ao validar sessão:', error.message);
      return false;
    }
  }

  /**
   * Verificar se erro indica sessão corrompida
   */
  isSessionCorruptionError(error) {
    const corruptionIndicators = [
      'ENOENT',
      'EACCES',
      'EISDIR',
      'invalid session',
      'corrupted',
      'malformed',
      'unexpected token',
      'JSON',
      'parse error'
    ];
    
    const errorMessage = error.message?.toLowerCase() || '';
    return corruptionIndicators.some(indicator => errorMessage.includes(indicator));
  }

  /**
   * Eventos do Baileys com detecção aprimorada
   */
  setupEventListeners() {
    if (!this.sock) return;

    // Salvar credenciais sempre que alteradas
    if (this._saveCreds) {
      this.sock.ev.on('creds.update', this._saveCreds);
    }

    // Conexão com detecção aprimorada
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Pairing code quando não registrado e permitido por env
      if (!this.isConnected && !this.sock.authState.creds.registered && this.usePairingCode) {
        await this._tryRequestPairingCodeOnce();
      }

      // QR Code - SEMPRE gerar quando disponível
      if (qr) {
        this.currentQRCode = qr;
        this.qrCodeGenerated = true;
        logger.info('📱 QR Code gerado! Escaneie no WhatsApp.');
        qrcode.generate(qr, { small: true });
        this.emit('qr-code', qr);
      }

      if (connection === 'open') {
        this.isConnected = true;
        this.realConnectionStatus = true;
        this.currentRetry = 0;
        this.connectionAttempts = 0;
        this.qrCodeGenerated = false;
        this.currentQRCode = null;
        this.currentPairingCode = null;
        this.lastSuccessfulConnection = Date.now();
        this.resetCircuitBreaker();
        this.initializing = false;
        
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
        this.realConnectionStatus = false;
        this.qrCodeGenerated = false;
        this.initializing = false;
        
        // Parar monitoramento quando desconectado
        this.stopMonitoring();

        const statusCode =
          lastDisconnect?.error?.output?.statusCode ??
          lastDisconnect?.error?.status ??
          lastDisconnect?.statusCode ??
          lastDisconnect?.code;

        const loggedOut = statusCode === DisconnectReason.loggedOut;
        const restartRequired = statusCode === DisconnectReason.restartRequired;
        const connectionLost = statusCode === DisconnectReason.connectionLost;
        
        logger.warn(`🔌 Conexão fechada (code=${statusCode}). loggedOut=${loggedOut}, restart=${restartRequired}, lost=${connectionLost}`);

        if (loggedOut || restartRequired) {
          // Desconexão definitiva - limpar sessão e forçar novo QR
          logger.info('🗑️ Desconexão definitiva detectada, limpando sessão...');
          await this.clearSession();
          this.emit('logged-out');
          
          // Reinicializar após limpeza
          setTimeout(() => {
            this.initialize().catch(() => {});
          }, 2000);
          return;
        }

        // Reconexão automática para outros tipos de desconexão
        this.handleReconnection();
      }
    });

    // Mensagens recebidas (debug)
    this.sock.ev.on('messages.upsert', (m) => {
      if (m?.messages?.length) {
        logger.debug(`📩 ${m.messages.length} mensagem(ns) recebida(s)`);
        // Atualizar timestamp da última atividade
        this.lastHeartbeatResponse = Date.now();
      }
    });
  }

  /**
   * Reconexão com lógica aprimorada
   */
  handleReconnection() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const delay = Math.min(this.retryDelay * Math.pow(2, this.currentRetry), 30000);
    logger.info(`🔄 Reconectando em ${delay}ms (tentativa ${this.currentRetry + 1}/${this.retryAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      if (this.currentRetry < this.retryAttempts) {
        this.currentRetry++;
        await this.initialize();
      } else {
        logger.error('❌ Máximo de tentativas de reconexão atingido, forçando reset completo...');
        await this.clearSession();
        this.currentRetry = 0;
        this.emit('max-retries-reached');
        
        // Tentar uma última vez após reset
        setTimeout(() => {
          this.initialize().catch(() => {});
        }, 5000);
      }
    }, delay);
  }

  /**
   * Limpeza de sessão aprimorada
   */
  async clearSession() {
    logger.info('🗑️ Limpando sessão WhatsApp...');
    
    // Parar monitoramento
    this.stopMonitoring();
    
    // Desconectar primeiro
    if (this.sock) {
      await this.disconnect();
    }

    try {
      // Remover arquivos de sessão
      if (fs.existsSync(this.sessionPath)) {
        fs.rmSync(this.sessionPath, { recursive: true, force: true });
        logger.info('✅ Arquivos de sessão removidos');
      }
    } catch (e) {
      logger.warn('⚠️ Erro ao remover sessão:', e?.message);
    }

    // Reset completo de estados
    this.qrCodeGenerated = false;
    this.currentQRCode = null;
    this.currentPairingCode = null;
    this.currentRetry = 0;
    this.connectionAttempts = 0;
    this.isConnected = false;
    this.realConnectionStatus = false;
    this.initializing = false;
    this.sessionCorrupted = false;
    this.lastSuccessfulConnection = null;
    this.lastHeartbeatResponse = null;
    this.missedHeartbeats = 0;
    this.resetCircuitBreaker();
    
    logger.info('🔄 Estados resetados - pronto para nova inicialização');
  }

  /**
   * Método para forçar geração de QR Code
   */
  async forceQRGeneration() {
    logger.info('🔄 Forçando geração de QR Code...');
    
    // Parar monitoramento
    this.stopMonitoring();
    
    // Limpar sessão completamente
    await this.clearSession();
    
    // Aguardar um pouco
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Garantir modo QR
    this.usePairingCode = false;
    
    // Reinicializar
    await this.initialize();
    
    // Aguardar geração do QR
    let attempts = 0;
    const maxAttempts = 15;
    
    while (!this.qrCodeGenerated && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      attempts++;
      logger.info(`⏳ Aguardando QR Code... (${attempts}/${maxAttempts})`);
    }
    
    if (this.qrCodeGenerated) {
      logger.info('✅ QR Code gerado com sucesso!');
      return true;
    } else {
      logger.error('❌ QR Code não foi gerado após tentativas');
      return false;
    }
  }

  /**
   * Status de conexão detalhado
   */
  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      realConnectionStatus: this.realConnectionStatus,
      qrCodeGenerated: this.qrCodeGenerated,
      currentRetry: this.currentRetry,
      maxRetries: this.retryAttempts,
      circuitBreakerState: this.circuitBreakerState,
      failureCount: this.failureCount,
      queueLength: this.messageQueue.length,
      user: this.sock?.user || null,
      connectionAttempts: this.connectionAttempts,
      maxConnectionAttempts: this.maxConnectionAttempts,
      lastSuccessfulConnection: this.lastSuccessfulConnection,
      lastHeartbeatResponse: this.lastHeartbeatResponse,
      missedHeartbeats: this.missedHeartbeats,
      lastConnectionCheck: this.lastConnectionCheck,
      sessionCorrupted: this.sessionCorrupted,
      heartbeatActive: !!this.heartbeatInterval,
      monitoringActive: !!this.connectionCheckInterval
    };
  }

  /**
   * Diagnóstico completo da conexão
   */
  async getDiagnostics() {
    const status = this.getConnectionStatus();
    
    const diagnostics = {
      ...status,
      timestamp: new Date().toISOString(),
      sessionPath: this.sessionPath,
      sessionExists: fs.existsSync(this.sessionPath),
      sessionFiles: [],
      websocketState: null,
      authState: null
    };

    // Verificar arquivos de sessão
    if (diagnostics.sessionExists) {
      try {
        diagnostics.sessionFiles = fs.readdirSync(this.sessionPath);
      } catch (e) {
        diagnostics.sessionFiles = ['Error reading session files'];
      }
    }

    // Estado do WebSocket
    if (this.sock?.ws) {
      diagnostics.websocketState = this.sock.ws.readyState;
    }

    // Estado de autenticação
    if (this.sock?.authState) {
      diagnostics.authState = {
        registered: this.sock.authState.creds?.registered,
        hasNoiseKey: !!this.sock.authState.creds?.noiseKey,
        hasSignedIdentityKey: !!this.sock.authState.creds?.signedIdentityKey
      };
    }

    return diagnostics;
  }

  /**
   * Pairing code (fallback)
   */
  async _tryRequestPairingCodeOnce() {
    if (this.currentPairingCode) return;
    
    try {
      const phone = process.env.WHATSAPP_PHONE_NUMBER?.replace(/\D/g, '');
      if (!phone || phone.length < 10) return;
      
      const code = await this.sock.requestPairingCode(phone);
      this.currentPairingCode = code;
      logger.info(`📱 Pairing Code: ${code}`);
      this.emit('pairing-code', code);
    } catch (e) {
      logger.warn('⚠️ Erro ao solicitar pairing code:', e?.message);
    }
  }

  /**
   * Desconectar
   */
  async disconnect() {
    // Parar monitoramento
    this.stopMonitoring();
    
    if (!this.sock) return;
    
    try {
      await this.sock.logout();
    } catch (e) {
      logger.warn('⚠️ Erro ao deslogar (ignorando):', e?.message);
    }
    
    this.isConnected = false;
    this.realConnectionStatus = false;
    this.sock = null;
    logger.info('✅ Desconectado');
  }

  /**
   * Processamento da fila de mensagens
   */
  startMessageQueueProcessor() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    const loop = async () => {
      try {
        if (this.messageQueue.length === 0 || this.circuitBreakerState === 'OPEN') {
          setTimeout(loop, this.messageInterval);
          return;
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
   * Enfileirar mensagem com imagem
   */
  async sendImageMessage(groupJid, imagePath, caption, options = {}) {
    return new Promise((resolve, reject) => {
      const messageData = { groupJid, imagePath, caption, options, resolve, reject, ts: Date.now() };
      this.messageQueue.push(messageData);
      logger.info(`📤 Mensagem enfileirada (pos=${this.messageQueue.length})`);
    });
  }

  /**
   * Processar mensagem da fila
   */
  async processMessage({ groupJid, imagePath, caption, options, resolve, reject }) {
    try {
      if (!fs.existsSync(imagePath)) {
        throw new Error(`Arquivo de imagem não encontrado: ${imagePath}`);
      }

      const imageBuffer = fs.readFileSync(imagePath);
      const result = await this.sock.sendMessage(groupJid, { image: imageBuffer, caption, ...options });

      logger.info(`✅ Mensagem enviada para ${groupJid}`);
      resolve(result);
    } catch (error) {
      this.recordFailure();
      logger.error(`❌ Falha ao enviar para ${groupJid}:`, error);
      reject(error);
    }
  }

  /**
   * Circuit breaker - registrar falha
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
   * Circuit breaker - reset
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
    if (!this.isConnected || !this.realConnectionStatus) {
      throw new Error('WhatsApp não está conectado');
    }
    
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      try {
        logger.info(`🔍 Buscando grupos (tentativa ${attempts + 1}/${maxAttempts})...`);
        
        if (attempts > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        const groups = await this.sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).map((g) => ({
          jid: g.id,
          nome: g.subject,
          participantes: g.participants?.length || 0,
          isAdmin: g.participants?.some(
            (p) => p.id === this.sock.user?.id && (p.admin === 'admin' || p.admin === 'superadmin')
          ) || false,
        }));

        logger.info(`✅ ${groupList.length} grupos encontrados`);
        return groupList;
      } catch (error) {
        attempts++;
        logger.warn(`⚠️ Erro ao buscar grupos (tentativa ${attempts}):`, error.message);
        
        // Se falhar, pode indicar conexão morta
        if (attempts >= maxAttempts) {
          logger.error('❌ Falha ao buscar grupos pode indicar conexão morta');
          await this.handleDeadConnection('groups_fetch_failure');
          throw new Error(`Falha ao buscar grupos após ${maxAttempts} tentativas: ${error.message}`);
        }
      }
    }
  }
}

module.exports = WhatsAppClient;

