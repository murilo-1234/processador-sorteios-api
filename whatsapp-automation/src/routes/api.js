// src/routes/api.js
const express = require('express');
const router = express.Router();
const database = require('../config/database');
const logger = require('../config/logger');
const SorteiosModule = require('../modules/sorteios');

// Formata número/ID em JID do WhatsApp
function toJid(to) {
  const t = String(to || '').trim();
  if (!t) return null;
  if (t.endsWith('@g.us') || t.endsWith('@s.whatsapp.net')) return t;
  const num = t.replace(/\D/g, '');
  if (num.length < 10) return null;
  return `${num}@s.whatsapp.net`;
}

// ===== ENDPOINTS DE DETECÇÃO E RESET APRIMORADOS =====

// DIAGNÓSTICO COMPLETO - Verificação detalhada do estado
router.get('/diagnostico-completo', async (req, res) => {
  try {
    logger.info('🔍 Executando diagnóstico completo do sistema...');
    
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient) {
      return res.json({
        success: false,
        error: 'Cliente WhatsApp não inicializado',
        timestamp: new Date().toISOString(),
        diagnostics: {
          clientExists: false,
          systemStatus: 'not_initialized'
        }
      });
    }
    
    // Obter diagnósticos detalhados
    const diagnostics = await whatsappClient.getDiagnostics();
    
    // Verificar inconsistências
    const inconsistencies = [];
    
    if (diagnostics.isConnected && !diagnostics.realConnectionStatus) {
      inconsistencies.push('Sistema pensa que está conectado mas conexão real é falsa');
    }
    
    if (diagnostics.isConnected && diagnostics.websocketState !== 1) {
      inconsistencies.push(`WebSocket não está aberto (state=${diagnostics.websocketState})`);
    }
    
    if (diagnostics.isConnected && !diagnostics.user) {
      inconsistencies.push('Conectado mas sem informações de usuário');
    }
    
    if (diagnostics.missedHeartbeats >= 2) {
      inconsistencies.push(`Muitos heartbeats perdidos (${diagnostics.missedHeartbeats})`);
    }
    
    // Determinar ação recomendada
    let recommendedAction = 'none';
    if (inconsistencies.length > 0) {
      recommendedAction = 'force_reset';
    } else if (!diagnostics.isConnected && !diagnostics.qrCodeGenerated) {
      recommendedAction = 'generate_qr';
    } else if (diagnostics.isConnected && diagnostics.realConnectionStatus) {
      recommendedAction = 'all_good';
    }
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      diagnostics,
      inconsistencies,
      recommendedAction,
      message: inconsistencies.length > 0 ? 
        'Inconsistências detectadas - reset recomendado' : 
        'Sistema funcionando corretamente'
    });
    
  } catch (error) {
    logger.error('❌ Erro no diagnóstico completo:', error);
    res.status(500).json({
      success: false,
      error: 'Erro no diagnóstico: ' + error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// DETECÇÃO DE DESCONEXÃO MANUAL
router.get('/detectar-desconexao', async (req, res) => {
  try {
    logger.info('🔍 Verificando se WhatsApp foi desconectado manualmente...');
    
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient) {
      return res.json({
        disconnected: true,
        reason: 'client_not_initialized',
        action: 'restart_required'
      });
    }
    
    // Forçar verificação do status real
    await whatsappClient.checkRealConnectionStatus();
    
    const status = whatsappClient.getConnectionStatus();
    
    // Verificar se há desconexão manual
    const manualDisconnect = status.isConnected && !status.realConnectionStatus;
    
    if (manualDisconnect) {
      logger.warn('⚠️ DESCONEXÃO MANUAL DETECTADA!');
      
      // Forçar reset automático
      setTimeout(async () => {
        try {
          await whatsappClient.handleDeadConnection('manual_disconnect_detected');
        } catch (err) {
          logger.error('❌ Erro no reset automático:', err);
        }
      }, 1000);
      
      res.json({
        disconnected: true,
        reason: 'manual_disconnect',
        action: 'auto_reset_initiated',
        message: 'Desconexão manual detectada, reset automático iniciado',
        status
      });
    } else {
      res.json({
        disconnected: false,
        reason: 'connected',
        action: 'none',
        message: 'WhatsApp está conectado corretamente',
        status
      });
    }
    
  } catch (error) {
    logger.error('❌ Erro na detecção de desconexão:', error);
    res.status(500).json({
      disconnected: true,
      reason: 'detection_error',
      error: error.message
    });
  }
});

// RESET INTELIGENTE - Detecta problema e aplica solução adequada
router.get('/reset-inteligente', async (req, res) => {
  try {
    logger.info('🧠 Executando reset inteligente...');
    
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient) {
      return res.json({
        success: false,
        action: 'restart_required',
        message: 'Cliente WhatsApp não inicializado. Reinicie o servidor.'
      });
    }
    
    // Obter diagnósticos
    const diagnostics = await whatsappClient.getDiagnostics();
    
    let action = 'none';
    let message = '';
    
    // Decidir ação baseada no diagnóstico
    if (diagnostics.isConnected && !diagnostics.realConnectionStatus) {
      // Conexão fantasma - reset forçado
      action = 'force_reset';
      message = 'Conexão fantasma detectada, executando reset forçado';
      await whatsappClient.handleDeadConnection('ghost_connection');
      
    } else if (!diagnostics.isConnected && diagnostics.sessionCorrupted) {
      // Sessão corrompida - limpeza completa
      action = 'clear_session';
      message = 'Sessão corrompida detectada, limpando e reinicializando';
      await whatsappClient.clearSession();
      setTimeout(() => whatsappClient.initialize().catch(() => {}), 2000);
      
    } else if (!diagnostics.isConnected && !diagnostics.qrCodeGenerated) {
      // Não conectado e sem QR - forçar geração
      action = 'force_qr';
      message = 'Forçando geração de novo QR Code';
      await whatsappClient.forceQRGeneration();
      
    } else if (diagnostics.missedHeartbeats >= 3) {
      // Muitos heartbeats perdidos - reconexão
      action = 'reconnect';
      message = 'Muitos heartbeats perdidos, forçando reconexão';
      await whatsappClient.handleDeadConnection('heartbeat_failure');
      
    } else if (diagnostics.isConnected && diagnostics.realConnectionStatus) {
      // Tudo OK
      action = 'none';
      message = 'Sistema funcionando corretamente, nenhuma ação necessária';
      
    } else {
      // Caso genérico - reset padrão
      action = 'standard_reset';
      message = 'Executando reset padrão';
      await whatsappClient.clearSession();
      setTimeout(() => whatsappClient.initialize().catch(() => {}), 2000);
    }
    
    res.json({
      success: true,
      action,
      message,
      timestamp: new Date().toISOString(),
      diagnostics: {
        isConnected: diagnostics.isConnected,
        realConnectionStatus: diagnostics.realConnectionStatus,
        qrCodeGenerated: diagnostics.qrCodeGenerated,
        missedHeartbeats: diagnostics.missedHeartbeats,
        sessionCorrupted: diagnostics.sessionCorrupted
      }
    });
    
  } catch (error) {
    logger.error('❌ Erro no reset inteligente:', error);
    res.status(500).json({
      success: false,
      action: 'error',
      error: 'Erro no reset inteligente: ' + error.message
    });
  }
});

// RESET NUCLEAR - Limpeza total e reinicialização
router.get('/reset-nuclear', async (req, res) => {
  try {
    logger.info('💥 Executando RESET NUCLEAR - Limpeza total do sistema...');
    
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (whatsappClient) {
      // Parar todos os monitoramentos
      whatsappClient.stopMonitoring();
      
      // Desconectar completamente
      await whatsappClient.disconnect();
      
      // Aguardar um pouco
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Limpeza total
      await whatsappClient.clearSession();
      
      // Aguardar mais um pouco
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Reinicializar do zero
      await whatsappClient.initialize();
    }
    
    res.json({
      success: true,
      action: 'nuclear_reset',
      message: 'Reset nuclear executado. Sistema reinicializado do zero.',
      timestamp: new Date().toISOString(),
      instructions: [
        'Aguarde 30-60 segundos para inicialização completa',
        'Acesse /qr para verificar se QR Code foi gerado',
        'Se necessário, use /api/force-qr-generation'
      ]
    });
    
  } catch (error) {
    logger.error('❌ Erro no reset nuclear:', error);
    res.status(500).json({
      success: false,
      action: 'error',
      error: 'Erro no reset nuclear: ' + error.message
    });
  }
});

// FORÇAR GERAÇÃO DE QR CODE
router.get('/force-qr-generation', async (req, res) => {
  try {
    logger.info('🔄 Forçando geração de QR Code...');
    
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient) {
      return res.status(503).json({
        success: false,
        message: 'Cliente WhatsApp não inicializado',
        qrAvailable: false
      });
    }
    
    // Forçar geração de QR
    const qrGenerated = await whatsappClient.forceQRGeneration();
    
    if (qrGenerated) {
      res.json({
        success: true,
        message: 'QR Code gerado com sucesso!',
        qrAvailable: true,
        timestamp: new Date().toISOString(),
        instructions: [
          'Acesse /qr para visualizar o QR Code',
          'Escaneie com seu WhatsApp',
          'Aguarde a confirmação de conexão'
        ]
      });
    } else {
      res.json({
        success: false,
        message: 'Falha ao gerar QR Code. Tente o reset nuclear.',
        qrAvailable: false,
        timestamp: new Date().toISOString(),
        suggestion: 'Use /api/reset-nuclear para limpeza completa'
      });
    }
    
  } catch (error) {
    logger.error('❌ Erro ao forçar geração de QR:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao forçar QR Code: ' + error.message,
      qrAvailable: false
    });
  }
});

