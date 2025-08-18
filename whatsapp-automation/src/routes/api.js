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
  // número -> contato individual
  const num = t.replace(/\D/g, '');
  if (num.length < 10) return null;
  return `${num}@s.whatsapp.net`;
}

// ===== ENDPOINT SIMPLES DE RESET WHATSAPP =====

// Reset simples e direto do WhatsApp (GET para facilitar acesso)
router.get('/reset-whatsapp', async (req, res) => {
  try {
    logger.info('🔄 Iniciando reset simples do WhatsApp...');
    
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient) {
      logger.warn('⚠️ Cliente WhatsApp não inicializado, criando novo...');
      // Se não existe, será criado na próxima inicialização
      return res.json({ 
        success: true, 
        message: 'Cliente será reinicializado. Aguarde 30 segundos e acesse /qr',
        action: 'restart_required'
      });
    }
    
    // Usar método forceQRGeneration para garantir QR Code
    logger.info('🚀 Forçando geração de QR Code...');
    const qrGenerated = await whatsappClient.forceQRGeneration();
    
    if (qrGenerated) {
      logger.info('✅ Reset concluído com QR Code gerado');
      res.json({ 
        success: true, 
        message: 'WhatsApp resetado com sucesso! QR Code está pronto. Acesse /qr para escanear.',
        timestamp: new Date().toISOString(),
        action: 'qr_ready',
        qrAvailable: true
      });
    } else {
      logger.warn('⚠️ Reset concluído mas QR Code não foi gerado');
      res.json({ 
        success: true, 
        message: 'WhatsApp resetado. Aguarde alguns segundos e tente /qr novamente.',
        timestamp: new Date().toISOString(),
        action: 'qr_pending',
        qrAvailable: false,
        triedPairing: false
      });
    }
    
  } catch (error) {
    logger.error('❌ Erro no reset do WhatsApp:', error);
    res.status(500).json({ 
      success: false,
      error: 'Erro no reset: ' + error.message,
      action: 'retry_later'
    });
  }
});

