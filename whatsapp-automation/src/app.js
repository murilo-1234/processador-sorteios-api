require('dotenv').config();

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
    
    // Configurar handlers de processo
    this.setupProcessHandlers();
  }

  /**
   * Inicializar aplicação
   */
  async initialize() {
    try {
      logger.info('🚀 Inicializando aplicação WhatsApp Automation...');
      
      // 1. Configurar middleware
      await this.setupMiddleware();
      
      // 2. Inicializar banco de dados
      await database.initialize();
      metricsService.setDatabaseConnections(1);
      
      // 3. Configurar rotas
      await this.setupRoutes();
      
      // 4. Inicializar WhatsApp
      await this.initializeWhatsApp();
      
      // 5. Inicializar agendador
      await this.initializeScheduler();
      
      // 6. Iniciar servidor
      await this.startServer();
      
      logger.info('✅ Aplicação inicializada com sucesso!');
      
    } catch (error) {
      logger.error('❌ Erro ao inicializar aplicação:', error);
      process.exit(1);
    }
  }

  /**
   * Configurar middleware
   */
  async setupMiddleware() {
    // Segurança
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
          scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
          imgSrc: ["'self'", "data:", "https:"],
        },
      },
    }));

    // CORS
    this.app.use(cors({
      origin: process.env.NODE_ENV === 'production' 
        ? ['https://seu-dominio.com'] 
        : true,
      credentials: true
    }));

    // Rate limiting
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutos
      max: 100, // máximo 100 requests por IP
      message: 'Muitas requisições deste IP, tente novamente em 15 minutos.',
      standardHeaders: true,
      legacyHeaders: false,
    });
    this.app.use('/api/', limiter);

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Sessões
    this.app.use(session({
      secret: process.env.JWT_SECRET || 'whatsapp-automation-secret',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 horas
      }
    }));

    // Arquivos estáticos
    this.app.use(express.static(path.join(__dirname, '../public')));

    // Métricas middleware
    this.app.use(metricsService.getExpressMiddleware());

    // Logging de requisições
    this.app.use((req, res, next) => {
      logger.info(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      next();
    });

    logger.info('✅ Middleware configurado');
  }

  /**
   * Configurar rotas
   */
  async setupRoutes() {
    // Rota de health check
    this.app.get('/health', async (req, res) => {
      try {
        const health = await this.getHealthStatus();
        const status = health.status === 'healthy' ? 200 : 503;
        res.status(status).json(health);
      } catch (error) {
        res.status(503).json({
          status: 'error',
          error: error.message
        });
      }
    });

    // Rota de métricas
    this.app.get('/metrics', async (req, res) => {
      try {
        const metrics = await metricsService.getMetrics();
        res.set('Content-Type', 'text/plain');
        res.send(metrics);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Rotas da API
    const apiRoutes = require('./routes/api');
    this.app.use('/api', apiRoutes);

    // Rotas do admin
    const adminRoutes = require('./routes/admin');
    this.app.use('/admin', adminRoutes);

    // Rota para QR Code do WhatsApp
    this.app.get('/qr', async (req, res) => {
      try {
        if (!this.whatsappClient) {
          return res.status(503).json({
            error: 'WhatsApp client não inicializado',
            message: 'Aguarde a inicialização do sistema'
          });
        }

        const qrData = await this.whatsappClient.getQRCode();
        
        if (!qrData) {
          return res.status(404).json({
            error: 'QR Code não disponível',
            message: 'WhatsApp pode já estar conectado ou aguardando conexão'
          });
        }

        // Retornar QR Code como SVG
        const qrcode = require('qrcode');
        const qrSvg = await qrcode.toString(qrData, { 
          type: 'svg',
          width: 300,
          margin: 2
        });

        res.setHeader('Content-Type', 'image/svg+xml');
        res.send(qrSvg);

      } catch (error) {
        logger.error('❌ Erro ao gerar QR Code:', error);
        res.status(500).json({
          error: 'Erro ao gerar QR Code',
          message: error.message
        });
      }
    });

    // Página inicial
    this.app.get('/', (req, res) => {
      res.json({
        name: 'WhatsApp Automation System',
        version: '1.0.0',
        status: 'running',
        timestamp: new Date().toISOString()
      });
    });

    // Handler de 404
    this.app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Endpoint não encontrado',
        path: req.originalUrl
      });
    });

    // Handler de erros
    this.app.use((error, req, res, next) => {
      logger.error('❌ Erro na aplicação:', error);
      
      res.status(error.status || 500).json({
        error: process.env.NODE_ENV === 'production' 
          ? 'Erro interno do servidor' 
          : error.message,
        timestamp: new Date().toISOString()
      });
    });

    logger.info('✅ Rotas configuradas');
  }

  /**
   * Inicializar WhatsApp
   */
  async initializeWhatsApp() {
    this.whatsappClient = new WhatsAppClient();
    
    // Configurar event listeners
    this.whatsappClient.on('connected', () => {
      logger.info('✅ WhatsApp conectado');
      metricsService.setBaileyConnectionState(true);
    });

    this.whatsappClient.on('qr-code', (qr) => {
      logger.info('📱 QR Code gerado para autenticação');
      // QR code já é exibido no console pelo cliente
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
   * Inicializar agendador
   */
  async initializeScheduler() {
    this.jobScheduler = new JobScheduler();
    
    // Configurar event listeners
    this.jobScheduler.on('job-error', (data) => {
      logger.error(`❌ Erro no job ${data.name}:`, data.error);
      metricsService.recordAlertSent('job_error', 'system');
    });

    this.jobScheduler.on('high-failure-rate', (data) => {
      logger.warn(`⚠️ Alta taxa de falhas detectada: ${data.count} jobs falharam na última hora`);
      metricsService.recordAlertSent('high_failure_rate', 'system');
    });

    await this.jobScheduler.initialize();
    
    // Disponibilizar globalmente
    this.app.locals.jobScheduler = this.jobScheduler;
    
    logger.info('✅ Agendador inicializado');
  }

  /**
   * Iniciar servidor
   */
  async startServer() {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, '0.0.0.0', (error) => {
        if (error) {
          reject(error);
        } else {
          logger.info(`🌐 Servidor rodando na porta ${this.port}`);
          logger.info(`📊 Métricas disponíveis em: http://localhost:${this.port}/metrics`);
          logger.info(`🏥 Health check em: http://localhost:${this.port}/health`);
          resolve();
        }
      });
    });
  }

  /**
   * Obter status de saúde
   */
  async getHealthStatus() {
    const checks = {
      database: await database.healthCheck(),
      whatsapp: {
        status: this.whatsappClient?.isConnected ? 'ok' : 'error',
        connected: this.whatsappClient?.isConnected || false,
        queueLength: this.whatsappClient?.messageQueue?.length || 0
      },
      scheduler: {
        status: this.jobScheduler?.isInitialized ? 'ok' : 'error',
        jobsCount: this.jobScheduler?.jobs?.size || 0
      },
      memory: this.getMemoryStatus(),
      uptime: process.uptime()
    };

    const isHealthy = Object.values(checks).every(check => 
      typeof check === 'object' ? check.status === 'ok' : true
    );

    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      checks
    };
  }

  /**
   * Obter status de memória
   */
  getMemoryStatus() {
    const used = process.memoryUsage();
    const totalMB = used.rss / 1024 / 1024;
    
    return {
      status: totalMB < 800 ? 'ok' : 'warning',
      memory_usage_mb: +totalMB.toFixed(2),
      heap_used_mb: +(used.heapUsed / 1024 / 1024).toFixed(2),
      heap_total_mb: +(used.heapTotal / 1024 / 1024).toFixed(2)
    };
  }

  /**
   * Configurar handlers de processo
   */
  setupProcessHandlers() {
    // Graceful shutdown
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));

    // Uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('❌ Uncaught Exception:', error);
      this.shutdown('uncaughtException');
    });

    // Unhandled rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
      this.shutdown('unhandledRejection');
    });
  }

  /**
   * Shutdown graceful
   */
  async shutdown(signal) {
    logger.info(`🔄 Recebido sinal ${signal}. Iniciando shutdown graceful...`);

    try {
      // Parar de aceitar novas conexões
      if (this.server) {
        this.server.close();
      }

      // Parar agendador
      if (this.jobScheduler) {
        this.jobScheduler.stopAll();
      }

      // Desconectar WhatsApp
      if (this.whatsappClient) {
        await this.whatsappClient.disconnect();
      }

      // Fechar banco de dados
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
    logger.error('❌ Falha ao inicializar aplicação:', error);
    process.exit(1);
  });
}

module.exports = App;

