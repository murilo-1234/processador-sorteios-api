const client = require('prom-client');
const logger = require('../config/logger');

// Configurar métricas padrão do Node.js
client.collectDefaultMetrics({ 
  prefix: 'wa_auto_',
  timeout: 5000
});

// Métricas customizadas do sistema
const messagesSent = new client.Counter({
  name: 'wa_auto_messages_sent_total',
  help: 'Total de mensagens enviadas com sucesso',
  labelNames: ['grupo_nome', 'codigo_sorteio']
});

const messagesFailed = new client.Counter({
  name: 'wa_auto_messages_failed_total',
  help: 'Total de falhas no envio de mensagens',
  labelNames: ['grupo_nome', 'error_type', 'codigo_sorteio']
});

const baileyConnectionState = new client.Gauge({
  name: 'wa_auto_baileys_connection_state',
  help: 'Estado da conexão WhatsApp (0=down, 1=up)'
});

const jobProcessingDuration = new client.Histogram({
  name: 'wa_auto_job_processing_seconds',
  help: 'Duração do processamento de jobs',
  labelNames: ['job_type', 'status'],
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300]
});

const scrapingErrors = new client.Counter({
  name: 'wa_auto_scraping_errors_total',
  help: 'Total de erros no web scraping',
  labelNames: ['site', 'error_type']
});

const rateLimitHits = new client.Counter({
  name: 'wa_auto_whatsapp_rate_limit_hits_total',
  help: 'Total de rate limits atingidos no WhatsApp'
});

const activeJobs = new client.Gauge({
  name: 'wa_auto_active_jobs_count',
  help: 'Número de jobs ativos no momento'
});

const databaseConnections = new client.Gauge({
  name: 'wa_auto_database_connections',
  help: 'Número de conexões ativas com o banco de dados'
});

const queueLength = new client.Gauge({
  name: 'wa_auto_message_queue_length',
  help: 'Tamanho da fila de mensagens WhatsApp'
});

const systemHealth = new client.Gauge({
  name: 'wa_auto_system_health',
  help: 'Status geral do sistema (0=unhealthy, 1=healthy)',
  labelNames: ['component']
});

const alertsSent = new client.Counter({
  name: 'wa_auto_alerts_sent_total',
  help: 'Total de alertas enviados',
  labelNames: ['type', 'channel']
});

const sorteiosProcessados = new client.Counter({
  name: 'wa_auto_sorteios_processados_total',
  help: 'Total de sorteios processados',
  labelNames: ['status']
});

const gruposAtivos = new client.Gauge({
  name: 'wa_auto_grupos_ativos_count',
  help: 'Número de grupos ativos para postagens'
});

class MetricsService {
  constructor() {
    this.register = client.register;
    this.startTime = Date.now();
    
    // Inicializar métricas básicas
    this.initializeMetrics();
  }

  /**
   * Inicializar métricas com valores padrão
   */
  initializeMetrics() {
    baileyConnectionState.set(0);
    activeJobs.set(0);
    databaseConnections.set(0);
    queueLength.set(0);
    gruposAtivos.set(0);
    
    // Componentes do sistema
    const components = ['whatsapp', 'database', 'scheduler', 'api'];
    components.forEach(component => {
      systemHealth.set({ component }, 0);
    });
  }

  /**
   * Registrar mensagem enviada
   */
  recordMessageSent(grupoNome, codigoSorteio) {
    messagesSent.inc({ grupo_nome: grupoNome, codigo_sorteio: codigoSorteio });
    logger.metric('message_sent', 1, { grupoNome, codigoSorteio });
  }

  /**
   * Registrar falha de mensagem
   */
  recordMessageFailed(grupoNome, errorType, codigoSorteio) {
    messagesFailed.inc({ 
      grupo_nome: grupoNome, 
      error_type: errorType, 
      codigo_sorteio: codigoSorteio 
    });
    logger.metric('message_failed', 1, { grupoNome, errorType, codigoSorteio });
  }

  /**
   * Atualizar estado da conexão Baileys
   */
  setBaileyConnectionState(connected) {
    baileyConnectionState.set(connected ? 1 : 0);
    systemHealth.set({ component: 'whatsapp' }, connected ? 1 : 0);
    logger.metric('baileys_connection', connected ? 1 : 0);
  }

  /**
   * Registrar duração de processamento de job
   */
  recordJobDuration(jobType, status, durationSeconds) {
    jobProcessingDuration
      .labels({ job_type: jobType, status })
      .observe(durationSeconds);
    logger.metric('job_duration', durationSeconds, { jobType, status });
  }

  /**
   * Registrar erro de scraping
   */
  recordScrapingError(site, errorType) {
    scrapingErrors.inc({ site, error_type: errorType });
    logger.metric('scraping_error', 1, { site, errorType });
  }

