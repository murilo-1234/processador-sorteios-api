// whatsapp-automation/admin-wa-bundle.js
// Versão corrigida com melhorias de conexão e estabilidade

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const pino    = require('pino');
const qrcode  = require('qrcode');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  delay
} = require('@whiskeysockets/baileys');

/** =====================  DIAGNÓSTICO (logs)  ===================== **/
const WA_DEBUG = process.env.WA_DEBUG === '1';
function ts() { return new Date().toISOString(); }
function dlog(...args) {
  console.log('[WA-ADMIN]', ts(), ...args);
}
function ddebug(...args) {
  if (WA_DEBUG) console.log('[WA-ADMIN:DEBUG]', ts(), ...args);
}
function mask(str, keep = 32) {
  if (!str || typeof str !== 'string') return String(str);
  if (str.length <= keep) return str;
  return str.slice(0, keep) + '…(' + str.length + ')';
}
/** ================================================================ **/

// ====== WHATSAPP SESSION ======
let sock = null;
let lastQRDataUrl = null;
let connecting = false;
let connected  = false;
let authState = null;
let saveCreds = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function status() {
  return { 
    ok: true, 
    connected, 
    connecting, 
    qr: lastQRDataUrl || null,
    reconnectAttempts,
    timestamp: new Date().toISOString()
  };
}

// Função para limpar completamente a sessão
async function clearSession() {
  dlog('clearSession(): limpando sessão completamente');
  
  // Desconectar socket se existir
  if (sock) {
    try {
      await sock.logout();
    } catch (e) {
      ddebug('logout() erro:', e?.message || e);
    }
    try {
      sock.end();
    } catch (e) {
      ddebug('end() erro:', e?.message || e);
    }
    sock = null;
  }
  
  // Limpar arquivos de sessão
  const authDir = path.join(process.cwd(), 'data', 'baileys');
  if (fs.existsSync(authDir)) {
    try {
      fs.rmSync(authDir, { recursive: true, force: true });
      dlog('Diretório de sessão removido');
    } catch (e) {
      dlog('Erro ao remover diretório:', e.message);
    }
  }
  
  // Resetar variáveis
  connected = false;
  connecting = false;
  lastQRDataUrl = null;
  authState = null;
  saveCreds = null;
  reconnectAttempts = 0;
}

