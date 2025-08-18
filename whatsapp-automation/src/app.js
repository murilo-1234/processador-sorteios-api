// src/app.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const logger = require('./config/logger');
const database = require('./config/database');

// Configuração específica para Render
const app = express();
app.set('trust proxy', 1); // Configuração para proxy do Render

// Middleware básico
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname, '..', 'public')));

// ===== ROTAS BÁSICAS PRIMEIRO (RENDER OPTIMIZATION) =====

// Health check - PRIMEIRA ROTA para Render
app.get('/health', (req, res) => {
  const whatsappClient = req.app.locals.whatsappClient;
  const status = whatsappClient?.getConnectionStatus() || { isConnected: false };
  
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    whatsapp: {
      connected: status.isConnected,
      realConnected: status.realConnectionStatus,
      monitoring: status.heartbeatActive && status.monitoringActive
    },
    renderOptimized: true
  });
});

// Root - SEGUNDA ROTA
app.get('/', (req, res) => {
  res.json({ 
    message: 'WhatsApp Automation - Detecção de Desconexão Implementada',
    status: 'running',
    version: '2.0.0-detection',
    timestamp: new Date().toISOString(),
    features: [
      'Detecção ativa de desconexão manual',
      'Heartbeat para verificação contínua',
      'Reset inteligente automático',
      'Diagnóstico completo do sistema',
      'Monitoramento em tempo real'
    ]
  });
});

// QR Code endpoint - TERCEIRA ROTA (importante para funcionamento)
app.get('/qr', (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient) {
      return res.status(503).json({
        error: 'Cliente WhatsApp não inicializado',
        message: 'Sistema ainda inicializando. Aguarde alguns segundos.',
        suggestion: 'Tente /api/diagnostico-completo para verificar o status'
      });
    }
    
    const status = whatsappClient.getConnectionStatus();
    
    // Verificar se há inconsistência de conexão
    if (status.isConnected && !status.realConnectionStatus) {
      return res.json({
        error: 'Conexão inconsistente detectada',
        message: 'Sistema detectou que WhatsApp foi desconectado manualmente',
        suggestion: 'Use /api/detectar-desconexao para reset automático',
        status: {
          internal: status.isConnected,
          real: status.realConnectionStatus
        }
      });
    }
    
    if (whatsappClient.isConnected && status.realConnectionStatus) {
      return res.json({
        connected: true,
        message: 'WhatsApp já está conectado',
        user: status.user,
        monitoring: status.heartbeatActive && status.monitoringActive
      });
    }
    
    if (whatsappClient.currentQRCode) {
      // Gerar QR Code como SVG
      const qrcode = require('qrcode');
      qrcode.toString(whatsappClient.currentQRCode, { type: 'svg', width: 256 }, (err, svg) => {
        if (err) {
          logger.error('❌ Erro ao gerar SVG do QR:', err);
          return res.status(500).json({
            error: 'Erro ao gerar QR Code',
            message: err.message,
            suggestion: 'Tente /api/force-qr-generation'
          });
        }
        
        res.setHeader('Content-Type', 'image/svg+xml');
        res.send(svg);
      });
    } else if (whatsappClient.currentPairingCode) {
      res.json({
        pairingCode: whatsappClient.currentPairingCode,
        message: 'Use o código de pareamento no WhatsApp'
      });
    } else {
      res.status(503).json({
        error: 'QR Code não disponível',
        message: 'WhatsApp pode já estar conectado ou aguardando conexão',
        qrGenerated: status.qrCodeGenerated,
        attempts: status.connectionAttempts,
        suggestions: [
          'Tente /api/detectar-desconexao para verificar desconexão manual',
          'Use /api/reset-inteligente para reset automático',
          'Use /api/force-qr-generation para forçar novo QR'
        ]
      });
    }
    
  } catch (error) {
    logger.error('❌ Erro no endpoint /qr:', error);
    res.status(500).json({
      error: 'Erro interno no QR Code',
      message: error.message,
      suggestion: 'Use /api/diagnostico-completo para análise detalhada'
    });
  }
});

