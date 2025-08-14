const express = require('express');
const rateLimit = require('express-rate-limit');
const logger = require('../config/logger');
const database = require('../config/database');
const metricsService = require('../services/metrics');
const SorteiosModule = require('../modules/sorteios');

const router = express.Router();

// Rate limiting específico para API
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 50, // máximo 50 requests por IP
  message: {
    error: 'Muitas requisições para a API, tente novamente em 15 minutos.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(apiLimiter);

// Middleware para log de API
router.use((req, res, next) => {
  logger.info(`API ${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    body: req.method === 'POST' ? req.body : undefined
  });
  next();
});

/**
 * GET /api/health
 * Health check da API
 */
router.get('/health', async (req, res) => {
  try {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      uptime: process.uptime(),
      checks: {
        database: await database.healthCheck(),
        memory: getMemoryStatus()
      }
    };

    const isHealthy = Object.values(health.checks).every(check => 
      check.status === 'ok'
    );

    if (!isHealthy) {
      health.status = 'unhealthy';
    }

    res.status(isHealthy ? 200 : 503).json(health);
  } catch (error) {
    logger.error('❌ Erro no health check da API:', error);
    res.status(503).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/status
 * Status geral do sistema
 */
router.get('/status', async (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    const jobScheduler = req.app.locals.jobScheduler;
    
    const status = {
      whatsapp: {
        connected: whatsappClient?.isConnected || false,
        queueLength: whatsappClient?.messageQueue?.length || 0,
        circuitBreakerState: whatsappClient?.circuitBreakerState || 'unknown'
      },
      jobs: {
        initialized: jobScheduler?.isInitialized || false,
        activeJobs: jobScheduler ? Object.keys(jobScheduler.getJobsStatus()).length : 0
      },
      metrics: await metricsService.getSummary(),
      timestamp: new Date().toISOString()
    };

    res.json(status);
  } catch (error) {
    logger.error('❌ Erro ao obter status:', error);
    res.status(500).json({
      error: 'Erro ao obter status do sistema',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/sorteios/stats
 * Estatísticas de sorteios
 */
router.get('/sorteios/stats', async (req, res) => {
  try {
    const sorteiosModule = new SorteiosModule();
    const stats = await sorteiosModule.obterEstatisticas();
    
    res.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Erro ao obter estatísticas de sorteios:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao obter estatísticas',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/grupos/ativos
 * Lista de grupos ativos
 */
router.get('/grupos/ativos', async (req, res) => {
  try {
    const db = await database.getConnection();
    const grupos = await db.all(`
      SELECT jid, nome, created_at
      FROM grupos_whatsapp 
      WHERE ativo_sorteios = 1 AND enabled = 1
      ORDER BY nome
    `);

    res.json({
      success: true,
      data: grupos,
      count: grupos.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Erro ao obter grupos ativos:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao obter grupos ativos',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/envios/historico
 * Histórico de envios
 */
router.get('/envios/historico', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const db = await database.getConnection();
    
    const envios = await db.all(`
      SELECT 
        e.codigo_sorteio,
        e.status,
        e.enviado_em,
        e.tentativas,
        g.nome as grupo_nome
      FROM envios_whatsapp e
      LEFT JOIN grupos_whatsapp g ON e.grupo_jid = g.jid
      ORDER BY e.created_at DESC
      LIMIT ? OFFSET ?
    `, [parseInt(limit), parseInt(offset)]);

    const total = await db.get('SELECT COUNT(*) as count FROM envios_whatsapp');

    res.json({
      success: true,
      data: envios,
      pagination: {
        total: total.count,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: (parseInt(offset) + parseInt(limit)) < total.count
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Erro ao obter histórico de envios:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao obter histórico',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * POST /api/sorteios/processar
 * Processar sorteio manualmente (endpoint público limitado)
 */
router.post('/sorteios/processar', async (req, res) => {
  try {
    const { codigo } = req.body;
    
    if (!codigo || typeof codigo !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Código do sorteio é obrigatório',
        timestamp: new Date().toISOString()
      });
    }

    // Validar formato do código
    if (!/^[a-zA-Z0-9]+$/.test(codigo)) {
      return res.status(400).json({
        success: false,
        error: 'Formato de código inválido',
        timestamp: new Date().toISOString()
      });
    }

    const sorteiosModule = new SorteiosModule();
    const resultado = await sorteiosModule.processarSorteioManual(codigo);
    
    logger.info(`✅ Sorteio ${codigo} processado via API`);
    
    res.json({
      success: true,
      data: resultado,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Erro ao processar sorteio via API:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao processar sorteio',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/whatsapp/qr
 * Obter QR Code para autenticação (se disponível)
 */
router.get('/whatsapp/qr', (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient) {
      return res.status(503).json({
        success: false,
        error: 'Cliente WhatsApp não inicializado',
        timestamp: new Date().toISOString()
      });
    }

    const status = whatsappClient.getConnectionStatus();
    
    res.json({
      success: true,
      data: {
        isConnected: status.isConnected,
        qrCodeGenerated: status.qrCodeGenerated,
        needsQR: !status.isConnected && !status.qrCodeGenerated,
        message: status.isConnected 
          ? 'WhatsApp já está conectado' 
          : status.qrCodeGenerated 
            ? 'QR Code gerado, verifique os logs'
            : 'Aguardando geração do QR Code'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Erro ao obter status do QR:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao obter status do QR Code',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * POST /api/whatsapp/clear-session
 * Limpar sessão do WhatsApp (forçar novo QR)
 */
router.post('/whatsapp/clear-session', async (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient) {
      return res.status(503).json({
        success: false,
        error: 'Cliente WhatsApp não inicializado',
        timestamp: new Date().toISOString()
      });
    }

    await whatsappClient.clearSession();
    
    // Reinicializar cliente
    setTimeout(async () => {
      try {
        await whatsappClient.initialize();
      } catch (error) {
        logger.error('❌ Erro ao reinicializar WhatsApp após limpar sessão:', error);
      }
    }, 2000);

    logger.info('🗑️ Sessão WhatsApp limpa via API');
    
    res.json({
      success: true,
      message: 'Sessão limpa com sucesso. Novo QR Code será gerado.',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Erro ao limpar sessão via API:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao limpar sessão',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/logs/recent
 * Logs recentes do sistema
 */
router.get('/logs/recent', async (req, res) => {
  try {
    const { limit = 100 } = req.query;
    const db = await database.getConnection();
    
    const logs = await db.all(`
      SELECT evento, detalhes, created_at
      FROM logs_auditoria
      ORDER BY created_at DESC
      LIMIT ?
    `, [parseInt(limit)]);

    res.json({
      success: true,
      data: logs,
      count: logs.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Erro ao obter logs recentes:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao obter logs',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/info
 * Informações gerais da API
 */
router.get('/info', (req, res) => {
  res.json({
    name: 'WhatsApp Automation API',
    version: '1.0.0',
    description: 'API para automação de postagens de sorteios no WhatsApp',
    endpoints: {
      health: 'GET /api/health',
      status: 'GET /api/status',
      sorteios: {
        stats: 'GET /api/sorteios/stats',
        processar: 'POST /api/sorteios/processar'
      },
      grupos: {
        ativos: 'GET /api/grupos/ativos'
      },
      envios: {
        historico: 'GET /api/envios/historico'
      },
      whatsapp: {
        qr: 'GET /api/whatsapp/qr',
        clearSession: 'POST /api/whatsapp/clear-session'
      },
      logs: {
        recent: 'GET /api/logs/recent'
      }
    },
    timestamp: new Date().toISOString()
  });
});

// Handler de erro para rotas não encontradas
router.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint da API não encontrado',
    path: req.originalUrl,
    availableEndpoints: '/api/info',
    timestamp: new Date().toISOString()
  });
});

// Helper para status de memória
function getMemoryStatus() {
  const used = process.memoryUsage();
  const totalMB = used.rss / 1024 / 1024;
  
  return {
    status: totalMB < 800 ? 'ok' : 'warning',
    memory_usage_mb: +totalMB.toFixed(2),
    heap_used_mb: +(used.heapUsed / 1024 / 1024).toFixed(2),
    heap_total_mb: +(used.heapTotal / 1024 / 1024).toFixed(2)
  };
}

module.exports = router;

