const os = require('os');
const fs = require('fs');
const { promisify } = require('util');
const logger = require('../config/logger');
const database = require('../config/database');
const metricsService = require('./metrics');
const AlertService = require('./alert-service');

const stat = promisify(fs.stat);

class HealthMonitor {
  constructor() {
    this.alertService = new AlertService();
    this.checks = new Map();
    this.monitoringInterval = null;
    this.checkInterval = 60000; // 1 minuto
    this.isRunning = false;
    
    // Thresholds configuráveis
    this.thresholds = {
      memory: {
        warning: 80, // % de uso
        critical: 95
      },
      disk: {
        warning: 85, // % de uso
        critical: 95
      },
      cpu: {
        warning: 80, // % de uso
        critical: 95
      },
      responseTime: {
        warning: 5000, // ms
        critical: 10000
      }
    };

    this.registerHealthChecks();
  }

  /**
   * Registrar health checks
   */
  registerHealthChecks() {
    this.checks.set('database', this.checkDatabase.bind(this));
    this.checks.set('memory', this.checkMemory.bind(this));
    this.checks.set('disk', this.checkDisk.bind(this));
    this.checks.set('cpu', this.checkCPU.bind(this));
    this.checks.set('whatsapp', this.checkWhatsApp.bind(this));
    this.checks.set('jobs', this.checkJobs.bind(this));
    this.checks.set('alerts', this.checkAlerts.bind(this));
  }

  /**
   * Iniciar monitoramento
   */
  start() {
    if (this.isRunning) {
      logger.warn('⚠️ Health monitor já está rodando');
      return;
    }

    logger.info('🏥 Iniciando health monitor...');
    
    this.isRunning = true;
    this.monitoringInterval = setInterval(() => {
      this.runAllChecks().catch(error => {
        logger.error('❌ Erro no health monitor:', error);
      });
    }, this.checkInterval);

    // Executar primeira verificação imediatamente
    this.runAllChecks();
    
    logger.info('✅ Health monitor iniciado');
  }

  /**
   * Parar monitoramento
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    logger.info('🛑 Parando health monitor...');
    
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    
    this.isRunning = false;
    logger.info('✅ Health monitor parado');
  }

  /**
   * Executar todas as verificações
   */
  async runAllChecks() {
    const results = {};
    const startTime = Date.now();

    for (const [name, checkFn] of this.checks) {
      try {
        const checkStart = Date.now();
        const result = await checkFn();
        const duration = Date.now() - checkStart;

        results[name] = {
          ...result,
          duration,
          timestamp: new Date().toISOString()
        };

        // Atualizar métricas
        metricsService.setSystemHealth(name, result.status === 'ok');

      } catch (error) {
        logger.error(`❌ Erro no health check ${name}:`, error);
        
        results[name] = {
          status: 'error',
          message: error.message,
          duration: Date.now() - checkStart,
          timestamp: new Date().toISOString()
        };

        metricsService.setSystemHealth(name, false);
      }
    }

    const totalDuration = Date.now() - startTime;
    
    // Processar resultados e enviar alertas se necessário
    await this.processResults(results);
    
    logger.debug(`🏥 Health checks concluídos em ${totalDuration}ms`);
    
    return results;
  }

  /**
   * Processar resultados e enviar alertas
   */
  async processResults(results) {
    for (const [checkName, result] of Object.entries(results)) {
      if (result.status === 'error' || result.status === 'critical') {
        await this.handleCriticalIssue(checkName, result);
      } else if (result.status === 'warning') {
        await this.handleWarning(checkName, result);
      }
    }
  }

  /**
   * Lidar com problemas críticos
   */
  async handleCriticalIssue(checkName, result) {
    const alertKey = `health_critical_${checkName}`;
    
    try {
      await this.alertService.sendAlert(
        alertKey,
        `Problema Crítico: ${checkName}`,
        result.message || 'Status crítico detectado',
        'critical',
        { check: checkName, result }
      );
    } catch (error) {
      logger.error(`❌ Erro ao enviar alerta crítico para ${checkName}:`, error);
    }
  }

  /**
   * Lidar com avisos
   */
  async handleWarning(checkName, result) {
    const alertKey = `health_warning_${checkName}`;
    
    try {
      await this.alertService.sendAlert(
        alertKey,
        `Aviso: ${checkName}`,
        result.message || 'Status de aviso detectado',
        'warning',
        { check: checkName, result }
      );
    } catch (error) {
      logger.error(`❌ Erro ao enviar alerta de aviso para ${checkName}:`, error);
    }
  }

