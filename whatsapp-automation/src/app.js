import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { CONFIG } from './config.js';
import { httpLogger, log, err } from './logger.js';
import { startWhatsApp } from './whatsapp/client.js';

// Importar rotas
import healthRoutes from './routes/health.js';
import apiRoutes from './routes/api.js';
import adminRoutes from './routes/admin.js';

const app = express();

// Middlewares básicos
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(httpLogger);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir arquivos estáticos
app.use('/public', express.static('public'));

// Rotas
app.use('/', healthRoutes);
app.use('/', apiRoutes);
app.use('/', adminRoutes);

// Middleware de erro
app.use((err, req, res, next) => {
  console.error('Erro na aplicação:', err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// Rota 404
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado', path: req.originalUrl });
});

// Inicializar aplicação
async function init() {
  try {
    log('🚀 Iniciando WhatsApp Automation...');
    
    // Inicializar WhatsApp
    log('📱 Iniciando cliente WhatsApp...');
    await startWhatsApp();
    log('✅ Cliente WhatsApp iniciado');
    
    // Iniciar servidor
    const server = app.listen(CONFIG.port, '0.0.0.0', () => {
      log(\`🌐 Servidor rodando na porta \${CONFIG.port}\`);
      log(\`📊 Health: http://localhost:\${CONFIG.port}/health\`);
      log(\`🔗 QR Code: http://localhost:\${CONFIG.port}/qr\`);
      log(\`👤 Admin: http://localhost:\${CONFIG.port}/admin\`);
      log(\`🌍 Público: http://localhost:\${CONFIG.port}/admin/public\`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      log('🛑 Recebido SIGTERM, encerrando...');
      server.close(() => {
        log('✅ Servidor encerrado');
        process.exit(0);
      });
    });

    process.on('SIGINT', () => {
      log('🛑 Recebido SIGINT, encerrando...');
      server.close(() => {
        log('✅ Servidor encerrado');
        process.exit(0);
      });
    });

  } catch (error) {
    err('❌ Erro ao inicializar aplicação:', error);
    process.exit(1);
  }
}

// Inicializar
init().catch(err);