// Endpoint de diagnóstico rápido
app.get('/diagnostico', async (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient) {
      return res.json({
        status: 'error',
        message: 'Cliente WhatsApp não inicializado',
        action: 'restart_required'
      });
    }
    
    const status = whatsappClient.getConnectionStatus();
    const diagnostics = await whatsappClient.getDiagnostics();
    
    // Verificar problemas comuns
    const problems = [];
    const solutions = [];
    
    if (status.isConnected && !status.realConnectionStatus) {
      problems.push('Desconexão manual detectada');
      solutions.push('Use /api/detectar-desconexao');
    }
    
    if (!status.isConnected && !status.qrCodeGenerated) {
      problems.push('Não conectado e sem QR Code');
      solutions.push('Use /api/force-qr-generation');
    }
    
    if (status.missedHeartbeats >= 2) {
      problems.push(`Heartbeats perdidos: ${status.missedHeartbeats}`);
      solutions.push('Use /api/reset-inteligente');
    }
    
    if (diagnostics.sessionCorrupted) {
      problems.push('Sessão corrompida');
      solutions.push('Use /api/reset-nuclear');
    }
    
    res.json({
      status: problems.length === 0 ? 'ok' : 'warning',
      timestamp: new Date().toISOString(),
      connection: {
        internal: status.isConnected,
        real: status.realConnectionStatus,
        consistent: status.isConnected === status.realConnectionStatus
      },
      monitoring: {
        heartbeat: status.heartbeatActive,
        connectionCheck: status.monitoringActive,
        missedHeartbeats: status.missedHeartbeats
      },
      problems,
      solutions,
      quickActions: [
        '/api/detectar-desconexao - Verificar desconexão manual',
        '/api/reset-inteligente - Reset automático inteligente',
        '/api/diagnostico-completo - Análise detalhada'
      ]
    });
    
  } catch (error) {
    logger.error('❌ Erro no diagnóstico rápido:', error);
    res.status(500).json({
      status: 'error',
      message: 'Erro no diagnóstico: ' + error.message
    });
  }
});

// ===== INICIALIZAÇÃO ASSÍNCRONA (NÃO BLOQUEIA RENDER) =====

let initializationStarted = false;

async function initializeServices() {
  if (initializationStarted) return;
  initializationStarted = true;
  
  try {
    logger.info('🚀 Inicializando serviços em background (Detection Mode)...');
    
    // 1. Inicializar banco de dados
    logger.info('📊 Inicializando banco de dados...');
    await database.initialize();
    logger.info('✅ Banco de dados inicializado');
    
    // 2. Inicializar WhatsApp Client (modo assíncrono)
    logger.info('📱 Inicializando cliente WhatsApp com detecção ativa...');
    const WhatsAppClient = require('./services/whatsapp-client');
    const whatsappClient = new WhatsAppClient();
    
    // Armazenar referência global
    app.locals.whatsappClient = whatsappClient;
    
    // Configurar listeners para eventos importantes
    whatsappClient.on('forced-disconnect', (reason) => {
      logger.warn(`⚠️ Desconexão forçada detectada: ${reason}`);
    });
    
    whatsappClient.on('logged-out', () => {
      logger.warn('⚠️ WhatsApp foi deslogado, sessão limpa');
    });
    
    whatsappClient.on('max-retries-reached', () => {
      logger.error('❌ Máximo de tentativas de reconexão atingido');
    });
    
    whatsappClient.on('circuit-breaker-open', () => {
      logger.error('🔴 Circuit breaker aberto - muitas falhas');
    });
    
    // Inicializar de forma assíncrona (não bloqueia)
    whatsappClient.initialize().catch(err => {
      logger.error('❌ Erro na inicialização do WhatsApp:', err);
    });
    
    // 3. Configurar job scheduler (se existir)
    try {
      const JobScheduler = require('./modules/job-scheduler');
      const jobScheduler = new JobScheduler(whatsappClient);
      app.locals.jobScheduler = jobScheduler;
      
      // Inicializar jobs de forma assíncrona
      setTimeout(() => {
        jobScheduler.start().catch(err => {
          logger.error('❌ Erro ao iniciar jobs:', err);
        });
      }, 10000); // Aguardar mais tempo para WhatsApp estar pronto
      
      logger.info('✅ Job scheduler configurado');
    } catch (err) {
      logger.warn('⚠️ Job scheduler não disponível:', err.message);
    }
    
    logger.info('✅ Inicialização de serviços concluída (modo detecção ativa)');
    
  } catch (error) {
    logger.error('❌ Erro na inicialização de serviços:', error);
  }
}