// MONITORAMENTO CONTÍNUO - Verificação automática
router.get('/monitoramento-status', (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient) {
      return res.json({
        monitoring: false,
        reason: 'client_not_initialized'
      });
    }
    
    const status = whatsappClient.getConnectionStatus();
    
    res.json({
      monitoring: true,
      heartbeatActive: status.heartbeatActive,
      monitoringActive: status.monitoringActive,
      lastHeartbeat: status.lastHeartbeatResponse,
      lastConnectionCheck: status.lastConnectionCheck,
      missedHeartbeats: status.missedHeartbeats,
      connectionStatus: {
        internal: status.isConnected,
        real: status.realConnectionStatus,
        consistent: status.isConnected === status.realConnectionStatus
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('❌ Erro no status de monitoramento:', error);
    res.status(500).json({
      monitoring: false,
      error: error.message
    });
  }
});

// ===== ENDPOINTS ORIGINAIS MANTIDOS =====

// Status detalhado do WhatsApp
router.get('/whatsapp/session-status', (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient) {
      return res.json({
        initialized: false,
        connected: false,
        qrAvailable: false,
        pairingAvailable: false,
        qrCode: null,
        pairingCode: null,
        error: 'Cliente não inicializado'
      });
    }
    
    const status = whatsappClient.getConnectionStatus();
    
    res.json({
      initialized: true,
      connected: status.isConnected,
      realConnected: status.realConnectionStatus,
      qrAvailable: status.qrCodeGenerated,
      pairingAvailable: !!whatsappClient.currentPairingCode,
      qrCode: whatsappClient.currentQRCode,
      pairingCode: whatsappClient.currentPairingCode,
      retryCount: status.currentRetry,
      maxRetries: status.maxRetries,
      circuitBreaker: status.circuitBreakerState,
      user: status.user,
      heartbeatActive: status.heartbeatActive,
      monitoringActive: status.monitoringActive,
      missedHeartbeats: status.missedHeartbeats,
      lastHeartbeat: status.lastHeartbeatResponse,
      connectionAttempts: status.connectionAttempts,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('❌ Erro ao obter status da sessão:', error);
    res.status(500).json({
      error: 'Erro ao obter status: ' + error.message
    });
  }
});

// Status rápido do WhatsApp
router.get('/whatsapp/status', (req, res) => {
  const wa = req.app.locals.whatsappClient;
  if (!wa) return res.status(503).json({ error: 'whatsapp client not ready' });
  
  const status = wa.getConnectionStatus();
  return res.json({
    isConnected: status.isConnected,
    realConnected: status.realConnectionStatus,
    qrGenerated: status.qrCodeGenerated,
    monitoring: status.heartbeatActive && status.monitoringActive
  });
});

// Status detalhado do sistema
router.get('/status', async (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    const jobScheduler = req.app.locals.jobScheduler;
    
    const status = {
      whatsapp: whatsappClient?.getConnectionStatus() || { isConnected: false },
      jobs: {},
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    };

    // Jobs info
    if (jobScheduler && jobScheduler.jobs) {
      for (const [name, job] of Object.entries(jobScheduler.jobs)) {
        status.jobs[name] = {
          description: job.description || 'Job description not available',
          schedule: job.schedule || 'Schedule not available',
          timezone: job.timezone || 'UTC',
          lastRun: job.lastRun || null,
          nextRun: job.nextRun || null,
          runCount: job.runCount || 0,
          errorCount: job.errorCount || 0
        };
      }
    }

    res.json(status);
  } catch (error) {
    logger.error('❌ Erro ao obter status:', error);
    res.status(500).json({ error: 'Erro ao obter status: ' + error.message });
  }
});

