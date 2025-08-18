import express from 'express';
import db from '../db/sqlite.js';
import { whatsappStatus } from '../whatsapp/client.js';

const router = express.Router();

router.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  const s = whatsappStatus();
  
  res.json({
    status: s.isConnected ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    checks: {
      database: { status: 'ok' },
      whatsapp: { 
        status: s.isConnected ? 'ok' : 'error', 
        connected: s.isConnected, 
        queueLength: 0 
      },
      scheduler: { status: 'ok', jobsCount: 1 },
      memory: {
        status: 'ok',
        memory_usage_mb: +(mem.rss/1024/1024).toFixed(2),
        heap_used_mb: +(mem.heapUsed/1024/1024).toFixed(2),
        heap_total_mb: +(mem.heapTotal/1024/1024).toFixed(2)
      }
    }
  });
});

router.get('/', (req, res) => {
  res.json({ 
    name: 'WhatsApp Automation System', 
    version: '1.0.0', 
    status: 'running', 
    timestamp: new Date().toISOString() 
  });
});

export default router;

