const nodemailer = require('nodemailer');
const axios = require('axios');
const logger = require('../config/logger');
const metricsService = require('./metrics');

class AlertService {
  constructor() {
    this.emailTransporter = null;
    this.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    this.telegramChatId = process.env.TELEGRAM_CHAT_ID;
    this.alertEmail = process.env.ALERT_EMAIL;
    this.emailFrom = process.env.EMAIL_FROM || 'noreply@whatsapp-automation.com';
    
    // Configurações de throttling para evitar spam
    this.lastAlerts = new Map();
    this.alertCooldown = 5 * 60 * 1000; // 5 minutos
    
    this.initializeEmailTransporter();
  }

  /**
   * Inicializar transportador de email
   */
  initializeEmailTransporter() {
    if (!process.env.SENDGRID_API_KEY) {
      logger.warn('⚠️ SENDGRID_API_KEY não configurado. Alertas por email desabilitados.');
      return;
    }

    this.emailTransporter = nodemailer.createTransporter({
      service: 'SendGrid',
      auth: {
        user: 'apikey',
        pass: process.env.SENDGRID_API_KEY
      }
    });

    logger.info('✅ Transportador de email inicializado');
  }

  /**
   * Enviar alerta multi-canal
   */
  async sendAlert(type, title, message, severity = 'warning', metadata = {}) {
    try {
      // Verificar throttling
      const alertKey = `${type}-${severity}`;
      const lastAlert = this.lastAlerts.get(alertKey);
      
      if (lastAlert && (Date.now() - lastAlert) < this.alertCooldown) {
        logger.debug(`🔇 Alerta throttled: ${alertKey}`);
        return;
      }

      this.lastAlerts.set(alertKey, Date.now());

      logger.warn(`🚨 ALERTA [${severity.toUpperCase()}]: ${title}`);

      const alertData = {
        type,
        title,
        message,
        severity,
        metadata,
        timestamp: new Date().toISOString(),
        hostname: process.env.RENDER_SERVICE_NAME || 'localhost'
      };

      // Enviar por todos os canais disponíveis
      const results = await Promise.allSettled([
        this.sendEmailAlert(alertData),
        this.sendTelegramAlert(alertData),
        this.logAlert(alertData)
      ]);

      // Registrar métricas
      const successfulChannels = results.filter(r => r.status === 'fulfilled').length;
      metricsService.recordAlertSent(type, 'multi_channel');

      logger.info(`📊 Alerta enviado para ${successfulChannels}/3 canais`);

      return {
        success: true,
        channels: results.map((r, i) => ({
          channel: ['email', 'telegram', 'log'][i],
          status: r.status,
          error: r.status === 'rejected' ? r.reason?.message : null
        }))
      };

    } catch (error) {
      logger.error('❌ Erro ao enviar alerta:', error);
      throw error;
    }
  }