// ===== ENDPOINTS DE GRUPOS =====

// Listar grupos
router.get('/grupos', async (req, res) => {
  try {
    const grupos = await database.getGrupos();
    res.json(grupos);
  } catch (error) {
    logger.error('❌ Erro ao listar grupos:', error);
    res.status(500).json({ error: 'Erro ao listar grupos: ' + error.message });
  }
});

// Grupos ativos
router.get('/grupos/ativos', async (req, res) => {
  try {
    const grupos = await database.getGruposAtivos();
    res.json(grupos);
  } catch (error) {
    logger.error('❌ Erro ao listar grupos ativos:', error);
    res.status(500).json({ error: 'Erro ao listar grupos ativos: ' + error.message });
  }
});

// Sincronizar grupos do WhatsApp
router.post('/grupos/sincronizar', async (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient || !whatsappClient.isConnected || !whatsappClient.realConnectionStatus) {
      return res.status(503).json({ 
        error: 'WhatsApp não está conectado',
        connected: false,
        suggestion: 'Use /api/detectar-desconexao para verificar o problema'
      });
    }

    logger.info('🔄 Iniciando sincronização de grupos...');
    
    // Buscar grupos do WhatsApp com retry
    const gruposWhatsApp = await whatsappClient.getGroups();
    
    let novos = 0;
    let atualizados = 0;
    
    for (const grupo of gruposWhatsApp) {
      const existe = await database.getGrupo(grupo.jid);
      
      if (existe) {
        // Atualizar grupo existente
        await database.updateGrupo(grupo.jid, {
          nome: grupo.nome,
          participantes: grupo.participantes,
          isAdmin: grupo.isAdmin,
          updatedAt: new Date().toISOString()
        });
        atualizados++;
        logger.debug(`🔄 Grupo atualizado: ${grupo.nome}`);
      } else {
        // Adicionar novo grupo
        await database.addGrupo({
          jid: grupo.jid,
          nome: grupo.nome,
          participantes: grupo.participantes,
          isAdmin: grupo.isAdmin,
          ativo: true,
          sorteios: grupo.isAdmin, // Ativar sorteios apenas se for admin
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        novos++;
        logger.info(`➕ Novo grupo adicionado: ${grupo.nome}`);
      }
    }

    logger.info(`✅ Sincronização concluída: ${novos} novos, ${atualizados} atualizados`);
    
    res.json({
      success: true,
      message: `Sincronização concluída: ${novos} novos grupos, ${atualizados} atualizados`,
      novos,
      atualizados,
      total: gruposWhatsApp.length
    });

  } catch (error) {
    logger.error('❌ Erro na sincronização de grupos:', error);
    res.status(500).json({ 
      error: 'Erro na sincronização: ' + error.message,
      success: false,
      suggestion: 'Verifique se WhatsApp está realmente conectado com /api/diagnostico-completo'
    });
  }
});

