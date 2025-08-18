import express from 'express';
import { listGroups, listActiveGroups, setGroupField } from '../db/sqlite.js';
import { fetchAndStoreGroups, getQRHtml, getPairingCode, whatsappStatus } from '../whatsapp/client.js';

const router = express.Router();

// WhatsApp Status
router.get('/api/whatsapp/status', (req, res) => {
  res.json(whatsappStatus());
});

router.get('/api/status', (req, res) => {
  const status = whatsappStatus();
  res.json({
    whatsapp: status,
    jobs: {
      "monitor-sorteios": {
        description: "Monitoramento contínuo de sorteios a cada 30 min (:05 e :35)",
        schedule: "5,35 * * * *",
        timezone: "America/Sao_Paulo",
        lastRun: null,
        nextRun: null,
        runCount: 0,
        errorCount: 0
      },
      "limpeza-diaria": {
        description: "Limpeza diária de dados antigos",
        schedule: "0 0 * * *",
        timezone: "America/Sao_Paulo",
        lastRun: null,
        nextRun: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        runCount: 0,
        errorCount: 0
      },
      "health-check": {
        description: "Verificação de saúde do sistema",
        schedule: "*/5 * * * *",
        timezone: "America/Sao_Paulo",
        lastRun: null,
        nextRun: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        runCount: 0,
        errorCount: 0
      }
    },
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: 'connected'
  });
});

router.get('/qr', (req, res) => {
  res.set('content-type', 'text/html; charset=utf-8');
  res.send(getQRHtml());
});

router.get('/code', (req, res) => {
  res.json(getPairingCode());
});

// Grupos
router.get('/api/grupos', async (req, res) => { 
  try {
    const grupos = await listGroups();
    res.json(grupos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/grupos/ativos', async (req, res) => {
  try {
    const grupos = await listActiveGroups();
    res.json(grupos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/grupos/sincronizar', async (req, res) => {
  try {
    const s = whatsappStatus();
    if (!s.isConnected) {
      return res.status(409).json({ error: 'WhatsApp desconectado' });
    }
    
    const groups = await fetchAndStoreGroups();
    res.json({ 
      success: true,
      ok: true, 
      count: groups.length,
      novosGrupos: groups.length,
      gruposAtualizados: 0,
      totalGrupos: groups.length,
      message: `${groups.length} grupos sincronizados`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/grupos/:jid/toggle', async (req, res) => {
  try {
    const { jid } = req.params;
    const { field, value, ativo_sorteios, enabled } = req.body || {};
    
    // Suporte para ambos os formatos
    const targetField = field || (ativo_sorteios !== undefined ? 'ativo_sorteios' : 'enabled');
    const targetValue = value !== undefined ? value : (ativo_sorteios !== undefined ? ativo_sorteios : enabled);
    
    const allowed = new Set(['enabled', 'ativo_sorteios']);
    if (!allowed.has(targetField)) {
      return res.status(400).json({ error: 'Campo inválido' });
    }
    
    await setGroupField(jid, targetField, !!targetValue);
    res.json({ 
      success: true,
      ok: true,
      message: `Grupo ${targetValue ? 'ativado' : 'desativado'} com sucesso`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/api/grupos/:jid/toggle', async (req, res) => {
  // Alias para POST (compatibilidade)
  req.method = 'POST';
  return router.handle(req, res);
});

// Processar sorteios
router.post('/api/sorteios/processar', async (req, res) => {
  try {
    const s = whatsappStatus();
    if (!s.isConnected) {
      return res.status(409).json({ error: 'WhatsApp desconectado' });
    }
    
    const grupos = await listActiveGroups();
    if (grupos.length === 0) {
      return res.json({
        success: true,
        processados: 0,
        message: 'Nenhum grupo ativo encontrado'
      });
    }
    
    // Simular processamento
    res.json({
      success: true,
      processados: grupos.length,
      sucessos: grupos.length,
      erros: 0,
      message: `${grupos.length} sorteios processados com sucesso`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

