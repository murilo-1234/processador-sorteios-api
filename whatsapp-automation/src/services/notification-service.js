const logger = require('../config/logger');
const AlertService = require('./alert-service');
const database = require('../config/database');

class NotificationService {
  constructor() {
    this.alertService = new AlertService();
    this.subscribers = new Map();
    this.notificationQueue = [];
    this.isProcessing = false;
    this.processingInterval = null;
    
    // Configurações
    this.batchSize = 10;
    this.processingDelay = 5000; // 5 segundos
    
    this.startProcessing();
  }

  /**
   * Iniciar processamento da fila
   */
  startProcessing() {
    if (this.processingInterval) {
      return;
    }

    this.processingInterval = setInterval(() => {
      this.processQueue().catch(error => {
        logger.error('❌ Erro no processamento da fila de notificações:', error);
      });
    }, this.processingDelay);

    logger.info('📬 Serviço de notificações iniciado');
  }

  /**
   * Parar processamento
   */
  stopProcessing() {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    
    logger.info('📪 Serviço de notificações parado');
  }

  /**
   * Processar fila de notificações
   */
  async processQueue() {
    if (this.isProcessing || this.notificationQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      const batch = this.notificationQueue.splice(0, this.batchSize);
      
      for (const notification of batch) {
        try {
          await this.sendNotification(notification);
        } catch (error) {
          logger.error('❌ Erro ao enviar notificação:', error);
          
          // Recolocar na fila se não excedeu tentativas
          if (notification.attempts < 3) {
            notification.attempts++;
            this.notificationQueue.push(notification);
          }
        }
      }

    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Adicionar notificação à fila
   */
  queueNotification(type, data, priority = 'normal') {
    const notification = {
      id: Date.now() + Math.random(),
      type,
      data,
      priority,
      attempts: 0,
      createdAt: new Date().toISOString()
    };

    // Inserir baseado na prioridade
    if (priority === 'high') {
      this.notificationQueue.unshift(notification);
    } else {
      this.notificationQueue.push(notification);
    }

    logger.debug(`📬 Notificação adicionada à fila: ${type}`);
  }

  /**
   * Enviar notificação
   */
  async sendNotification(notification) {
    const { type, data } = notification;

    switch (type) {
      case 'sorteio_processado':
        await this.notifySorteioProcessado(data);
        break;
      
      case 'sorteio_failed':
        await this.notifySorteioFailed(data);
        break;
      
      case 'whatsapp_disconnected':
        await this.notifyWhatsAppDisconnected(data);
        break;
      
      case 'whatsapp_reconnected':
        await this.notifyWhatsAppReconnected(data);
        break;
      
      case 'daily_summary':
        await this.notifyDailySummary(data);
        break;
      
      case 'system_health':
        await this.notifySystemHealth(data);
        break;
      
      default:
        logger.warn(`⚠️ Tipo de notificação desconhecido: ${type}`);
    }

    // Registrar notificação enviada
    await this.logNotification(notification);
  }

  /**
   * Notificar sorteio processado
   */
  async notifySorteioProcessado(data) {
    const { codigo, ganhador, premio, gruposEnviados } = data;
    
    await this.alertService.sendAlert(
      'sorteio_processado',
      `Sorteio ${codigo} Processado`,
      `✅ Sorteio processado com sucesso!\n\n` +
      `🎁 Prêmio: ${premio}\n` +
      `👑 Ganhador: ${ganhador}\n` +
      `📤 Enviado para ${gruposEnviados} grupos`,
      'info',
      data
    );
  }

  /**
   * Notificar falha no sorteio
   */
  async notifySorteioFailed(data) {
    const { codigo, error } = data;
    
    await this.alertService.alertSorteioProcessingFailed(codigo, error);
  }

  /**
   * Notificar WhatsApp desconectado
   */
  async notifyWhatsAppDisconnected(data) {
    await this.alertService.alertWhatsAppDisconnected(data.reason);
  }

  /**
   * Notificar WhatsApp reconectado
   */
  async notifyWhatsAppReconnected(data) {
    await this.alertService.alertWhatsAppReconnected();
  }

  /**
   * Notificar resumo diário
   */
  async notifyDailySummary(data) {
    const { 
      sorteiosProcessados, 
      mensagensEnviadas, 
      falhas, 
      gruposAtivos,
      data: dataResumo 
    } = data;

    const message = `📊 Resumo Diário - ${dataResumo}\n\n` +
      `🎯 Sorteios processados: ${sorteiosProcessados}\n` +
      `📤 Mensagens enviadas: ${mensagensEnviadas}\n` +
      `❌ Falhas: ${falhas}\n` +
      `👥 Grupos ativos: ${gruposAtivos}`;

    await this.alertService.sendAlert(
      'daily_summary',
      'Resumo Diário do Sistema',
      message,
      'info',
      data
    );
  }

  /**
   * Notificar status de saúde do sistema
   */
  async notifySystemHealth(data) {
    const { status, message, summary } = data;
    
    if (status === 'error') {
      await this.alertService.sendAlert(
        'system_health_critical',
        'Sistema com Problemas Críticos',
        `❌ ${message}\n\n` +
        `Resumo: ${summary.error} erros, ${summary.critical} críticos, ${summary.warning} avisos`,
        'critical',
        data
      );
    } else if (status === 'warning') {
      await this.alertService.sendAlert(
        'system_health_warning',
        'Sistema com Avisos',
        `⚠️ ${message}\n\n` +
        `Resumo: ${summary.warning} avisos detectados`,
        'warning',
        data
      );
    }
  }

  /**
   * Registrar notificação no banco
   */
  async logNotification(notification) {
    try {
      const db = await database.getConnection();
      
      await db.run(`
        INSERT INTO notifications_log 
        (notification_id, type, data, priority, attempts, sent_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', 'utc'))
      `, [
        notification.id,
        notification.type,
        JSON.stringify(notification.data),
        notification.priority,
        notification.attempts
      ]);

    } catch (error) {
      logger.error('❌ Erro ao registrar notificação no banco:', error);
    }
  }

  /**
   * Subscrever a eventos
   */
  subscribe(eventType, callback) {
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, []);
    }
    
    this.subscribers.get(eventType).push(callback);
    logger.debug(`📬 Novo subscriber para evento: ${eventType}`);
  }