// Toggle ativo/inativo de um grupo
router.put('/grupos/:jid/toggle', async (req, res) => {
  try {
    const { jid } = req.params;
    const { campo } = req.body; // 'ativo' ou 'sorteios'
    
    if (!campo || !['ativo', 'sorteios'].includes(campo)) {
      return res.status(400).json({ error: 'Campo deve ser "ativo" ou "sorteios"' });
    }
    
    const grupo = await database.getGrupo(jid);
    if (!grupo) {
      return res.status(404).json({ error: 'Grupo não encontrado' });
    }
    
    const novoValor = !grupo[campo];
    await database.updateGrupo(jid, { 
      [campo]: novoValor,
      updatedAt: new Date().toISOString()
    });
    
    logger.info(`🔄 Grupo ${grupo.nome}: ${campo} = ${novoValor}`);
    
    res.json({
      success: true,
      message: `${campo} do grupo alterado para ${novoValor}`,
      grupo: grupo.nome,
      campo,
      valor: novoValor
    });
    
  } catch (error) {
    logger.error('❌ Erro ao alterar grupo:', error);
    res.status(500).json({ error: 'Erro ao alterar grupo: ' + error.message });
  }
});

// ===== ENDPOINTS DE SORTEIOS =====

// Processar sorteio manual
router.post('/sorteios/processar', async (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient || !whatsappClient.isConnected || !whatsappClient.realConnectionStatus) {
      return res.status(503).json({ 
        error: 'WhatsApp não está conectado',
        connected: false,
        suggestion: 'Use /api/detectar-desconexao para verificar o problema'
      });
    }

    logger.info('🎯 Processando sorteio manual...');
    
    const resultado = await SorteiosModule.processarSorteios(whatsappClient);
    
    res.json({
      success: true,
      message: 'Sorteio processado com sucesso',
      resultado
    });
    
  } catch (error) {
    logger.error('❌ Erro ao processar sorteio:', error);
    res.status(500).json({ 
      error: 'Erro ao processar sorteio: ' + error.message,
      success: false
    });
  }
});

// Testar conexão WhatsApp
router.get('/test/whatsapp', async (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient) {
      return res.json({
        connected: false,
        error: 'Cliente não inicializado'
      });
    }
    
    const status = whatsappClient.getConnectionStatus();
    
    res.json({
      connected: status.isConnected,
      realConnected: status.realConnectionStatus,
      consistent: status.isConnected === status.realConnectionStatus,
      qrGenerated: status.qrCodeGenerated,
      user: status.user,
      retries: `${status.currentRetry}/${status.maxRetries}`,
      circuitBreaker: status.circuitBreakerState,
      heartbeat: status.heartbeatActive,
      monitoring: status.monitoringActive,
      missedHeartbeats: status.missedHeartbeats,
      connectionAttempts: `${status.connectionAttempts}/${status.maxConnectionAttempts}`
    });
    
  } catch (error) {
    logger.error('❌ Erro no teste WhatsApp:', error);
    res.status(500).json({ 
      connected: false,
      error: error.message
    });
  }
});

module.exports = router;

