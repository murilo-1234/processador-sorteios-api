const cron = require('node-cron');
const logger = require('../config/logger');
const DateUtils = require('../utils/date');
const database = require('../config/database');

class JobScheduler {
  constructor() {
    this.jobs = new Map();
    this.isInitialized = false;
    this.timezone = process.env.CRON_TIMEZONE || 'America/Sao_Paulo';
  }

  /**
   * Inicializar agendador
   */
  async initialize() {
    if (this.isInitialized) return;

    try {
      logger.info('⏰ Inicializando agendador de jobs...');
      
      // Registrar job principal de sorteios (18:15)
      this.scheduleJob('sorteios-diarios', {
        schedule: process.env.CRON_SCHEDULE_SORTEIOS || '15 18 * * *',
        timezone: this.timezone,
        handler: this.handleSorteiosJob.bind(this),
        description: 'Processamento diário de sorteios às 18:15'
      });

      // Job de limpeza (meia-noite)
      this.scheduleJob('limpeza-diaria', {
        schedule: '0 0 * * *',
        timezone: this.timezone,
        handler: this.handleLimpezaJob.bind(this),
        description: 'Limpeza diária de dados antigos'
      });

      // Job de health check (a cada 5 minutos)
      this.scheduleJob('health-check', {
        schedule: '*/5 * * * *',
        timezone: this.timezone,
        handler: this.handleHealthCheckJob.bind(this),
        description: 'Verificação de saúde do sistema'
      });

      this.isInitialized = true;
      logger.info(`✅ Agendador inicializado com ${this.jobs.size} jobs`);
      
    } catch (error) {
      logger.error('❌ Erro ao inicializar agendador:', error);
      throw error;
    }
  }

  /**
   * Agendar um job
   */
  scheduleJob(name, config) {
    const { schedule, timezone, handler, description, immediate = false } = config;

    if (this.jobs.has(name)) {
      logger.warn(`⚠️ Job '${name}' já existe. Substituindo...`);
      this.jobs.get(name).destroy();
    }

    // Validar expressão cron
    if (!cron.validate(schedule)) {
      throw new Error(`Expressão cron inválida para job '${name}': ${schedule}`);
    }

    const task = cron.schedule(schedule, async () => {
      await this.executeJob(name, handler);
    }, {
      scheduled: true,
      timezone: timezone
    });

    this.jobs.set(name, {
      task,
      config,
      lastRun: null,
      nextRun: this.getNextRun(schedule, timezone),
      runCount: 0,
      errorCount: 0
    });

    logger.info(`📅 Job '${name}' agendado: ${schedule} (${description})`);

    // Executar imediatamente se solicitado
    if (immediate) {
      setImmediate(() => this.executeJob(name, handler));
    }

    return task;
  }

  /**
   * Executar um job
   */
  async executeJob(name, handler) {
    const jobInfo = this.jobs.get(name);
    if (!jobInfo) {
      logger.error(`❌ Job '${name}' não encontrado`);
      return;
    }

    const startTime = Date.now();
    const executionId = `${name}-${Date.now()}`;

    try {
      logger.job(name, 'STARTED', { executionId, timestamp: DateUtils.logTimestamp() });
      
      // Registrar no banco
      const db = await database.getConnection();
      await db.run(`
        INSERT INTO job_executions (job_type, dedupe_key, payload_json, status, started_at)
        VALUES (?, ?, ?, 'running', datetime('now', 'utc'))
      `, [name, executionId, JSON.stringify({ executionId })]);

      // Executar handler
      await handler(executionId);

      // Atualizar estatísticas
      const duration = Date.now() - startTime;
      jobInfo.lastRun = new Date();
      jobInfo.runCount++;
      jobInfo.nextRun = this.getNextRun(jobInfo.config.schedule, jobInfo.config.timezone);

      // Atualizar no banco
      await db.run(`
        UPDATE job_executions 
        SET status = 'done', finished_at = datetime('now', 'utc')
        WHERE job_type = ? AND dedupe_key = ?
      `, [name, executionId]);

      logger.job(name, 'COMPLETED', { 
        executionId, 
        duration: DateUtils.formatarDuracao(duration),
        nextRun: jobInfo.nextRun
      });

    } catch (error) {
      const duration = Date.now() - startTime;
      jobInfo.errorCount++;

      // Atualizar no banco
      const db = await database.getConnection();
      await db.run(`
        UPDATE job_executions 
        SET status = 'failed', finished_at = datetime('now', 'utc'), error_message = ?
        WHERE job_type = ? AND dedupe_key = ?
      `, [error.message, name, executionId]);

      logger.job(name, 'FAILED', { 
        executionId, 
        duration: DateUtils.formatarDuracao(duration),
        error: error.message 
      });

      // Emitir evento de erro para alertas
      this.emit('job-error', { name, error, executionId });
    }
  }

  /**
   * Handler do job de sorteios
   */
  async handleSorteiosJob(executionId) {
    logger.info('🎯 Iniciando processamento de sorteios...');
    
    // Importar módulo de sorteios dinamicamente para evitar dependência circular
    const SorteiosModule = require('../modules/sorteios');
    const sorteiosModule = new SorteiosModule();
    
    await sorteiosModule.processarSorteiosDiarios(executionId);
    
    logger.info('✅ Processamento de sorteios concluído');
  }