  /**
   * Enviar alerta por email
   */
  async sendEmailAlert(alertData) {
    if (!this.emailTransporter || !this.alertEmail) {
      throw new Error('Email não configurado');
    }

    const { title, message, severity, metadata, timestamp, hostname } = alertData;

    const severityColors = {
      info: '#3498db',
      warning: '#f39c12',
      error: '#e74c3c',
      critical: '#8e44ad'
    };

    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
          <meta charset="UTF-8">
          <style>
              body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f4f4f4; }
              .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
              .header { background: ${severityColors[severity] || '#3498db'}; color: white; padding: 20px; text-align: center; }
              .content { padding: 20px; }
              .metadata { background: #f8f9fa; padding: 15px; border-radius: 5px; margin-top: 20px; }
              .footer { background: #ecf0f1; padding: 15px; text-align: center; font-size: 12px; color: #7f8c8d; }
              .severity { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; text-transform: uppercase; }
              .severity.${severity} { background: ${severityColors[severity]}; color: white; }
          </style>
      </head>
      <body>
          <div class="container">
              <div class="header">
                  <h1>🚨 Alerta do Sistema</h1>
                  <span class="severity ${severity}">${severity}</span>
              </div>
              <div class="content">
                  <h2>${title}</h2>
                  <p>${message}</p>
                  
                  ${Object.keys(metadata).length > 0 ? `
                  <div class="metadata">
                      <h3>Detalhes:</h3>
                      ${Object.entries(metadata).map(([key, value]) => 
                        `<p><strong>${key}:</strong> ${JSON.stringify(value)}</p>`
                      ).join('')}
                  </div>
                  ` : ''}
              </div>
              <div class="footer">
                  <p>Sistema: ${hostname}</p>
                  <p>Timestamp: ${timestamp}</p>
                  <p>WhatsApp Automation System</p>
              </div>
          </div>
      </body>
      </html>
    `;

    const mailOptions = {
      from: this.emailFrom,
      to: this.alertEmail,
      subject: `[${severity.toUpperCase()}] ${title} - WhatsApp Automation`,
      html: emailHtml,
      text: `${title}\n\n${message}\n\nTimestamp: ${timestamp}\nSistema: ${hostname}`
    };

    await this.emailTransporter.sendMail(mailOptions);
    metricsService.recordAlertSent(alertData.type, 'email');
    logger.info('📧 Alerta enviado por email');
  }

  /**
   * Enviar alerta por Telegram
   */
  async sendTelegramAlert(alertData) {
    if (!this.telegramBotToken || !this.telegramChatId) {
      throw new Error('Telegram não configurado');
    }

    const { title, message, severity, metadata, timestamp } = alertData;

    const severityEmojis = {
      info: 'ℹ️',
      warning: '⚠️',
      error: '❌',
      critical: '🔴'
    };

    let telegramMessage = `${severityEmojis[severity] || '🚨'} *${title}*\n\n`;
    telegramMessage += `${message}\n\n`;
    
    if (Object.keys(metadata).length > 0) {
      telegramMessage += `*Detalhes:*\n`;
      Object.entries(metadata).forEach(([key, value]) => {
        telegramMessage += `• ${key}: \`${JSON.stringify(value)}\`\n`;
      });
      telegramMessage += '\n';
    }
    
    telegramMessage += `🕐 ${new Date(timestamp).toLocaleString('pt-BR')}`;

    const url = `https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`;
    
    await axios.post(url, {
      chat_id: this.telegramChatId,
      text: telegramMessage,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });

    metricsService.recordAlertSent(alertData.type, 'telegram');
    logger.info('📱 Alerta enviado por Telegram');
  }

  /**
   * Log do alerta
   */
  async logAlert(alertData) {
    const { type, title, message, severity, metadata } = alertData;
    
    logger.audit('system_alert', {
      type,
      title,
      message,
      severity,
      metadata
    });

    metricsService.recordAlertSent(alertData.type, 'log');
  }

  /**
   * Alertas específicos do sistema
   */

  async alertWhatsAppDisconnected(reason = 'unknown') {
    await this.sendAlert(
      'whatsapp_disconnected',
      'WhatsApp Desconectado',
      'A conexão com o WhatsApp foi perdida. O sistema tentará reconectar automaticamente.',
      'error',
      { reason, reconnectAttempts: 'automatic' }
    );
  }

  async alertWhatsAppReconnected() {
    await this.sendAlert(
      'whatsapp_reconnected',
      'WhatsApp Reconectado',
      'A conexão com o WhatsApp foi restabelecida com sucesso.',
      'info'
    );
  }

  async alertJobFailed(jobName, error) {
    await this.sendAlert(
      'job_failed',
      `Job Falhou: ${jobName}`,
      `O job "${jobName}" falhou durante a execução.`,
      'error',
      { jobName, error: error.message, stack: error.stack }
    );
  }

  async alertHighFailureRate(failureCount, timeWindow = '1 hora') {
    await this.sendAlert(
      'high_failure_rate',
      'Alta Taxa de Falhas Detectada',
      `${failureCount} falhas detectadas na última ${timeWindow}. Sistema pode estar instável.`,
      'warning',
      { failureCount, timeWindow }
    );
  }

  async alertDiskSpaceLow(freeSpaceGB, totalSpaceGB) {
    const freePercent = (freeSpaceGB / totalSpaceGB) * 100;
    
    await this.sendAlert(
      'disk_space_low',
      'Espaço em Disco Baixo',
      `Apenas ${freeSpaceGB.toFixed(2)}GB (${freePercent.toFixed(1)}%) de espaço livre restante.`,
      freePercent < 5 ? 'critical' : 'warning',
      { freeSpaceGB, totalSpaceGB, freePercent }
    );
  }

  async alertMemoryHigh(memoryUsageMB, memoryLimitMB = 1024) {
    const memoryPercent = (memoryUsageMB / memoryLimitMB) * 100;
    
    await this.sendAlert(
      'memory_high',
      'Uso de Memória Alto',
      `Uso de memória em ${memoryUsageMB.toFixed(0)}MB (${memoryPercent.toFixed(1)}%).`,
      memoryPercent > 90 ? 'critical' : 'warning',
      { memoryUsageMB, memoryLimitMB, memoryPercent }
    );
  }

  async alertDatabaseError(error) {
    await this.sendAlert(
      'database_error',
      'Erro no Banco de Dados',
      'Erro detectado na conexão ou operação do banco de dados.',
      'error',
      { error: error.message, code: error.code }
    );
  }

  async alertSorteioProcessingFailed(codigoSorteio, error) {
    await this.sendAlert(
      'sorteio_processing_failed',
      `Falha ao Processar Sorteio: ${codigoSorteio}`,
      `O sorteio ${codigoSorteio} não pôde ser processado automaticamente.`,
      'error',
      { codigoSorteio, error: error.message }
    );
  }

  async alertMessageSendingFailed(grupoNome, codigoSorteio, error) {
    await this.sendAlert(
      'message_sending_failed',
      `Falha no Envio: ${grupoNome}`,
      `Não foi possível enviar mensagem do sorteio ${codigoSorteio} para o grupo ${grupoNome}.`,
      'warning',
      { grupoNome, codigoSorteio, error: error.message }
    );
  }

  async alertSystemStarted() {
    await this.sendAlert(
      'system_started',
      'Sistema Iniciado',
      'O sistema de automação WhatsApp foi iniciado com sucesso.',
      'info',
      { version: '1.0.0', timestamp: new Date().toISOString() }
    );
  }

  async alertSystemStopped(reason = 'manual') {
    await this.sendAlert(
      'system_stopped',
      'Sistema Parado',
      'O sistema de automação WhatsApp foi parado.',
      'warning',
      { reason, timestamp: new Date().toISOString() }
    );
  }

  /**
   * Testar configuração de alertas
   */
  async testAlerts() {
    try {
      await this.sendAlert(
        'test_alert',
        'Teste de Alertas',
        'Este é um teste do sistema de alertas. Se você recebeu esta mensagem, os alertas estão funcionando corretamente.',
        'info',
        { test: true, timestamp: new Date().toISOString() }
      );

      return { success: true, message: 'Teste de alertas enviado com sucesso' };
    } catch (error) {
      logger.error('❌ Erro no teste de alertas:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Obter estatísticas de alertas
   */
  getAlertStats() {
    return {
      emailConfigured: !!this.emailTransporter && !!this.alertEmail,
      telegramConfigured: !!this.telegramBotToken && !!this.telegramChatId,
      lastAlerts: Object.fromEntries(this.lastAlerts),
      cooldownMs: this.alertCooldown
    };
  }

  /**
   * Health check do serviço
   */
  async healthCheck() {
    const stats = this.getAlertStats();
    
    return {
      status: stats.emailConfigured || stats.telegramConfigured ? 'ok' : 'warning',
      emailConfigured: stats.emailConfigured,
      telegramConfigured: stats.telegramConfigured,
      message: stats.emailConfigured || stats.telegramConfigured 
        ? 'Pelo menos um canal de alerta configurado'
        : 'Nenhum canal de alerta configurado'
    };
  }
}

module.exports = AlertService;