// Endpoint adicional para forçar QR Code especificamente
router.get('/force-qr', async (req, res) => {
  try {
    logger.info('🔄 Forçando geração de QR Code...');
    
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient) {
      return res.status(503).json({ 
        success: false,
        error: 'Cliente WhatsApp não inicializado'
      });
    }
    
    const qrGenerated = await whatsappClient.forceQRGeneration();
    
    res.json({ 
      success: qrGenerated,
      message: qrGenerated ? 
        'QR Code gerado com sucesso! Acesse /qr para escanear.' :
        'Falha ao gerar QR Code. Tente novamente.',
      qrAvailable: qrGenerated,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('❌ Erro ao forçar QR Code:', error);
    res.status(500).json({ 
      success: false,
      error: 'Erro ao forçar QR Code: ' + error.message
    });
  }
});

// Status rápido do WhatsApp
router.get('/whatsapp/status', (req, res) => {
  const wa = req.app.locals.whatsappClient;
  if (!wa) return res.status(503).json({ error: 'whatsapp client not ready' });
  return res.json(wa.getConnectionStatus?.() || { isConnected: !!wa.isConnected });
});

// Status detalhado do sistema
router.get('/status', async (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    const jobScheduler = req.app.locals.jobScheduler;
    
    const status = {
      whatsapp: whatsappClient?.getConnectionStatus() || { isConnected: false },
      jobs: jobScheduler?.getJobsStatus() || { initialized: false },
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    };
    
    res.json(status);
  } catch (error) {
    logger.error('❌ Erro ao obter status:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== ENDPOINTS DE GRUPOS =====

// Listar grupos
router.get('/grupos', async (req, res) => {
  try {
    const db = await database.getConnection();
    const grupos = await db.all(`
      SELECT jid, nome, ativo_sorteios, enabled, created_at 
      FROM grupos_whatsapp 
      ORDER BY nome
    `);
    
    res.json(grupos);
  } catch (error) {
    logger.error('❌ Erro ao obter grupos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Sincronizar grupos do WhatsApp
router.post('/grupos/sincronizar', async (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient) {
      return res.status(503).json({ 
        error: 'Cliente WhatsApp não inicializado',
        connected: false 
      });
    }
    
    if (!whatsappClient.isConnected) {
      return res.status(400).json({ 
        error: 'WhatsApp não está conectado. Conecte primeiro via QR Code.',
        connected: false 
      });
    }
    
    logger.info('🔄 Iniciando sincronização de grupos...');
    
    let grupos;
    try {
      grupos = await whatsappClient.getGroups();
    } catch (groupError) {
      logger.error('❌ Erro ao buscar grupos do WhatsApp:', groupError);
      return res.status(500).json({ 
        error: 'Erro ao buscar grupos do WhatsApp: ' + groupError.message,
        connected: whatsappClient.isConnected 
      });
    }
    
    const db = await database.getConnection();
    
    let novosGrupos = 0;
    let gruposAtualizados = 0;
    
    for (const grupo of grupos) {
      try {
        const existe = await db.get('SELECT jid FROM grupos_whatsapp WHERE jid = ?', [grupo.jid]);
        
        if (!existe) {
          await db.run(`
            INSERT INTO grupos_whatsapp (jid, nome, ativo_sorteios, enabled, created_at)
            VALUES (?, ?, 0, 1, datetime('now'))
          `, [grupo.jid, grupo.nome]);
          novosGrupos++;
          logger.info(`➕ Novo grupo adicionado: ${grupo.nome}`);
        } else {
          // Atualizar nome se mudou
          await db.run('UPDATE grupos_whatsapp SET nome = ? WHERE jid = ?', [grupo.nome, grupo.jid]);
          gruposAtualizados++;
        }
      } catch (dbError) {
        logger.error(`❌ Erro ao processar grupo ${grupo.nome}:`, dbError);
        // Continua com os outros grupos
      }
    }
    
    logger.info(`✅ Sincronização concluída: ${novosGrupos} novos, ${gruposAtualizados} atualizados`);
    
    res.json({ 
      success: true, 
      novosGrupos, 
      gruposAtualizados,
      totalGrupos: grupos.length,
      message: `${novosGrupos} novos grupos sincronizados`
    });
  } catch (error) {
    logger.error('❌ Erro ao sincronizar grupos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar configuração de grupo
router.put('/grupos/:jid/toggle', async (req, res) => {
  try {
    const { jid } = req.params;
    const { ativo_sorteios, enabled } = req.body;
    
    const db = await database.getConnection();
    
    // Verificar se grupo existe
    const grupo = await db.get('SELECT * FROM grupos_whatsapp WHERE jid = ?', [jid]);
    if (!grupo) {
      return res.status(404).json({ error: 'Grupo não encontrado' });
    }
    
    await db.run(`
      UPDATE grupos_whatsapp 
      SET ativo_sorteios = ?, enabled = ?, updated_at = datetime('now')
      WHERE jid = ?
    `, [ativo_sorteios ? 1 : 0, enabled ? 1 : 0, jid]);
    
    logger.info(`🔄 Grupo ${grupo.nome} atualizado: sorteios=${ativo_sorteios}, enabled=${enabled}`);
    
    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Erro ao atualizar grupo:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obter grupos ativos
router.get('/grupos/ativos', async (req, res) => {
  try {
    const db = await database.getConnection();
    const grupos = await db.all(`
      SELECT jid, nome, ativo_sorteios, enabled 
      FROM grupos_whatsapp 
      WHERE enabled = 1 AND ativo_sorteios = 1
      ORDER BY nome
    `);
    
    res.json(grupos);
  } catch (error) {
    logger.error('❌ Erro ao obter grupos ativos:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== ENDPOINTS DE SORTEIOS =====

// Processar sorteio manual
router.post('/sorteios/processar', async (req, res) => {
  try {
    const { codigo } = req.body;
    
    if (!codigo) {
      return res.status(400).json({ error: 'Código do sorteio é obrigatório' });
    }
    
    const sorteiosModule = new SorteiosModule();
    const resultado = await sorteiosModule.processarSorteioManual(codigo);
    
    logger.info(`✅ Sorteio ${codigo} processado manualmente`);
    
    res.json(resultado);
  } catch (error) {
    logger.error('❌ Erro ao processar sorteio manual:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obter estatísticas de sorteios
router.get('/sorteios/estatisticas', async (req, res) => {
  try {
    const sorteiosModule = new SorteiosModule();
    const estatisticas = await sorteiosModule.obterEstatisticas();
    
    res.json(estatisticas);
  } catch (error) {
    logger.error('❌ Erro ao obter estatísticas:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== ENDPOINTS DE JOBS =====

// Executar job manualmente
router.post('/jobs/:name/run', async (req, res) => {
  try {
    const { name } = req.params;
    const jobScheduler = req.app.locals.jobScheduler;
    
    if (!jobScheduler) {
      return res.status(400).json({ error: 'Agendador não disponível' });
    }
    
    await jobScheduler.runJobNow(name);
    
    logger.info(`🔄 Job ${name} executado manualmente`);
    
    res.json({ success: true, message: `Job ${name} executado com sucesso` });
  } catch (error) {
    logger.error(`❌ Erro ao executar job ${req.params.name}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Status dos jobs
router.get('/jobs/status', (req, res) => {
  try {
    const jobScheduler = req.app.locals.jobScheduler;
    
    if (!jobScheduler) {
      return res.status(503).json({ error: 'Agendador não disponível' });
    }
    
    const status = jobScheduler.getJobsStatus();
    res.json(status);
  } catch (error) {
    logger.error('❌ Erro ao obter status dos jobs:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== ENDPOINTS DE TEXTOS =====

// Listar textos de sorteios
router.get('/textos', async (req, res) => {
  try {
    const db = await database.getConnection();
    const textos = await db.all(`
      SELECT * FROM textos_sorteios 
      ORDER BY id
    `);
    
    res.json(textos);
  } catch (error) {
    logger.error('❌ Erro ao obter textos:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== ENDPOINTS DE CUPONS =====

// Obter cupons atuais
router.get('/cupons', async (req, res) => {
  try {
    const db = await database.getConnection();
    const cupom = await db.get(`
      SELECT * FROM cupons_atuais 
      ORDER BY atualizado_em DESC 
      LIMIT 1
    `);
    
    res.json(cupom || { cupom1: '', cupom2: '' });
  } catch (error) {
    logger.error('❌ Erro ao obter cupons:', error);
    res.status(500).json({ error: error.message });
  }
});

// Envio de texto (smoke test)
router.post('/messages/send', async (req, res) => {
  try {
    const wa = req.app.locals.whatsappClient;
    if (!wa) {
      return res.status(503).json({ error: 'whatsapp client not ready' });
    }
    if (!wa.isConnected) {
      return res.status(503).json({ error: 'whatsapp not connected' });
    }

    const { to, message } = req.body || {};
    const jid = toJid(to);
    if (!jid) return res.status(400).json({ error: 'parâmetro "to" inválido' });
    if (!message) return res.status(400).json({ error: 'parâmetro "message" obrigatório' });

    const result = await wa.sock.sendMessage(jid, { text: message });
    return res.json({ ok: true, id: result?.key?.id || null });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ===== ENDPOINTS DE SESSÃO WHATSAPP =====

// Limpar sessão WhatsApp (força nova conexão)
router.post('/whatsapp/clear-session', async (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient) {
      return res.status(503).json({ 
        error: 'Cliente WhatsApp não inicializado',
        success: false 
      });
    }
    
    logger.info('🗑️ Iniciando limpeza de sessão WhatsApp...');
    
    // Limpar sessão usando método do cliente
    await whatsappClient.clearSession();
    
    // Aguardar um pouco para garantir limpeza
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Reinicializar cliente
    logger.info('🔄 Reinicializando cliente WhatsApp...');
    await whatsappClient.initialize();
    
    logger.info('✅ Sessão limpa e cliente reinicializado');
    
    res.json({ 
      success: true, 
      message: 'Sessão limpa com sucesso. Novo QR Code será gerado.',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('❌ Erro ao limpar sessão WhatsApp:', error);
    res.status(500).json({ 
      error: 'Erro ao limpar sessão: ' + error.message,
      success: false 
    });
  }
});

// Status detalhado da sessão WhatsApp
router.get('/whatsapp/session-status', async (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient) {
      return res.json({
        initialized: false,
        connected: false,
        qrAvailable: false,
        pairingAvailable: false,
        message: 'Cliente não inicializado'
      });
    }
    
    const status = whatsappClient.getConnectionStatus();
    
    res.json({
      initialized: true,
      connected: status.isConnected,
      qrAvailable: status.qrCodeGenerated,
      pairingAvailable: !!whatsappClient.getPairingCode(),
      qrCode: whatsappClient.getQRCode(),
      pairingCode: whatsappClient.getPairingCode(),
      retryCount: status.currentRetry,
      maxRetries: status.maxRetries,
      circuitBreaker: status.circuitBreakerState,
      user: status.user,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('❌ Erro ao obter status da sessão:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
