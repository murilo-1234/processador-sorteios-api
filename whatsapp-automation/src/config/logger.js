const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Garantir que o diretório de logs existe
const logDir = process.env.LOG_FILE_PATH ? path.dirname(process.env.LOG_FILE_PATH) : './logs';
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Formato customizado para logs
const customFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss'
  }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack }) => {
    if (stack) {
      return `${timestamp} [${level.toUpperCase()}]: ${message}\n${stack}`;
    }
    return `${timestamp} [${level.toUpperCase()}]: ${message}`;
  })
);

// Configuração do logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: customFormat,
  defaultMeta: { service: 'whatsapp-automation' },
  transports: [
    // Log de erros em arquivo separado
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    
    // Log geral
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  ],
});

// Em desenvolvimento, também logar no console
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

// Função para log de auditoria
logger.audit = (evento, detalhes = null, userId = null, ipAddress = null) => {
  const auditLog = {
    evento,
    detalhes: typeof detalhes === 'object' ? JSON.stringify(detalhes) : detalhes,
    user_id: userId,
    ip_address: ipAddress,
    timestamp: new Date().toISOString()
  };
  
  logger.info(`AUDIT: ${evento}`, auditLog);
  
  // Salvar no banco de dados também (será implementado no service)
  return auditLog;
};

// Função para log de WhatsApp
logger.whatsapp = (action, details) => {
  logger.info(`WHATSAPP: ${action}`, details);
};

// Função para log de jobs
logger.job = (jobType, action, details) => {
  logger.info(`JOB[${jobType}]: ${action}`, details);
};

// Função para log de métricas
logger.metric = (metricName, value, labels = {}) => {
  logger.info(`METRIC: ${metricName}=${value}`, labels);
};

module.exports = logger;

