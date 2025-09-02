/ Adicione estas configurações no arquivo admin-wa-bundle.js

// 1. Aumentar timeout da sessão WhatsApp
const WHATSAPP_SESSION_CONFIG = {
  authTimeoutMs: 60000,  // Aumentar para 60 segundos
  qrMaxRetries: 5,       // Número máximo de tentativas do QR
  linkingMethod: {
    phone: {
      number: ''  // Deixe vazio para gerar QR
    }
  },
  // Configurações importantes para estabilidade
  defaultQueryTimeoutMs: 120000,
  takeoverOnConflict: false,
  takeoverTimeoutMs: 0,
  markOnlineOnConnect: true,
  connectTimeoutMs: 60000,
  // Adicionar user agent para evitar detecção
  userAgent: 'WhatsApp/2.2412.54 Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  // Configurações de reconexão
  retryRequestDelayMs: 2000,
  maxReconnectAttempts: 5
};

// 2. Modificar a função de conexão no Baileys
async function connectWhatsApp() {
  try {
    // Limpar sessão anterior se houver problemas
    if (lastQRDataUrl && !connected) {
      console.log('Limpando sessão anterior...');
      await clearAuthState();
    }
    
    // Configurar o socket com as novas configurações
    const sock = makeWASocket({
      ...WHATSAPP_SESSION_CONFIG,
      auth: state,
      logger: pino({ level: 'debug' }), // Ativar logs para debug
      browser: ['WhatsApp Automation', 'Chrome', '120.0.0'],
      syncFullHistory: false, // Não sincronizar histórico completo
      getMessage: async (key) => {
        // Implementar busca de mensagem se necessário
        return { conversation: 'placeholder' };
      }
    });

    // Adicionar listeners importantes
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log('QR Code recebido');
        lastQRDataUrl = await QRCode.toDataURL(qr);
        connected = false;
        connecting = true;
      }
      
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
        console.log('Conexão fechada, reconectar?', shouldReconnect);
        
        if (shouldReconnect) {
          setTimeout(() => connectWhatsApp(), 5000); // Reconectar após 5 segundos
        } else {
          // Limpar sessão se deslogado
          await clearAuthState();
          connected = false;
          connecting = false;
        }
      } else if (connection === 'open') {
        console.log('WhatsApp conectado com sucesso!');
        connected = true;
        connecting = false;
        lastQRDataUrl = null;
      }
    });

    // Salvar credenciais quando atualizadas
    sock.ev.on('creds.update', saveCreds);

    return sock;
  } catch (error) {
    console.error('Erro ao conectar:', error);
    connecting = false;
    throw error;
  }
}

// 3. Função para limpar estado de autenticação
async function clearAuthState() {
  try {
    // Limpar arquivos de sessão se existirem
    const sessionPath = './whatsapp-session';
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    
    // Reinicializar estado
    state = await useMultiFileAuthState(sessionPath);
    
    console.log('Estado de autenticação limpo');
  } catch (error) {
    console.error('Erro ao limpar estado:', error);
  }
}

// 4. Melhorar o endpoint de status no Express
router.get('/admin/wa/status', (req, res) => {
  // Adicionar timeout para evitar travamento
  const timeout = setTimeout(() => {
    res.json({
      ok: false,
      connected: false,
      connecting: false,
      error: 'Timeout ao verificar status'
    });
  }, 5000);

  try {
    res.json({
      ok: true,
      connected: !!connected,
      connecting: !!connecting,
      qr: lastQRDataUrl || null,
      timestamp: new Date().toISOString()
    });
    clearTimeout(timeout);
  } catch (error) {
    clearTimeout(timeout);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// 5. Melhorar endpoint de conexão
router.post('/admin/wa/connect', async (req, res) => {
  if (connected) {
    return res.json({ ok: true, message: 'Já conectado' });
  }
  
  if (connecting) {
    return res.json({ ok: true, message: 'Conexão em andamento' });
  }

  try {
    connecting = true;
    connectWhatsApp().catch(err => {
      console.error('Erro na conexão:', err);
      connecting = false;
    });
    
    res.json({ ok: true, message: 'Iniciando conexão...' });
  } catch (error) {
    connecting = false;
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 6. Adicionar endpoint de reset melhorado
router.post('/admin/wa/reset', async (req, res) => {
  try {
    // Desconectar se estiver conectado
    if (sock) {
      await sock.logout();
      sock.end();
    }
    
    // Limpar variáveis
    connected = false;
    connecting = false;
    lastQRDataUrl = null;
    sock = null;
    
    // Limpar estado de autenticação
    await clearAuthState();
    
    res.json({ ok: true, message: 'Sessão resetada com sucesso' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});