  /**
   * Health check: Banco de dados
   */
  async checkDatabase() {
    try {
      const startTime = Date.now();
      const result = await database.healthCheck();
      const responseTime = Date.now() - startTime;

      if (result.status !== 'ok') {
        return {
          status: 'error',
          message: result.message || 'Banco de dados não está saudável',
          responseTime
        };
      }

      if (responseTime > this.thresholds.responseTime.critical) {
        return {
          status: 'critical',
          message: `Banco muito lento: ${responseTime}ms`,
          responseTime
        };
      }

      if (responseTime > this.thresholds.responseTime.warning) {
        return {
          status: 'warning',
          message: `Banco lento: ${responseTime}ms`,
          responseTime
        };
      }

      return {
        status: 'ok',
        message: 'Banco de dados saudável',
        responseTime
      };

    } catch (error) {
      return {
        status: 'error',
        message: `Erro no banco: ${error.message}`
      };
    }
  }

  /**
   * Health check: Memória
   */
  async checkMemory() {
    try {
      const used = process.memoryUsage();
      const totalMB = used.rss / 1024 / 1024;
      const heapUsedMB = used.heapUsed / 1024 / 1024;
      const heapTotalMB = used.heapTotal / 1024 / 1024;
      
      // Estimar limite baseado na memória do sistema
      const systemMemoryGB = os.totalmem() / 1024 / 1024 / 1024;
      const estimatedLimitMB = Math.min(systemMemoryGB * 1024 * 0.8, 1024); // 80% da RAM ou 1GB
      
      const memoryPercent = (totalMB / estimatedLimitMB) * 100;

      if (memoryPercent > this.thresholds.memory.critical) {
        await this.alertService.alertMemoryHigh(totalMB, estimatedLimitMB);
        return {
          status: 'critical',
          message: `Uso crítico de memória: ${totalMB.toFixed(0)}MB (${memoryPercent.toFixed(1)}%)`,
          memoryUsageMB: totalMB,
          memoryPercent
        };
      }

      if (memoryPercent > this.thresholds.memory.warning) {
        return {
          status: 'warning',
          message: `Uso alto de memória: ${totalMB.toFixed(0)}MB (${memoryPercent.toFixed(1)}%)`,
          memoryUsageMB: totalMB,
          memoryPercent
        };
      }

      return {
        status: 'ok',
        message: `Memória OK: ${totalMB.toFixed(0)}MB (${memoryPercent.toFixed(1)}%)`,
        memoryUsageMB: totalMB,
        heapUsedMB,
        heapTotalMB,
        memoryPercent
      };

    } catch (error) {
      return {
        status: 'error',
        message: `Erro ao verificar memória: ${error.message}`
      };
    }
  }

  /**
   * Health check: Disco
   */
  async checkDisk() {
    try {
      const stats = await stat('./');
      // Em ambiente containerizado, pode ser difícil obter espaço real
      // Vamos usar uma verificação básica
      
      return {
        status: 'ok',
        message: 'Verificação de disco básica OK',
        note: 'Verificação detalhada de disco não disponível em ambiente containerizado'
      };

    } catch (error) {
      return {
        status: 'error',
        message: `Erro ao verificar disco: ${error.message}`
      };
    }
  }

  /**
   * Health check: CPU
   */
  async checkCPU() {
    try {
      const cpus = os.cpus();
      const loadAvg = os.loadavg();
      const cpuCount = cpus.length;
      
      // Load average normalizado pelo número de CPUs
      const normalizedLoad = (loadAvg[0] / cpuCount) * 100;

      if (normalizedLoad > this.thresholds.cpu.critical) {
        return {
          status: 'critical',
          message: `CPU crítica: ${normalizedLoad.toFixed(1)}%`,
          loadAverage: loadAvg,
          cpuCount,
          normalizedLoad
        };
      }

      if (normalizedLoad > this.thresholds.cpu.warning) {
        return {
          status: 'warning',
          message: `CPU alta: ${normalizedLoad.toFixed(1)}%`,
          loadAverage: loadAvg,
          cpuCount,
          normalizedLoad
        };
      }

      return {
        status: 'ok',
        message: `CPU OK: ${normalizedLoad.toFixed(1)}%`,
        loadAverage: loadAvg,
        cpuCount,
        normalizedLoad
      };

    } catch (error) {
      return {
        status: 'error',
        message: `Erro ao verificar CPU: ${error.message}`
      };
    }
  }