async function connect() {
  if (connected) { 
    ddebug('connect() ignorado: já conectado'); 
    return status(); 
  }
  if (connecting) { 
    ddebug('connect() ignorado: já conectando'); 
    return status(); 
  }

  connecting = true;
  lastQRDataUrl = null;
  
  try {
    const authDir = path.join(process.cwd(), 'data', 'baileys');
    ensureDir(authDir);

    dlog('connect(): iniciando socket', { authDir });

    // Carregar ou criar estado de autenticação
    const authStateResult = await useMultiFileAuthState(authDir);
    authState = authStateResult.state;
    saveCreds = authStateResult.saveCreds;
    
    // Obter versão mais recente
    const { version } = await fetchLatestBaileysVersion();
    ddebug('versão WA-Web (Baileys):', version);

    // Configurações otimizadas para evitar timeout
    sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, pino({ level: 'silent' }))
      },
      printQRInTerminal: false,
      logger: pino({ level: WA_DEBUG ? 'debug' : 'silent' }),
      browser: ['WhatsApp Automation', 'Chrome', '120.0.0'],
      
      // Configurações importantes para estabilidade
      connectTimeoutMs: 60000, // 60 segundos para conectar
      defaultQueryTimeoutMs: 120000, // 120 segundos para queries
      keepAliveIntervalMs: 30000, // keepalive a cada 30 segundos
      retryRequestDelayMs: 2000, // delay entre tentativas
      qrTimeout: 60000, // timeout do QR em 60 segundos
      
      // Configurações de reconexão
      markOnlineOnConnect: true,
      syncFullHistory: false, // não sincronizar histórico completo
      
      // Configurações de rede
      auth_token_ttl_ms: 3600000, // 1 hora
      getMessage: async (key) => {
        // Retorna mensagem placeholder se não encontrada
        return {
          conversation: 'placeholder'
        };
      }
    });

    // Handler de atualização de credenciais
    sock.ev.on('creds.update', async () => {
      ddebug('creds.update recebido (salvando credenciais)');
      try {
        await saveCreds();
        ddebug('Credenciais salvas com sucesso');
      } catch (e) {
        dlog('Erro ao salvar credenciais:', e.message);
      }
    });

    // Handler principal de conexão
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, isOnline, isNewLogin } = update;

      // QR Code recebido
      if (qr) {
        try {
          ddebug('QR recebido (raw):', mask(qr));
          lastQRDataUrl = await qrcode.toDataURL(qr);
          dlog('QR gerado (dataURL)', { length: lastQRDataUrl.length });
          
          // Resetar tentativas de reconexão ao receber novo QR
          reconnectAttempts = 0;
        } catch (err) {
          lastQRDataUrl = null;
          dlog('Falha ao gerar dataURL do QR:', err?.message || String(err));
        }
      }

      // Conexão estabelecida
      if (connection === 'open') {
        connected = true;
        connecting = false;
        lastQRDataUrl = null;
        reconnectAttempts = 0;
        
        const me = sock?.user || {};
        dlog('✅ Conexão estabelecida com sucesso!', { 
          id: me.id,
          name: me.name,
          isNewLogin,
          isOnline 
        });
      }

      // Conexão em processo
      if (connection === 'connecting') {
        ddebug('Conectando ao WhatsApp...');
        connecting = true;
      }

      // Conexão fechada
      if (connection === 'close') {
        const boom = lastDisconnect?.error;
        const code = boom?.output?.statusCode || 
                    boom?.data?.statusCode || 
                    boom?.status || 
                    boom?.code || 
                    null;

        let reason = 'desconhecido';
        let shouldReconnect = false;

        // Mapear razões de desconexão
        switch (code) {
          case DisconnectReason.loggedOut:
            reason = 'loggedOut - sessão encerrada';
            shouldReconnect = false;
            await clearSession();
            break;
            
          case DisconnectReason.badSession:
            reason = 'badSession - sessão corrompida';
            shouldReconnect = false;
            await clearSession();
            break;
            
          case DisconnectReason.connectionClosed:
            reason = 'connectionClosed - conexão perdida';
            shouldReconnect = reconnectAttempts < MAX_RECONNECT_ATTEMPTS;
            break;
            
          case DisconnectReason.connectionLost:
            reason = 'connectionLost - conexão instável';
            shouldReconnect = reconnectAttempts < MAX_RECONNECT_ATTEMPTS;
            break;
            
          case DisconnectReason.connectionReplaced:
            reason = 'connectionReplaced - conectado em outro dispositivo';
            shouldReconnect = false;
            break;
            
          case DisconnectReason.restartRequired:
            reason = 'restartRequired - reinicialização necessária';
            shouldReconnect = true;
            break;
            
          case DisconnectReason.timedOut:
            reason = 'timedOut - tempo esgotado';
            shouldReconnect = reconnectAttempts < MAX_RECONNECT_ATTEMPTS;
            break;
            
          default:
            reason = `código ${code} - ${boom?.message || 'sem mensagem'}`;
            shouldReconnect = reconnectAttempts < MAX_RECONNECT_ATTEMPTS;
        }

        dlog('❌ Conexão fechada', {
          code,
          reason,
          message: boom?.message || String(boom || ''),
          shouldReconnect,
          reconnectAttempts
        });

        connected = false;
        lastQRDataUrl = null;

        // Tentar reconectar se apropriado
        if (shouldReconnect) {
          reconnectAttempts++;
          connecting = true;
          
          const delayTime = Math.min(5000 * reconnectAttempts, 30000); // Max 30 segundos
          dlog(`Tentando reconectar em ${delayTime/1000} segundos... (tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
          
          setTimeout(async () => {
            if (!connected && connecting) {
              await connect();
            }
          }, delayTime);
        } else {
          connecting = false;
          reconnectAttempts = 0;
        }
      }
    });

    // Handler de mensagens (para manter conexão ativa)
    sock.ev.on('messages.upsert', () => {
      ddebug('Mensagem recebida (conexão ativa)');
    });

    // Handler de erros
    sock.ev.on('error', (err) => {
      dlog('Erro no socket:', err);
    });

    return status();
    
  } catch (error) {
    dlog('Erro ao conectar:', error.message || error);
    connecting = false;
    
    // Se erro crítico, limpar sessão
    if (error.message?.includes('session') || error.message?.includes('auth')) {
      await clearSession();
    }
    
    return { 
      ok: false, 
      error: error.message || String(error),
      connected: false,
      connecting: false 
    };
  }
}

async function disconnect() {
  dlog('disconnect(): desconectando...');
  
  try {
    if (sock) {
      try {
        await sock.logout();
        ddebug('logout() executado');
      } catch (e) {
        ddebug('logout() erro (ignorado):', e?.message || e);
      }
      
      try {
        sock.end();
        ddebug('end() executado');
      } catch (e) {
        ddebug('end() erro (ignorado):', e?.message || e);
      }
    }
    
    sock = null;
    connected = false;
    connecting = false;
    lastQRDataUrl = null;
    reconnectAttempts = 0;
    
    dlog('disconnect(): concluído');
    return status();
    
  } catch (error) {
    dlog('Erro ao desconectar:', error.message || error);
    return { 
      ok: false, 
      error: error.message || String(error),
      connected: false,
      connecting: false 
    };
  }
}

async function reset() {
  dlog('reset(): resetando sessão completamente...');
  await clearSession();
  dlog('reset(): sessão limpa');
  return status();
}

// ====== ROTAS DE ADMIN (API) ======
router.get('/wa/status', async (_req, res) => {
  try {
    const st = await status();
    ddebug('GET /admin/wa/status ->', { 
      connected: st.connected, 
      connecting: st.connecting, 
      qr: !!st.qr,
      reconnectAttempts: st.reconnectAttempts 
    });
    res.json(st);
  } catch (error) {
    res.status(500).json({ 
      ok: false, 
      error: error.message || String(error) 
    });
  }
});

router.post('/wa/connect', async (_req, res) => {
  try {
    dlog('POST /admin/wa/connect');
    const st = await connect();
    res.json(st);
  } catch (error) {
    res.status(500).json({ 
      ok: false, 
      error: error.message || String(error) 
    });
  }
});

router.post('/wa/disconnect', async (_req, res) => {
  try {
    dlog('POST /admin/wa/disconnect');
    const st = await disconnect();
    res.json(st);
  } catch (error) {
    res.status(500).json({ 
      ok: false, 
      error: error.message || String(error) 
    });
  }
});

router.post('/wa/reset', async (_req, res) => {
  try {
    dlog('POST /admin/wa/reset');
    const st = await reset();
    res.json(st);
  } catch (error) {
    res.status(500).json({ 
      ok: false, 
      error: error.message || String(error) 
    });
  }
});

// ====== Redireciona /admin -> /admin/whatsapp ======
router.get('/', (_req, res) => res.redirect('/admin/whatsapp'));

// ====== PÁGINA COMPLETA /admin/whatsapp (HTML inline) ======
router.get('/whatsapp', (_req, res) => {
  const html = /* html */ `
<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8" />
  <title>Painel WhatsApp</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root{
      --bg:#0f172a; --panel:#111827; --b:#1f2937; --muted:#94a3b8; --fg:#e2e8f0; --btn:#1e293b; --accent:#0ea5e9; --danger:#ef4444;
    }
    *{box-sizing:border-box}
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px}
    .wrap{max-width:900px;margin:0 auto}
    h1{font-size:22px;margin:0 0 16px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0}
    @media (max-width: 920px){ .grid{ grid-template-columns: 1fr; } }
    .card{background:var(--panel);border:1px solid var(--b);border-radius:12px;padding:16px;min-width:0}
    button{padding:10px 14px;border-radius:10px;border:1px solid var(--b);background:var(--btn);color:var(--fg);cursor:pointer;font-size:14px}
    button:hover{background:var(--accent);border-color:var(--accent)}
    button:disabled{opacity:.5;cursor:not-allowed}
    button.danger{background:var(--danger);border-color:var(--danger)}
    button.danger:hover{background:#dc2626;border-color:#dc2626}
    pre{background:#0b1220;border:1px solid var(--b);border-radius:10px;padding:12px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;overflow:auto;max-height:240px;font-size:13px}
    a.link{color:#93c5fd;text-decoration:none}
    a.link:hover{text-decoration:underline}
    .muted{color:var(--muted)}
    .qr{display:flex;align-items:center;justify-content:center;height:280px;background:#0b1220;border:1px dashed var(--b);border-radius:12px;margin-top:12px}
    .qr img{max-width:260px;max-height:260px;border-radius:8px;background:#fff}
    .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .dot{width:10px;height:10px;border-radius:999px;display:inline-block;vertical-align:middle;margin-right:6px}
    .dot.red{background:#ef4444}
    .dot.green{background:#34d399}
    .dot.yellow{background:#fbbf24}
    .status-text{font-size:12px;color:var(--muted);margin-top:8px}
    .error-box{background:#7f1d1d;border:1px solid #991b1b;color:#fca5a5;padding:10px;border-radius:8px;margin-top:10px;font-size:13px}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>📱 Painel do WhatsApp</h1>

    <div class="grid">
      <div class="card">
        <h3>Status <span id="stateDot" class="dot red"></span></h3>
        <div class="row" style="margin-bottom:10px">
          <button id="btnConnect" onclick="doConnect()">📷 Conectar</button>
          <button id="btnDisconnect" onclick="doDisconnect()">🔌 Desconectar</button>
          <button id="btnReset" onclick="doReset()" class="danger">🗑️ Limpar Sessão</button>
        </div>
        <div class="row" style="margin-bottom:10px">
          <a class="link" href="/admin/groups">➡️ Ir para Grupos</a>
        </div>
        <pre id="statusBox" class="muted">{ "ok": true, "connected": false, "connecting": false }</pre>
        <div id="errorBox" class="error-box" style="display:none"></div>
        <div id="statusText" class="status-text"></div>
      </div>

      <div class="card">
        <h3>QR Code</h3>
        <div id="qrBox" class="qr"><span class="muted">Aguardando geração do QR…</span></div>
        <p class="muted" style="margin-top:10px;font-size:13px">
          <strong>iPhone:</strong> Ajustes → Dispositivos conectados → Conectar um dispositivo<br>
          <strong>Android:</strong> ⋮ Menu → Dispositivos conectados → Conectar dispositivo
        </p>
      </div>
    </div>
  </div>

<script>
let poll = null;
let lastStatus = null;

function renderStatus(obj){
  const view = { ...obj };
  delete view.qr;
  document.getElementById('statusBox').textContent = JSON.stringify(view, null, 2);
  
  // Mostrar mensagem de erro se houver
  const errorBox = document.getElementById('errorBox');
  if (obj.error) {
    errorBox.textContent = '⚠️ Erro: ' + obj.error;
    errorBox.style.display = 'block';
  } else {
    errorBox.style.display = 'none';
  }
  
  // Mostrar status textual
  const statusText = document.getElementById('statusText');
  if (obj.reconnectAttempts > 0) {
    statusText.textContent = 'Tentativa de reconexão ' + obj.reconnectAttempts + '/5';
  } else {
    statusText.textContent = '';
  }
}

async function getStatus(){
  try {
    const r = await fetch('/admin/wa/status', { cache:'no-store' });
    const s = await r.json();
    const dot = document.getElementById('stateDot');
    const qrB = document.getElementById('qrBox');
    const btnConnect = document.getElementById('btnConnect');
    const btnDisconnect = document.getElementById('btnDisconnect');

    renderStatus(s);
    lastStatus = s;

    if (s.connected){
      dot.classList.remove('red', 'yellow');
      dot.classList.add('green');
      qrB.innerHTML = '<span class="muted">✅ Conectado</span>';
      btnConnect.disabled = true;
      btnDisconnect.disabled = false;
      
      // Parar polling se conectado
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
    } else if (s.connecting) {
      dot.classList.remove('red', 'green');
      dot.classList.add('yellow');
      btnConnect.disabled = true;
      btnDisconnect.disabled = false;
      
      if (s.qr){
        const img = new Image();
        img.src = s.qr;
        img.alt = 'QR Code';
        img.onload = () => {
          qrB.innerHTML = '';
          qrB.appendChild(img);
        };
      } else {
        qrB.innerHTML = '<span class="muted">⏳ Conectando...</span>';
      }
      
      // Manter polling enquanto conecta
      if (!poll) {
        poll = setInterval(getStatus, 2000);
      }
    } else {
      dot.classList.remove('green', 'yellow');
      dot.classList.add('red');
      qrB.innerHTML = '<span class="muted">Desconectado</span>';
      btnConnect.disabled = false;
      btnDisconnect.disabled = true;
      
      // Parar polling se desconectado
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
    }
  } catch(e) {
    console.error('Erro ao buscar status:', e);
    document.getElementById('errorBox').textContent = '⚠️ Erro ao buscar status: ' + e.message;
    document.getElementById('errorBox').style.display = 'block';
  }
}

async function doConnect(){
  try {
    document.getElementById('btnConnect').disabled = true;
    const r = await fetch('/admin/wa/connect', { method:'POST' });
    const result = await r.json();
    
    if (!result.ok && result.error) {
      alert('Erro ao conectar: ' + result.error);
    }
    
    if (poll) clearInterval(poll);
    poll = setInterval(getStatus, 2000);
    await getStatus();
  } catch(e) {
    console.error('Erro ao conectar:', e);
    alert('Erro ao conectar: ' + e.message);
    document.getElementById('btnConnect').disabled = false;
  }
}

async function doDisconnect(){
  try {
    if (!confirm('Deseja realmente desconectar o WhatsApp?')) return;
    
    document.getElementById('btnDisconnect').disabled = true;
    const r = await fetch('/admin/wa/disconnect', { method:'POST' });
    const result = await r.json();
    
    if (!result.ok && result.error) {
      alert('Erro ao desconectar: ' + result.error);
    }
    
    if (poll) { clearInterval(poll); poll = null; }
    await getStatus();
  } catch(e) {
    console.error('Erro ao desconectar:', e);
    alert('Erro ao desconectar: ' + e.message);
    document.getElementById('btnDisconnect').disabled = false;
  }
}

async function doReset(){
  try {
    if (!confirm('⚠️ ATENÇÃO: Isso vai apagar completamente a sessão do WhatsApp.\\n\\nVocê precisará escanear o QR Code novamente.\\n\\nDeseja continuar?')) return;
    
    document.getElementById('btnReset').disabled = true;
    const r = await fetch('/admin/wa/reset', { method:'POST' });
    const result = await r.json();
    
    if (!result.ok && result.error) {
      alert('Erro ao resetar: ' + result.error);
    }
    
    if (poll) { clearInterval(poll); poll = null; }
    await getStatus();
    document.getElementById('btnReset').disabled = false;
  } catch(e) {
    console.error('Erro ao resetar:', e);
    alert('Erro ao resetar: ' + e.message);
    document.getElementById('btnReset').disabled = false;
  }
}

// Inicializar
getStatus();

// Auto-refresh a cada 10 segundos se não estiver em polling
setInterval(() => {
  if (!poll) getStatus();
}, 10000);
</script>
</body>
</html>
  `;
  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});

// ====== UI (JS) que injeta painel flutuante em /admin/groups ======
router.get('/wa/ui.js', (_req, res) => {
  res.type('application/javascript').send(`
// Painel flutuante p/ conectar WhatsApp na tela /admin/groups
(function(){
  const HTML = \`
  <style id="wa-admin-style">
    .wa-floating {position:fixed; right:18px; bottom:18px; z-index:9999; font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; color:#e5e7eb}
    .wa-card {background:#111827; border:1px solid #374151; box-shadow:0 10px 30px rgba(0,0,0,.35); border-radius:12px; padding:14px; width:280px}
    .wa-title {font-weight:600; font-size:14px; margin-bottom:10px; display:flex; align-items:center; gap:8px}
    .wa-dot{width:10px;height:10px;border-radius:999px;display:inline-block}
    .wa-dot.green{background:#34d399} .wa-dot.red{background:#ef4444} .wa-dot.yellow{background:#fbbf24}
    .wa-row{display:flex; gap:8px}
    .wa-btn{flex:1; padding:.55rem .8rem; border-radius:10px; border:0; cursor:pointer; color:#fff; font-size:13px}
    .wa-btn.connect{background:#2563eb} .wa-btn.disconnect{background:#374151}
    .wa-btn:disabled{opacity:.5; cursor:not-allowed}
    .wa-modal{position:fixed; inset:0; background:rgba(0,0,0,.55); display:none; align-items:center; justify-content:center; z-index:10000}
    .wa-modal-body{background:#111827; color:#e5e7eb; padding:22px; border-radius:12px; text-align:center; width:320px; border:1px solid #374151}
    .wa-modal-body img{width:260px;height:260px;border-radius:8px;background:#fff}
    .wa-close{margin-top:10px; background:#374151; color:#fff; border:0; padding:.5rem .8rem; border-radius:10px; cursor:pointer}
  </style>
  <div class="wa-floating" id="wa-floating">
    <div class="wa-card">
      <div class="wa-title">
        <span>WhatsApp</span>
        <span id="wa-dot" class="wa-dot red" title="desconectado"></span>
      </div>
      <div class="wa-row">
        <button id="wa-connect" class="wa-btn connect">📲 Conectar</button>
        <button id="wa-disconnect" class="wa-btn disconnect">🔌 Desconectar</button>
      </div>
      <small style="display:block;margin-top:8px;color:#9ca3af;font-size:11px">Escaneie o QR Code quando aparecer</small>
    </div>
  </div>
  <div id="wa-modal" class="wa-modal">
    <div class="wa-modal-body">
      <h3 style="margin:0 0 8px 0">Escaneie o QR Code</h3>
      <p style="margin:0 0 8px 0;font-size:13px"><b>iPhone:</b> Ajustes → Dispositivos conectados<br><b>Android:</b> ⋮ → Dispositivos conectados</p>
      <img id="wa-qr" alt="QR Code"/>
      <div><button id="wa-close" class="wa-close">Fechar</button></div>
    </div>
  </div>\`;

  function mountUI(){
    if (!/\\/admin\\/groups(\\b|\\?|$)/.test(location.pathname)) return;
    if (document.getElementById('wa-floating')) return;
    const el = document.createElement('div');
    el.innerHTML = HTML;
    document.body.appendChild(el);

    const dot   = document.getElementById('wa-dot');
    const conn  = document.getElementById('wa-connect');
    const disc  = document.getElementById('wa-disconnect');
    const modal = document.getElementById('wa-modal');
    const img   = document.getElementById('wa-qr');
    const close = document.getElementById('wa-close');

    let poll = null;

    function showModal(show){ modal.style.display = show ? 'flex' : 'none'; }

    async function getStatus(){
      try{
        const r = await fetch('/admin/wa/status');
        const s = await r.json();
        
        if (s.connected){
          dot.classList.remove('red', 'yellow');
          dot.classList.add('green');
          dot.title = 'conectado';
          conn.disabled = true;
          disc.disabled = false;
          showModal(false);
          
          if (poll) {
            clearInterval(poll);
            poll = null;
          }
        } else if (s.connecting) {
          dot.classList.remove('red', 'green');
          dot.classList.add('yellow');
          dot.title = 'conectando…';
          conn.disabled = true;
          disc.disabled = false;
          
          if (s.qr){
            img.src = s.qr;
            showModal(true);
          }
          
          if (!poll) {
            poll = setInterval(getStatus, 2000);
          }
        } else {
          dot.classList.remove('green', 'yellow');
          dot.classList.add('red');
          dot.title = 'desconectado';
          conn.disabled = false;
          disc.disabled = true;
          showModal(false);
          
          if (poll) {
            clearInterval(poll);
            poll = null;
          }
        }
      } catch(e) {
        console.error('Erro ao buscar status:', e);
      }
    }

    async function doConnect(){
      try {
        await fetch('/admin/wa/connect', { method:'POST' });
        if (poll) clearInterval(poll);
        poll = setInterval(getStatus, 2000);
        await getStatus();
      } catch(e) {
        console.error('Erro ao conectar:', e);
      }
    }

    async function doDisconnect(){
      try {
        await fetch('/admin/wa/disconnect', { method:'POST' });
        if (poll) { clearInterval(poll); poll = null; }
        await getStatus();
      } catch(e) {
        console.error('Erro ao desconectar:', e);
      }
    }

    conn.addEventListener('click', doConnect);
    disc.addEventListener('click', doDisconnect);
    close.addEventListener('click', () => showModal(false));

    // Status inicial
    getStatus();
    
    // Auto-refresh a cada 10 segundos se não estiver em polling
    setInterval(() => {
      if (!poll) getStatus();
    }, 10000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountUI);
  } else {
    mountUI();
  }
})();
`);
});

// ====== EXPORTA O ROUTER ======
module.exports = router;