// ===== CARREGAR ROTAS APÓS INICIALIZAÇÃO BÁSICA =====

// Rotas da API
app.use('/api', require('./routes/api'));

// Rotas administrativas
try {
  app.use('/admin', require('./routes/admin'));
  logger.info('✅ Rotas administrativas carregadas');
} catch (err) {
  logger.warn('⚠️ Rotas administrativas não disponíveis:', err.message);
}

// ===== MIDDLEWARE DE ERRO =====

app.use((err, req, res, next) => {
  logger.error('❌ Erro não tratado:', err);
  res.status(500).json({
    error: 'Erro interno do servidor',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Erro interno',
    suggestion: 'Use /api/diagnostico-completo para análise detalhada'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint não encontrado',
    path: req.path,
    availableEndpoints: [
      '/health - Status do sistema',
      '/qr - QR Code do WhatsApp',
      '/diagnostico - Diagnóstico rápido',
      '/api/diagnostico-completo - Análise detalhada',
      '/api/detectar-desconexao - Verificar desconexão manual',
      '/api/reset-inteligente - Reset automático',
      '/api/force-qr-generation - Forçar novo QR'
    ]
  });
});

// ===== INICIALIZAÇÃO DO SERVIDOR =====

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Servidor rodando na porta ${PORT} (Detection Mode)`);
  logger.info(`📱 QR Code disponível em: http://localhost:${PORT}/qr`);
  logger.info(`🔧 Health check: http://localhost:${PORT}/health`);
  logger.info(`🔍 Diagnóstico: http://localhost:${PORT}/diagnostico`);
  logger.info(`🧠 Reset inteligente: http://localhost:${PORT}/api/reset-inteligente`);
  
  // Inicializar serviços APÓS servidor estar rodando
  setTimeout(() => {
    initializeServices().catch(err => {
      logger.error('❌ Erro na inicialização tardia:', err);
    });
  }, 1000);
});

// ===== GRACEFUL SHUTDOWN =====

process.on('SIGTERM', async () => {
  logger.info('🔄 SIGTERM recebido, iniciando shutdown graceful...');
  
  server.close(async () => {
    try {
      // Parar monitoramento do WhatsApp
      if (app.locals.whatsappClient) {
        app.locals.whatsappClient.stopMonitoring();
        await app.locals.whatsappClient.disconnect();
        logger.info('✅ WhatsApp desconectado e monitoramento parado');
      }
      
      // Parar jobs
      if (app.locals.jobScheduler) {
        await app.locals.jobScheduler.stop();
        logger.info('✅ Jobs parados');
      }
      
      // Fechar banco
      if (database.close) {
        await database.close();
        logger.info('✅ Banco de dados fechado');
      }
      
      logger.info('✅ Shutdown graceful concluído');
      process.exit(0);
    } catch (error) {
      logger.error('❌ Erro no shutdown:', error);
      process.exit(1);
    }
  });
});

process.on('SIGINT', async () => {
  logger.info('🔄 SIGINT recebido, iniciando shutdown...');
  process.emit('SIGTERM');
});

// ===== TRATAMENTO DE ERROS NÃO CAPTURADOS =====

process.on('uncaughtException', (error) => {
  logger.error('❌ Exceção não capturada:', error);
  // Não fazer exit para manter servidor rodando no Render
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('❌ Promise rejeitada não tratada:', reason);
  // Não fazer exit para manter servidor rodando no Render
});

module.exports = app;