  /**
   * Handler do job de limpeza
   */
  async handleLimpezaJob(executionId) {
    logger.info('🧹 Iniciando limpeza diária...');
    
    const db = await database.getConnection();
    
    // Limpar logs antigos (mais de 30 dias)
    const result1 = await db.run(`
      DELETE FROM logs_auditoria 
      WHERE created_at < datetime('now', '-30 days')
    `);
    
    // Limpar execuções de jobs antigas (mais de 7 dias)
    const result2 = await db.run(`
      DELETE FROM job_executions 
      WHERE created_at < datetime('now', '-7 days')
    `);
    
    // Limpar sessões expiradas
    const result3 = await db.run(`
      DELETE FROM admin_sessions 
      WHERE expire < datetime('now')
    `);

    logger.info(`🧹 Limpeza concluída: ${result1.changes} logs, ${result2.changes} jobs, ${result3.changes} sessões removidas`);
  }

  /**
   * Handler do job de health check
   */
  async handleHealthCheckJob(executionId) {
    // Este job roda silenciosamente, apenas verifica se o sistema está funcionando
    // Os alertas são tratados pelo sistema de monitoramento
    
    try {
      const db = await database.getConnection();
      await db.get('SELECT 1');
      
      // Verificar se há jobs falhando muito
      const failedJobs = await db.get(`
        SELECT COUNT(*) as count 
        FROM job_executions 
        WHERE status = 'failed' 
        AND created_at > datetime('now', '-1 hour')
      `);
      
      if (failedJobs.count > 5) {
        logger.warn(`⚠️ Muitos jobs falhando na última hora: ${failedJobs.count}`);
        this.emit('high-failure-rate', { count: failedJobs.count });
      }
      
    } catch (error) {
      logger.error('❌ Health check falhou:', error);
      this.emit('health-check-failed', { error: error.message });
    }
  }

  /**
   * Calcular próxima execução
   */
  getNextRun(schedule, timezone) {
    try {
      // Esta é uma implementação simplificada
      // Em produção, usaríamos uma biblioteca como 'cron-parser'
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      if (schedule === '0 9 * * *') {
        tomorrow.setHours(9, 0, 0, 0);
        return tomorrow;
      } else if (schedule === '0 0 * * *') {
        tomorrow.setHours(0, 0, 0, 0);
        return tomorrow;
      } else if (schedule === '*/5 * * * *') {
        const next = new Date(now);
        next.setMinutes(next.getMinutes() + 5);
        return next;
      }
      
      return null;
    } catch (error) {
      logger.error('❌ Erro ao calcular próxima execução:', error);
      return null;
    }
  }

  /**
   * Obter status de todos os jobs
   */
  getJobsStatus() {
    const status = {};
    
    for (const [name, jobInfo] of this.jobs) {
      status[name] = {
        description: jobInfo.config.description,
        schedule: jobInfo.config.schedule,
        timezone: jobInfo.config.timezone,
        lastRun: jobInfo.lastRun,
        nextRun: jobInfo.nextRun,
        runCount: jobInfo.runCount,
        errorCount: jobInfo.errorCount,
        isRunning: jobInfo.task.running
      };
    }
    
    return status;
  }

  /**
   * Executar job manualmente
   */
  async runJobNow(name) {
    const jobInfo = this.jobs.get(name);
    if (!jobInfo) {
      throw new Error(`Job '${name}' não encontrado`);
    }

    logger.info(`🚀 Executando job '${name}' manualmente...`);
    await this.executeJob(name, jobInfo.config.handler);
  }

  /**
   * Parar um job
   */
  stopJob(name) {
    const jobInfo = this.jobs.get(name);
    if (!jobInfo) {
      throw new Error(`Job '${name}' não encontrado`);
    }

    jobInfo.task.stop();
    logger.info(`⏹️ Job '${name}' parado`);
  }

  /**
   * Iniciar um job
   */
  startJob(name) {
    const jobInfo = this.jobs.get(name);
    if (!jobInfo) {
      throw new Error(`Job '${name}' não encontrado`);
    }

    jobInfo.task.start();
    logger.info(`▶️ Job '${name}' iniciado`);
  }

  /**
   * Remover um job
   */
  removeJob(name) {
    const jobInfo = this.jobs.get(name);
    if (!jobInfo) {
      throw new Error(`Job '${name}' não encontrado`);
    }

    jobInfo.task.destroy();
    this.jobs.delete(name);
    logger.info(`🗑️ Job '${name}' removido`);
  }

  /**
   * Parar todos os jobs
   */
  stopAll() {
    logger.info('⏹️ Parando todos os jobs...');
    
    for (const [name, jobInfo] of this.jobs) {
      jobInfo.task.stop();
    }
    
    logger.info('✅ Todos os jobs parados');
  }

  /**
   * Destruir agendador
   */
  destroy() {
    logger.info('🗑️ Destruindo agendador...');
    
    for (const [name, jobInfo] of this.jobs) {
      jobInfo.task.destroy();
    }
    
    this.jobs.clear();
    this.isInitialized = false;
    
    logger.info('✅ Agendador destruído');
  }
}

// Mixin para EventEmitter
Object.setPrototypeOf(JobScheduler.prototype, require('events').EventEmitter.prototype);

module.exports = JobScheduler;