  /**
   * Desinscrever de eventos
   */
  unsubscribe(eventType, callback) {
    const subscribers = this.subscribers.get(eventType);
    if (subscribers) {
      const index = subscribers.indexOf(callback);
      if (index > -1) {
        subscribers.splice(index, 1);
      }
    }
  }

  /**
   * Emitir evento para subscribers
   */
  emit(eventType, data) {
    const subscribers = this.subscribers.get(eventType);
    if (subscribers) {
      subscribers.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          logger.error(`❌ Erro em subscriber do evento ${eventType}:`, error);
        }
      });
    }
  }

  /**
   * Notificações específicas do sistema
   */

  notifySorteioProcessadoSuccess(codigo, ganhador, premio, gruposEnviados) {
    this.queueNotification('sorteio_processado', {
      codigo,
      ganhador,
      premio,
      gruposEnviados
    }, 'normal');
  }

  notifySorteioProcessadoFailed(codigo, error) {
    this.queueNotification('sorteio_failed', {
      codigo,
      error
    }, 'high');
  }

  notifyWhatsAppStatusChange(connected, reason = null) {
    const type = connected ? 'whatsapp_reconnected' : 'whatsapp_disconnected';
    this.queueNotification(type, { connected, reason }, 'high');
  }

  notifyDailyReport(stats) {
    this.queueNotification('daily_summary', stats, 'normal');
  }

  notifySystemHealthIssue(healthData) {
    if (healthData.status === 'error' || healthData.status === 'critical') {
      this.queueNotification('system_health', healthData, 'high');
    } else if (healthData.status === 'warning') {
      this.queueNotification('system_health', healthData, 'normal');
    }
  }

  /**
   * Obter estatísticas da fila
   */
  getQueueStats() {
    const priorityCount = this.notificationQueue.reduce((acc, notification) => {
      acc[notification.priority] = (acc[notification.priority] || 0) + 1;
      return acc;
    }, {});

    return {
      queueLength: this.notificationQueue.length,
      isProcessing: this.isProcessing,
      priorityBreakdown: priorityCount,
      subscribersCount: Array.from(this.subscribers.values()).reduce((sum, subs) => sum + subs.length, 0)
    };
  }

  /**
   * Limpar fila
   */
  clearQueue() {
    const cleared = this.notificationQueue.length;
    this.notificationQueue = [];
    logger.info(`🗑️ ${cleared} notificações removidas da fila`);
    return cleared;
  }

  /**
   * Obter histórico de notificações
   */
  async getNotificationHistory(limit = 50) {
    try {
      const db = await database.getConnection();
      
      const notifications = await db.all(`
        SELECT * FROM notifications_log 
        ORDER BY sent_at DESC 
        LIMIT ?
      `, [limit]);

      return notifications.map(notification => ({
        ...notification,
        data: JSON.parse(notification.data)
      }));

    } catch (error) {
      logger.error('❌ Erro ao obter histórico de notificações:', error);
      return [];
    }
  }

  /**
   * Testar sistema de notificações
   */
  async testNotifications() {
    try {
      this.queueNotification('test_notification', {
        message: 'Teste do sistema de notificações',
        timestamp: new Date().toISOString()
      }, 'high');

      return { success: true, message: 'Notificação de teste adicionada à fila' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Health check do serviço
   */
  async healthCheck() {
    const stats = this.getQueueStats();
    
    return {
      status: stats.queueLength < 100 ? 'ok' : 'warning',
      queueLength: stats.queueLength,
      isProcessing: stats.isProcessing,
      message: stats.queueLength < 100 
        ? 'Fila de notificações normal'
        : 'Fila de notificações alta'
    };
  }
}

module.exports = NotificationService;

