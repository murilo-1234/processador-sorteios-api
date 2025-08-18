require('dotenv').config();

// 🔧 CORREÇÃO CRYPTO PARA RENDER - Polyfill para globalThis.crypto
if (!globalThis.crypto) {
  try {
    const { webcrypto } = require('crypto');
    globalThis.crypto = webcrypto;
    console.log('✅ Crypto polyfill aplicado com sucesso no app.js');
  } catch (error) {
    console.log('⚠️ Fallback crypto polyfill no app.js');
    globalThis.crypto = {
      subtle: require('crypto').webcrypto?.subtle || {},
      getRandomValues: (arr) => {
        const crypto = require('crypto');
        const bytes = crypto.randomBytes(arr.length);
        arr.set(bytes);
        return arr;
      }
    };
  }
}

const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');

const logger = require('./config/logger');
const database = require('./config/database');
const WhatsAppClient = require('./services/whatsapp-client');
const JobScheduler = require('./services/job-scheduler');
const metricsService = require('./services/metrics');

class App {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;
    this.whatsappClient = null;
    this.jobScheduler = null;
    this.server = null;

    // Handlers de processo (sem derrubar o app em exceções)
    this.setupProcessHandlers();
  }

  /**
   * Inicializar aplicação
   */
  async initialize() {
    try {
      logger.info('🚀 Inicializando aplicação WhatsApp Automation...');

      // 1) Middleware
      await this.setupMiddleware();

      // 2) Banco
      await database.initialize();
      metricsService.setDatabaseConnections(1);

      // 3) Rotas
      await this.setupRoutes();

      // 4) WhatsApp
      await this.initializeWhatsApp();

      // 5) Agendador
      await this.initializeScheduler();

      // 6) Servidor
      await this.startServer();

      logger.info('✅ Aplicação inicializada com sucesso!');
    } catch (error) {
      // ❗ Não finalize o processo; faça retry após alguns segundos
      logger.error('❌ Erro ao inicializar aplicação (tentando novamente em 10s):', error);
      setTimeout(() => this.initialize().catch(() => {}), 10_000);
    }
  }

  /**
   * Middleware
   */
  async setupMiddleware() {
    // Segurança
    this.app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
            scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
            imgSrc: ["'self'", 'data:', 'https:'],
          },
        },
      })
    );

    // CORS (liberar no dev; em prod troque pelo seu domínio)
    this.app.use(
      cors({
        origin: process.env.NODE_ENV === 'production' ? ['https://seu-dominio.com'] : true,
        credentials: true,
      })
    );

    // Rate limiting
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      message: 'Muitas requisições deste IP, tente novamente em 15 minutos.',
      standardHeaders: true,
      legacyHeaders: false,
    });
    this.app.use('/api/', limiter);

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Sessões
    this.app.use(
      session({
        secret: process.env.JWT_SECRET || 'whatsapp-automation-secret',
        resave: false,
        saveUninitialized: false,
        cookie: {
          secure: process.env.NODE_ENV === 'production',
          httpOnly: true,
          maxAge: 24 * 60 * 60 * 1000,
        },
      })
    );

    // Arquivos estáticos
    this.app.use(express.static(path.join(__dirname, '../public')));

    // Métricas middleware
    this.app.use(metricsService.getExpressMiddleware());

    // Logging de requisições
    this.app.use((req, res, next) => {
      logger.info(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });
      next();
    });

    logger.info('✅ Middleware configurado');
  }

  /**
   * Rotas
   */
  async setupRoutes() {
    // Health check
    this.app.get('/health', async (req, res) => {
      try {
        const health = await this.getHealthStatus();
        const status = health.status === 'healthy' ? 200 : 503;
        res.status(status).json(health);
      } catch (error) {
        res.status(503).json({
          status: 'error',
          error: error.message,
        });
      }
    });

    // Métricas
    this.app.get('/metrics', async (req, res) => {
      try {
        const metrics = await metricsService.getMetrics();
        res.set('Content-Type', 'text/plain');
        res.send(metrics);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // API
    const apiRoutes = require('./routes/api');
    this.app.use('/api', apiRoutes);

    // Admin
    const adminRoutes = require('./routes/admin');
    this.app.use('/admin', adminRoutes);

    // QR Code
    this.app.get('/qr', async (req, res) => {
      try {
        if (!this.whatsappClient) {
          return res.status(503).json({
            error: 'WhatsApp client não inicializado',
            message: 'Aguarde a inicialização do sistema',
          });
        }

        const qrData = await this.whatsappClient.getQRCode();

        if (!qrData) {
          return res.status(404).json({
            error: 'QR Code não disponível',
            message: 'WhatsApp pode já estar conectado ou aguardando conexão',
          });
        }

        const qrcode = require('qrcode');
        const qrSvg = await qrcode.toString(qrData, {
          type: 'svg',
          width: 300,
          margin: 2,
        });

        res.setHeader('Content-Type', 'image/svg+xml');
        res.send(qrSvg);
      } catch (error) {
        logger.error('❌ Erro ao gerar QR Code:', error);
        res.status(500).json({
          error: 'Erro ao gerar QR Code',
          message: error.message,
        });
      }
    });

    // Pairing Code
    this.app.get('/code', async (req, res) => {
      try {
        if (!this.whatsappClient) {
          return res.status(503).json({
            error: 'WhatsApp client não inicializado',
            message: 'Aguarde a inicialização do sistema',
          });
        }

        const pairingCode = this.whatsappClient.getPairingCode();

        if (!pairingCode) {
          return res.status(404).json({
            error: 'Pairing code não disponível',
            message: 'WhatsApp pode já estar conectado ou aguardando geração do código',
          });
        }

        res.json({
          pairingCode,
          instructions: [
            '1. Abra o WhatsApp no seu celular',
            '2. Vá em: Aparelhos Conectados',
            '3. Toque em: "Conectar com código"',
            `4. Digite: ${pairingCode}`,
            '5. Pronto! WhatsApp conectado.',
          ],
          timestamp: new Date().toISOString(),
          status: 'available',
        });
      } catch (error) {
        logger.error('❌ Erro ao obter pairing code:', error);
        res.status(500).json({
          error: 'Erro ao obter pairing code',
          message: error.message,
        });
      }
    });

    // Página inicial
    this.app.get('/', (req, res) => {
      res.json({
        name: 'WhatsApp Automation System',
        version: '1.0.0',
        status: 'running',
        timestamp: new Date().toISOString(),
      });
    });

    // 404
    this.app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Endpoint não encontrado',
        path: req.originalUrl,
      });
    });

    // Handler de erros
    this.app.use((error, req, res, next) => {
      logger.error('❌ Erro na aplicação:', error);

      res.status(error.status || 500).json({
        error: process.env.NODE_ENV === 'production' ? 'Erro interno do servidor' : error.message,
        timestamp: new Date().toISOString(),
      });
    });

    logger.info('✅ Rotas configuradas');
  }

  /**
   * WhatsApp
   */
  async initializeWhatsApp() {
    this.whatsappClient = new WhatsAppClient();

    // Eventos
    this.whatsappClient.on('connected', () => {
      logger.info('✅ WhatsApp conectado');
      metricsService.setBaileyConnectionState(true);
    });

    this.whatsappClient.on('qr-code', () => {
      logger.info('📱 QR Code gerado para autenticação');
    });

    this.whatsappClient.on('pairing-code', (code) => {
      logger.info('🔗 Pairing Code gerado para autenticação');
      logger.info(`📱 Código: ${code}`);
      logger.info('💡 Acesse: /code para visualizar');
    });

    this.whatsappClient.on('logged-out', () => {
      logger.warn('⚠️ WhatsApp deslogado');
      metricsService.setBaileyConnectionState(false);
    });

    this.whatsappClient.on('circuit-breaker-open', () => {
      logger.error('🔴 Circuit breaker aberto - muitas falhas no WhatsApp');
      metricsService.recordAlertSent('circuit_breaker', 'system');
    });

    await this.whatsappClient.initialize();

    // Disponibilizar globalmente
    this.app.locals.whatsappClient = this.whatsappClient;

    logger.info('✅ WhatsApp inicializado');
  }

  /**
   * Agendador
   */
  async initializeScheduler() {
    this.jobScheduler = new JobScheduler();

    this.jobScheduler.on('job-error', (data) => {
      logger.error(`❌ Erro no job ${data.name}:`, data.error);
      metricsService.recordAlertSent('job_error', 'system');
    });

    this.jobScheduler.on('high-failure-rate', (data) => {
      logger.warn(`⚠️ Alta taxa de falhas detectada: ${data.count} jobs falharam na última hora`);
      metricsService.recordAlertSent('high_failure_rate', 'system');
    });

    await this.jobScheduler.initialize();

    this.app.locals.jobScheduler = this.jobScheduler;

    logger.info('✅ Agendador inicializado');
  }

  /**
   * Servidor
   */
  async startServer() {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, '0.0.0.0', (error) => {
        if (error) return reject(error);

        logger.info(`🌐 Servidor rodando na porta ${this.port}`);
        logger.info(`📊 Métricas: http://localhost:${this.port}/metrics`);
        logger.info(`🏥 Health:   http://localhost:${this.port}/health`);
        resolve();
      });
    });
  }

  /**
   * Health status
   */
  async getHealthStatus() {
    const checks = {
      database: await database.healthCheck(),
      whatsapp: {
        status: this.whatsappClient?.isConnected ? 'ok' : 'error',
        connected: this.whatsappClient?.isConnected || false,
        queueLength: this.whatsappClient?.messageQueue?.length || 0,
      },
      scheduler: {
        status: this.jobScheduler?.isInitialized ? 'ok' : 'error',
        jobsCount: this.jobScheduler?.jobs?.size || 0,
      },
      memory: this.getMemoryStatus(),
      uptime: process.uptime(),
    };

    const isHealthy = Object.values(checks).every((check) =>
      typeof check === 'object' ? check.status === 'ok' : true
    );

    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  /**
   * Memória
   */
  getMemoryStatus() {
    const used = process.memoryUsage();
    const totalMB = used.rss / 1024 / 1024;

    return {
      status: totalMB < 800 ? 'ok' : 'warning',
      memory_usage_mb: +totalMB.toFixed(2),
      heap_used_mb: +(used.heapUsed / 1024 / 1024).toFixed(2),
      heap_total_mb: +(used.heapTotal / 1024 / 1024).toFixed(2),
    };
  }

  /**
   * Handlers do processo (sem derrubar o app)
   */
  setupProcessHandlers() {
    // Encerramentos "legais" continuam chamando shutdown
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));

    // ❗ Em exceções/rejeições, só logar e manter no ar
    process.on('uncaughtException', (error) => {
      logger.error('❌ Uncaught Exception (mantendo serviço no ar):', error);
      // sem process.exit()
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('❌ Unhandled Rejection (mantendo serviço no ar):', reason);
      // sem process.exit()
    });
  }

  /**
   * Shutdown graceful
   */
  async shutdown(signal) {
    logger.info(`🔄 Recebido sinal ${signal}. Iniciando shutdown graceful...`);
    try {
      if (this.server) this.server.close();
      if (this.jobScheduler) this.jobScheduler.stopAll();
      if (this.whatsappClient) await this.whatsappClient.disconnect();
      await database.close();
      logger.info('✅ Shutdown graceful concluído');
      process.exit(0);
    } catch (error) {
      logger.error('❌ Erro durante shutdown:', error);
      process.exit(1);
    }
  }
}

// Inicializar aplicação se executado diretamente
if (require.main === module) {
  const app = new App();
  app.initialize().catch((error) => {
    // ❗ Não sair; agendar retry
    logger.error('❌ Falha ao inicializar (retry em 10s):', error);
    setTimeout(() => app.initialize().catch(() => {}), 10_000);
  });
}

module.exports = App;
