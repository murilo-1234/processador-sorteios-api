/**
 * Serviço B (bots): multi-números só com bot do ChatGPT.
 * Mantém "sessão forte", QR visível e administração simples.
 * Página: /admin → status + QR + Conectar + Limpar sessão (por número)
 * 
 * VERSÃO CORRIGIDA - Resolve:
 * - Conflito de sessão (stream errored/replaced)
 * - Loop de reconexão infinito
 * - Sessões corrompidas (auto-limpeza)
 * - Conexão sequencial com delay
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');

// Reuso do seu código existente
const WhatsAppClient = require('../whatsapp-automation/src/services/whatsapp-client');
let attachAssistant = null;
try {
  ({ attachAssistant } = require('../whatsapp-automation/src/modules/assistant-bot'));
} catch {}

// ---------- Config ----------
const PORT = process.env.PORT || 10000;
const TZ = process.env.TZ || 'America/Sao_Paulo';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS || '';
const ASSISTANT_ENABLED = String(process.env.ASSISTANT_ENABLED || '1') === '1';
const WA_SESSION_BASE = process.env.WA_SESSION_BASE || './data/baileys-bots';

// NOVO: Configurações de conexão controlada
const INSTANCE_SPAWN_DELAY_MS = Number(process.env.WA_INSTANCE_SPAWN_DELAY_MS || 3000);
const RECONNECT_BASE_DELAY_MS = Number(process.env.WA_RECONNECT_BASE_DELAY_MS || 5000);
const RECONNECT_MAX_DELAY_MS = Number(process.env.WA_RECONNECT_MAX_DELAY_MS || 120000);
const RECONNECT_MAX_ATTEMPTS = Number(process.env.WA_RECONNECT_MAX_ATTEMPTS || 10);

// Lista de números (somente os que serão "só-bot")
const WA_INSTANCE_IDS = String(process.env.WA_INSTANCE_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!WA_INSTANCE_IDS.length) {
  console.error('Defina WA_INSTANCE_IDS com os números que serão conectados (ex: 4891167973,4891784533)');
  process.exit(1);
}

// ---------- Auth simples opcional ----------
function basicAuth(req, res, next) {
  if (!ADMIN_USER) return next();
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Basic ') ? Buffer.from(hdr.slice(6), 'base64').toString() : '';
  const [u, p] = token.split(':');
  if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="Restricted"');
  return res.status(401).send('auth required');
}

// ---------- Registro de instâncias e QR cache ----------
const instances = new Map(); // id -> { id, client, sessPath, state, reconnectAttempts, lastError, reconnectTimer }
const qrStore = new Map();   // id -> último QR recebido

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

// NOVO: Calcula delay com backoff exponencial
function getReconnectDelay(attempts) {
  const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempts);
  return Math.min(delay, RECONNECT_MAX_DELAY_MS);
}

// NOVO: Verifica se o erro indica sessão corrompida
function isCorruptedSessionError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('unable to authenticate') ||
         msg.includes('unsupported state') ||
         msg.includes('bad mac') ||
         msg.includes('decryption failed') ||
         msg.includes('invalid key');
}

// NOVO: Verifica se é erro de conflito (outra sessão conectou)
function isConflictError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('conflict') ||
         msg.includes('replaced') ||
         msg.includes('stream errored');
}

// NOVO: Agenda reconexão com controle
function scheduleReconnect(ref) {
  // Cancela timer anterior se existir
  if (ref.reconnectTimer) {
    clearTimeout(ref.reconnectTimer);
    ref.reconnectTimer = null;
  }

  // Verifica limite de tentativas
  if (ref.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
    console.log(`[${ref.id}] Limite de ${RECONNECT_MAX_ATTEMPTS} tentativas atingido. Aguardando ação manual.`);
    ref.state = 'waiting_manual';
    return;
  }

  const delay = getReconnectDelay(ref.reconnectAttempts);
  console.log(`[${ref.id}] Reconexão agendada em ${delay/1000}s (tentativa ${ref.reconnectAttempts + 1}/${RECONNECT_MAX_ATTEMPTS})`);
  
  ref.state = 'waiting_reconnect';
  ref.reconnectTimer = setTimeout(async () => {
    ref.reconnectAttempts++;
    await initializeInstance(ref).catch(e => {
      console.error(`[${ref.id}] Erro na reconexão:`, e?.message || e);
    });
  }, delay);
}

// NOVO: Inicializa instância com tratamento de erros melhorado
async function initializeInstance(ref) {
  // Evita inicialização dupla
  if (ref.state === 'connecting') {
    console.log(`[${ref.id}] Já está conectando, ignorando...`);
    return ref;
  }

  ref.state = 'connecting';
  ref.lastError = null;
  console.log(`[${ref.id}] Iniciando conexão...`);

  try {
    await ref.client.initialize();
    
    // Configura listeners de eventos
    setupEventListeners(ref);
    
    // Anexa assistente se habilitado
    if (attachAssistant && ASSISTANT_ENABLED) {
      try { 
        attachAssistant({ whatsappClient: ref.client }); 
        console.log(`[${ref.id}] Assistente anexado`);
      } catch (e) {
        console.warn(`[${ref.id}] Erro ao anexar assistente:`, e?.message);
      }
    }

    return ref;
  } catch (e) {
    ref.lastError = e?.message || String(e);
    console.error(`[${ref.id}] Erro na inicialização:`, ref.lastError);

    // Se sessão corrompida, limpa automaticamente
    if (isCorruptedSessionError(e)) {
      console.log(`[${ref.id}] Sessão corrompida detectada. Limpando automaticamente...`);
      await clearAndReinitialize(ref);
      return ref;
    }

    // Para outros erros, agenda reconexão
    ref.state = 'error';
    scheduleReconnect(ref);
    return ref;
  }
}

// NOVO: Limpa sessão corrompida e reinicializa
async function clearAndReinitialize(ref) {
  try {
    qrStore.delete(ref.id);
    await ref.client.clearSession?.();
    ref.reconnectAttempts = 0; // Reset porque é uma nova sessão
    ref.state = 'waiting_qr';
    ref.lastError = 'Sessão limpa. Aguardando escaneamento do QR.';
    console.log(`[${ref.id}] Sessão limpa. Precisa escanear QR novamente.`);
    
    // Tenta inicializar para gerar QR
    await sleep(2000);
    await ref.client.initialize().catch(() => {});
    setupEventListeners(ref);
  } catch (e) {
    console.error(`[${ref.id}] Erro ao limpar sessão:`, e?.message);
    ref.state = 'error';
    ref.lastError = e?.message || String(e);
  }
}

// NOVO: Configura listeners de eventos do Baileys
function setupEventListeners(ref) {
  try {
    const sock = ref.client.sock;
    if (!sock?.ev?.on) return;

    // Remove listeners anteriores para evitar duplicação
    sock.ev.removeAllListeners?.('connection.update');

    sock.ev.on('connection.update', (u) => {
      // Atualiza QR
      if (u?.qr) {
        qrStore.set(ref.id, u.qr);
        ref.state = 'waiting_qr';
      }

      // Conexão aberta com sucesso
      if (u?.connection === 'open') {
        qrStore.delete(ref.id);
        ref.state = 'connected';
        ref.reconnectAttempts = 0; // Reset das tentativas
        ref.lastError = null;
        console.log(`[${ref.id}] ✅ Conectado com sucesso!`);
      }

      // Conexão fechada
      if (u?.connection === 'close') {
        const error = u?.lastDisconnect?.error;
        const statusCode = error?.output?.statusCode || error?.code;
        
        ref.lastError = `Desconectado (código: ${statusCode || 'desconhecido'})`;
        console.log(`[${ref.id}] ❌ ${ref.lastError}`);

        // Se foi logout (401), não reconecta automaticamente
        if (statusCode === 401) {
          console.log(`[${ref.id}] Logout detectado. Sessão invalidada.`);
          ref.state = 'logged_out';
          return;
        }

        // Se foi conflito, espera mais tempo antes de reconectar
        if (isConflictError(error)) {
          console.log(`[${ref.id}] Conflito de sessão detectado. Aguardando mais tempo...`);
          ref.reconnectAttempts = Math.max(ref.reconnectAttempts, 3); // Força delay maior
        }

        // Se sessão corrompida, limpa e pede QR novo
        if (isCorruptedSessionError(error)) {
          clearAndReinitialize(ref);
          return;
        }

        // Agenda reconexão normal
        ref.state = 'disconnected';
        scheduleReconnect(ref);
      }
    });

  } catch (e) {
    console.warn(`[${ref.id}] Erro ao configurar listeners:`, e?.message);
  }
}

// Cria instância (modificado para usar novo sistema)
async function spawnInstance(id) {
  const sessPath = path.join(WA_SESSION_BASE, id.replace(/\D/g, ''));
  ensureDir(sessPath);

  const client = new WhatsAppClient();
  client.sessionPath = sessPath;

  const ref = { 
    id, 
    client, 
    sessPath,
    state: 'initializing',
    reconnectAttempts: 0,
    lastError: null,
    reconnectTimer: null
  };
  
  instances.set(id, ref);
  
  await initializeInstance(ref);
  
  return ref;
}

// MODIFICADO: Cria instâncias com delay entre elas
(async () => {
  ensureDir(WA_SESSION_BASE);
  console.log(`[bots] Iniciando ${WA_INSTANCE_IDS.length} instâncias com ${INSTANCE_SPAWN_DELAY_MS}ms de delay entre cada...`);
  
  for (let i = 0; i < WA_INSTANCE_IDS.length; i++) {
    const id = WA_INSTANCE_IDS[i];
    console.log(`[bots] Iniciando instância ${i + 1}/${WA_INSTANCE_IDS.length}: ${id}`);
    
    await spawnInstance(id);
    
    // Delay entre instâncias (exceto na última)
    if (i < WA_INSTANCE_IDS.length - 1) {
      console.log(`[bots] Aguardando ${INSTANCE_SPAWN_DELAY_MS}ms antes da próxima...`);
      await sleep(INSTANCE_SPAWN_DELAY_MS);
    }
  }
  
  console.log(`[bots] Todas as ${WA_INSTANCE_IDS.length} instâncias foram iniciadas.`);
})().catch(err => {
  console.error('Falha ao subir instâncias:', err?.message || err);
  process.exit(1);
});

// ---------- App web ----------
const app = express();
app.use(express.json());
if (String(process.env.TRUST_PROXY || '0') === '1') app.set('trust proxy', 1);

// Health público
app.get('/healthz', (req, res) => {
  const connected = Array.from(instances.values()).filter(x => x.state === 'connected').length;
  res.json({
    ok: true,
    tz: TZ,
    instances: Array.from(instances.keys()),
    connected: connected,
    total: instances.size,
    ts: new Date().toISOString(),
  });
});

// status JSON (protegido se ADMIN_* definidos)
app.get('/api/instances', basicAuth, (req, res) => {
  const now = new Date().toISOString();
  const list = Array.from(instances.values()).map(x => {
    const st = (typeof x.client.getConnectionStatus === 'function')
      ? x.client.getConnectionStatus()
      : {};
    return {
      id: x.id,
      connected: x.state === 'connected',
      state: x.state,
      user: st.user || null,
      retry: x.reconnectAttempts || 0,
      maxRetry: RECONNECT_MAX_ATTEMPTS,
      sessionPath: x.sessPath,
      qrCached: qrStore.has(x.id),
      lastError: x.lastError,
    };
  });
  res.json({ ok: true, at: now, instances: list });
});

// QR em SVG (força geração + long-poll)
app.get('/qr/:id', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const id = req.params.id;
  const it = instances.get(id);
  if (!it) return res.status(404).send('instância não encontrada');

  try {
    // chuta o handshake para nascer QR
    await it.client.forceQRGeneration?.().catch(()=>{});

    // espera até 25s por um QR (em memória)
    let qr = qrStore.get(id) || it.client.getQRCode?.() || null;
    for (let i = 0; i < 50 && !qr; i++) {
      await sleep(500);
      qr = qrStore.get(id) || it.client.getQRCode?.() || null;
    }

    if (!qr) return res.status(404).send('QR ainda não disponível');

    const svg = await QRCode.toString(qr, { type: 'svg', margin: 1, width: 264 });
    res.type('image/svg+xml');
    return res.send(svg);
  } catch (e) {
    return res.status(500).send(String(e?.message || e));
  }
});

// conectar: reinicia a instância
app.post('/api/:id/connect', basicAuth, async (req, res) => {
  const it = instances.get(req.params.id);
  if (!it) return res.status(404).json({ ok: false, error: 'instância não encontrada' });
  
  try {
    // Cancela qualquer reconexão pendente
    if (it.reconnectTimer) {
      clearTimeout(it.reconnectTimer);
      it.reconnectTimer = null;
    }
    
    // Reset do contador
    it.reconnectAttempts = 0;
    qrStore.delete(it.id);
    
    await initializeInstance(it);
    return res.json({ ok: true, hint: `Abra /qr/${it.id} para escanear` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// limpar sessão (logout "hard") e reabrir para já gerar novo QR
app.post('/api/:id/clear', basicAuth, async (req, res) => {
  const it = instances.get(req.params.id);
  if (!it) return res.status(404).json({ ok: false, error: 'instância não encontrada' });
  
  try {
    // Cancela qualquer reconexão pendente
    if (it.reconnectTimer) {
      clearTimeout(it.reconnectTimer);
      it.reconnectTimer = null;
    }
    
    await clearAndReinitialize(it);
    return res.json({ ok: true, message: 'Sessão limpa. Gere o novo QR em /qr/' + it.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// NOVO: Força reconexão de todas as instâncias desconectadas
app.post('/api/reconnect-all', basicAuth, async (req, res) => {
  const results = [];
  
  for (const [id, it] of instances) {
    if (it.state !== 'connected') {
      it.reconnectAttempts = 0;
      if (it.reconnectTimer) {
        clearTimeout(it.reconnectTimer);
        it.reconnectTimer = null;
      }
      scheduleReconnect(it);
      results.push({ id, action: 'reconnect_scheduled' });
    } else {
      results.push({ id, action: 'already_connected' });
    }
  }
  
  res.json({ ok: true, results });
});

// página simples (protegida se ADMIN_* definidos)
app.get(['/','/admin'], basicAuth, async (req, res) => {
  const rows = await (async () => {
    const out = [];
    for (const it of instances.values()) {
      const st = (typeof it.client.getConnectionStatus === 'function')
        ? it.client.getConnectionStatus()
        : {};
      const user = st.user?.id || '';
      
      // NOVO: Badge com mais estados
      let badgeClass = 'down';
      let badgeText = 'Desconectado';
      
      if (it.state === 'connected') {
        badgeClass = 'ok';
        badgeText = 'Conectado';
      } else if (it.state === 'connecting') {
        badgeClass = 'warn';
        badgeText = 'Conectando...';
      } else if (it.state === 'waiting_qr') {
        badgeClass = 'warn';
        badgeText = 'Aguardando QR';
      } else if (it.state === 'waiting_reconnect') {
        badgeClass = 'warn';
        badgeText = `Reconectando (${it.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})`;
      } else if (it.state === 'waiting_manual') {
        badgeClass = 'error';
        badgeText = 'Ação Manual Necessária';
      } else if (it.state === 'logged_out') {
        badgeClass = 'error';
        badgeText = 'Sessão Expirada';
      }
      
      // NOVO: Mostra último erro se houver
      const errorLine = it.lastError 
        ? `<div class="meta error">Erro: ${it.lastError}</div>` 
        : '';
      
      out.push(`
        <div class="card">
          <div class="head">
            <div class="id"># ${it.id}</div>
            <div class="badge ${badgeClass}">${badgeText}</div>
          </div>
          <div class="meta">Sessão: ${it.sessPath}</div>
          <div class="meta">User: ${user || '—'}</div>
          ${errorLine}
          <div class="actions">
            <button onclick="doPost('/api/${it.id}/connect')">Conectar</button>
            <a class="qr" href="/qr/${it.id}" target="_blank">Ver QR</a>
            <button class="danger" onclick="doPost('/api/${it.id}/clear')">Limpar sessão</button>
          </div>
        </div>
      `);
    }
    return out.join('\n');
  })();

  // NOVO: Contagem de status
  const connected = Array.from(instances.values()).filter(x => x.state === 'connected').length;
  const total = instances.size;

  res.send(`<!DOCTYPE html><html lang="pt-br"><head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>WA Bots – Multi</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;background:#0b1020;color:#e6e9ef;margin:0;padding:24px}
    h1{font-size:20px;margin:0 0 8px}
    .summary{font-size:14px;color:#99a3b5;margin-bottom:16px}
    .summary strong{color:#e6e9ef}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
    .card{background:#121a2a;border:1px solid #22304a;border-radius:12px;padding:16px}
    .head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
    .id{font-weight:600}
    .badge{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid #334766}
    .badge.ok{color:#c2ffd2;border-color:#2f7b43;background:#16301c}
    .badge.down{color:#ffd1d1;border-color:#7b2f2f;background:#301616}
    .badge.warn{color:#fff3c2;border-color:#7b6b2f;background:#302c16}
    .badge.error{color:#ff9999;border-color:#993333;background:#331111}
    .meta{font-size:12px;color:#99a3b5;margin:4px 0}
    .meta.error{color:#ff9999}
    .actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
    button,.qr{appearance:none;border:1px solid #334766;background:#1a2438;color:#e6e9ef;padding:8px 12px;border-radius:8px;cursor:pointer;text-decoration:none;font-size:13px}
    button:hover,.qr:hover{background:#22304a}
    .danger{border-color:#7b2f2f}
    .global-actions{margin-bottom:16px;display:flex;gap:8px}
  </style>
  <script>
    async function doPost(url){
      const r = await fetch(url,{method:'POST'});
      const j = await r.json().catch(()=>({}));
      alert(JSON.stringify(j,null,2));
      location.reload();
    }
    setInterval(()=>location.reload(), 8000);
  </script>
  </head><body>
    <h1>WhatsApp Bots – Multi-instância</h1>
    <div class="summary">
      <strong>${connected}</strong> de <strong>${total}</strong> conectados
    </div>
    <div class="global-actions">
      <button onclick="doPost('/api/reconnect-all')">🔄 Reconectar Todos Desconectados</button>
    </div>
    <div class="grid">
      ${rows}
    </div>
  </body></html>`);
});

app.listen(PORT, () => {
  console.log(`[bots] online on :${PORT} TZ=${TZ} instances=${WA_INSTANCE_IDS.join(',')}`);
});