  /**
   * Health check: WhatsApp
   */
  async checkWhatsApp() {
    try {
      // Obter cliente do contexto global (será injetado pela aplicação)
      const whatsappClient = global.whatsappClient;
      
      if (!whatsappClient) {
        return {
          status: 'error',
          message: 'Cliente WhatsApp não inicializado'
        };
      }

      const status = whatsappClient.getConnectionStatus();
      
      if (!status.isConnected) {
        return {
          status: 'error',
          message: 'WhatsApp desconectado',
          connectionStatus: status
        };
      }

      if (status.queueLength > 50) {
        return {
          status: 'warning',
          message: `Fila de mensagens alta: ${status.queueLength}`,
          connectionStatus: status
        };
      }

      return {
        status: 'ok',
        message: 'WhatsApp conectado e funcionando',
        connectionStatus: status
      };

    } catch (error) {
      return {
        status: 'error',
        message: `Erro ao verificar WhatsApp: ${error.message}`
      };
    }
  }

  /**
   * Health check: Jobs
   */
  async checkJobs() {
    try {
      const jobScheduler = global.jobScheduler;
      
      if (!jobScheduler) {
        return {
          status: 'error',
          message: 'Agendador de jobs não inicializado'
        };
      }

      const jobsStatus = jobScheduler.getJobsStatus();
      const totalJobs = Object.keys(jobsStatus).length;
      const runningJobs = Object.values(jobsStatus).filter(job => job.isRunning).length;

      if (totalJobs === 0) {
        return {
          status: 'warning',
          message: 'Nenhum job agendado',
          totalJobs,
          runningJobs
        };
      }

      return {
        status: 'ok',
        message: `Jobs OK: ${totalJobs} agendados, ${runningJobs} executando`,
        totalJobs,
        runningJobs,
        jobsStatus
      };

    } catch (error) {
      return {
        status: 'error',
        message: `Erro ao verificar jobs: ${error.message}`
      };
    }
  }

  /**
   * Health check: Sistema de alertas
   */
  async checkAlerts() {
    try {
      const alertStats = this.alertService.getAlertStats();
      
      if (!alertStats.emailConfigured && !alertStats.telegramConfigured) {
        return {
          status: 'warning',
          message: 'Nenhum canal de alerta configurado',
          alertStats
        };
      }

      return {
        status: 'ok',
        message: 'Sistema de alertas configurado',
        alertStats
      };

    } catch (error) {
      return {
        status: 'error',
        message: `Erro ao verificar alertas: ${error.message}`
      };
    }
  }

  /**
   * Executar health check específico
   */
  async runCheck(checkName) {
    const checkFn = this.checks.get(checkName);
    
    if (!checkFn) {
      throw new Error(`Health check '${checkName}' não encontrado`);
    }

    const startTime = Date.now();
    const result = await checkFn();
    const duration = Date.now() - startTime;

    return {
      ...result,
      duration,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Obter status geral de saúde
   */
  async getOverallHealth() {
    const results = await this.runAllChecks();
    
    const statuses = Object.values(results).map(r => r.status);
    const hasError = statuses.includes('error');
    const hasCritical = statuses.includes('critical');
    const hasWarning = statuses.includes('warning');

    let overallStatus = 'ok';
    let overallMessage = 'Sistema saudável';

    if (hasError || hasCritical) {
      overallStatus = 'error';
      overallMessage = 'Sistema com problemas críticos';
    } else if (hasWarning) {
      overallStatus = 'warning';
      overallMessage = 'Sistema com avisos';
    }

    return {
      status: overallStatus,
      message: overallMessage,
      checks: results,
      summary: {
        total: statuses.length,
        ok: statuses.filter(s => s === 'ok').length,
        warning: statuses.filter(s => s === 'warning').length,
        error: statuses.filter(s => s === 'error').length,
        critical: statuses.filter(s => s === 'critical').length
      },
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Configurar thresholds
   */
  setThresholds(newThresholds) {
    this.thresholds = { ...this.thresholds, ...newThresholds };
    logger.info('🔧 Thresholds de health check atualizados');
  }

  /**
   * Obter configuração atual
   */
  getConfiguration() {
    return {
      isRunning: this.isRunning,
      checkInterval: this.checkInterval,
      thresholds: this.thresholds,
      registeredChecks: Array.from(this.checks.keys())
    };
  }
}

module.exports = HealthMonitor;

