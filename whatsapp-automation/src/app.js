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
    this.server = null;
    this.whatsappClient = null;
    this.jobScheduler = null;

    // Estado
    this.initialized = false;
    this.shuttingDown = false;

    // Config
    this.port = process.env.PORT || 3000;
    this.nodeEnv = process.env.NODE_ENV || 'development';
    this.trustProxy = process.env.TRUST_PROXY === 'true';
  }

  /**
   * Inicialização completa do app
   */
  async initialize() {
    if (this.initialized) return;
    logger.info('🚀 Inicializando aplicação...');

    // Express base
    await this.setupMiddleware();
    await this.setupSecurity();
    await this.setupRateLimits();

    // Infra básica
    await this.initializeDatabase();

    // WhatsApp
    await this.initializeWhatsApp();

    // Agendador (se existir no projeto)
    await this.initializeJobs();

    // Rotas
    await this.setupRoutes();

    // Erros e sinais
    await this.setupErrorHandlers();

    // Start HTTP
    await this.startServer();

    this.initialized = true;
    logger.info('✅ Aplicação inicializada com sucesso');
  }

  /**
   * DB
   */
  async initializeDatabase() {
    try {
      await database.initialize();
      logger.info('🟢 Banco de dados pronto');
    } catch (error) {
      logger.error('❌ Erro ao inicializar banco:', error);
      throw error;
    }
  }

  /**
   * Jobs
   */
  async initializeJobs() {
    try {
      this.jobScheduler = new JobScheduler();
      await this.jobScheduler.initialize();
      this.app.locals.jobScheduler = this.jobScheduler;
      logger.info('🟢 Job scheduler pronto');
    } catch (error) {
      logger.warn('⚠️ Job scheduler não inicializado:', error?.message);
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

    // Body
    this.app.use(express.json({ limit: '2mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '2mb' }));

    // Sessão (somente se o admin usar)
    this.app.set('trust proxy', this.trustProxy);
    this.app.use(
      session({
        secret: process.env.JWT_SECRET || 'dev-secret',
        resave: false,
        saveUninitialized: false,
        cookie: {
          httpOnly: true,
          sameSite: 'lax',
          secure: this.nodeEnv === 'production',
          maxAge: 1000 * 60 * 60 * 12, // 12h
        },
      })
    );

    // Estáticos
    this.app.use('/public', express.static(path.join(__dirname, '..', 'public')));
  }

  async setupSecurity() {
    // Nada adicional por enquanto
  }

  async setupRateLimits() {
    const limiter = rateLimit({
      windowMs: 60 * 1000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
    });
    this.app.use(limiter);
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