  /**
   * Registrar hit de rate limit
   */
  recordRateLimitHit() {
    rateLimitHits.inc();
    logger.metric('rate_limit_hit', 1);
  }

  /**
   * Atualizar número de jobs ativos
   */
  setActiveJobs(count) {
    activeJobs.set(count);
    logger.metric('active_jobs', count);
  }

  /**
   * Atualizar conexões do banco
   */
  setDatabaseConnections(count) {
    databaseConnections.set(count);
    systemHealth.set({ component: 'database' }, count > 0 ? 1 : 0);
    logger.metric('database_connections', count);
  }

  /**
   * Atualizar tamanho da fila
   */
  setQueueLength(length) {
    queueLength.set(length);
    logger.metric('queue_length', length);
  }

  /**
   * Atualizar saúde do sistema
   */
  setSystemHealth(component, healthy) {
    systemHealth.set({ component }, healthy ? 1 : 0);
    logger.metric('system_health', healthy ? 1 : 0, { component });
  }

  /**
   * Registrar alerta enviado
   */
  recordAlertSent(type, channel) {
    alertsSent.inc({ type, channel });
    logger.metric('alert_sent', 1, { type, channel });
  }

  /**
   * Registrar sorteio processado
   */
  recordSorteioProcessado(status) {
    sorteiosProcessados.inc({ status });
    logger.metric('sorteio_processado', 1, { status });
  }

  /**
   * Atualizar número de grupos ativos
   */
  setGruposAtivos(count) {
    gruposAtivos.set(count);
    logger.metric('grupos_ativos', count);
  }

  /**
   * Obter todas as métricas
   */
  async getMetrics() {
    return await this.register.metrics();
  }

  /**
   * Obter métricas em formato JSON
   */
  async getMetricsJSON() {
    const metrics = await this.register.getMetricsAsJSON();
    return metrics;
  }

  /**
   * Limpar todas as métricas
   */
  clearMetrics() {
    this.register.clear();
    logger.info('📊 Métricas limpas');
  }

  /**
   * Obter resumo das métricas principais
   */
  async getSummary() {
    try {
      const metrics = await this.getMetricsJSON();
      const summary = {};

      // Extrair métricas principais
      metrics.forEach(metric => {
        switch (metric.name) {
          case 'wa_auto_messages_sent_total':
            summary.messagesSent = this.sumMetricValues(metric);
            break;
          case 'wa_auto_messages_failed_total':
            summary.messagesFailed = this.sumMetricValues(metric);
            break;
          case 'wa_auto_baileys_connection_state':
            summary.whatsappConnected = metric.values[0]?.value === 1;
            break;
          case 'wa_auto_active_jobs_count':
            summary.activeJobs = metric.values[0]?.value || 0;
            break;
          case 'wa_auto_message_queue_length':
            summary.queueLength = metric.values[0]?.value || 0;
            break;
          case 'wa_auto_grupos_ativos_count':
            summary.gruposAtivos = metric.values[0]?.value || 0;
            break;
        }
      });

      // Calcular uptime
      summary.uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
      summary.uptimeFormatted = this.formatUptime(summary.uptimeSeconds);

      return summary;
    } catch (error) {
      logger.error('❌ Erro ao obter resumo de métricas:', error);
      return {};
    }
  }

  /**
   * Somar valores de uma métrica
   */
  sumMetricValues(metric) {
    if (!metric.values || metric.values.length === 0) return 0;
    return metric.values.reduce((sum, item) => sum + (item.value || 0), 0);
  }

  /**
   * Formatar uptime
   */
  formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  /**
   * Middleware Express para métricas
   */
  getExpressMiddleware() {
    return (req, res, next) => {
      const start = Date.now();
      
      res.on('finish', () => {
        const duration = (Date.now() - start) / 1000;
        
        // Registrar métrica de requisição HTTP
        const httpRequests = new client.Counter({
          name: 'wa_auto_http_requests_total',
          help: 'Total de requisições HTTP',
          labelNames: ['method', 'route', 'status_code']
        });
        
        const httpDuration = new client.Histogram({
          name: 'wa_auto_http_request_duration_seconds',
          help: 'Duração das requisições HTTP',
          labelNames: ['method', 'route'],
          buckets: [0.1, 0.5, 1, 2, 5]
        });
        
        httpRequests.inc({
          method: req.method,
          route: req.route?.path || req.path,
          status_code: res.statusCode
        });
        
        httpDuration
          .labels({ method: req.method, route: req.route?.path || req.path })
          .observe(duration);
      });
      
      next();
    };
  }
}

module.exports = new MetricsService();

