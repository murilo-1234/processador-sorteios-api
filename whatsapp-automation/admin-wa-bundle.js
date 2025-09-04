// admin-wa-bundle.js
// Rotas + UI para conectar/desconectar WhatsApp com QR (Baileys),
// injeta painel flutuante em /admin/groups
// e serve o painel completo em /admin/whatsapp (lendo arquivo do /public).

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
} = require('@whiskeysockets/baileys');

// SSE (opcional) — se existir, usamos para notificar a UI sem F5
const sse = (() => { try { return require('./src/services/wa-sse'); } catch(_) { return null; } })();

/* ===================== DIAGNÓSTICO ===================== */
// Ative logs extras com WA_DEBUG=1 no ambiente (Render)
const WA_DEBUG = process.env.WA_DEBUG === '1';
const ts = () => new Date().toISOString();
const dlog   = (...a) => console.log('[WA-ADMIN]', ts(), ...a);
const ddebug = (...a) => { if (WA_DEBUG) console.log('[WA-ADMIN:DEBUG]', ts(), ...a); };
const mask = (s, keep = 32) => (typeof s === 'string' && s.length > keep ? s.slice(0, keep) + `…(${s.length})` : String(s));

// buffer de logs em memória (para /admin/wa/logs)
const DIAG = {
  lines: [],
  push(...args){
    const line = `[${ts()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
    this.lines.push(line);
    if (this.lines.length > 500) this.lines.shift();
    console.log(line);
  }
};
/* ======================================================= */

// ====== WHATSAPP SESSION ======
let sock = null;
let lastQRDataUrl = null;
let connecting = false;
let connected  = false;
let retryTimer = null;
let lastMsisdn = null; // número formatado

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function authDirPath() {
  const p = process.env.WA_SESSION_PATH || path.join(process.cwd(), 'data', 'baileys');
  return path.resolve(p);
}

// formata 55DD9xxxxxxx@s.whatsapp.net -> "DD 9xxxx-xxxx"
function formatBrNumberFromJid(jid) {
  try {
    const raw = String(jid || '').replace('@s.whatsapp.net', '').replace(/^55/, '');
    const m = /(\d{2})(\d{4,5})(\d{4})/.exec(raw);
    if (m) return `${m[1]} ${m[2]}-${m[3]}`;
  } catch (_) {}
  return null;
}

async function status() {
  return {
    ok: true,
    connected,
    connecting,
    qr: lastQRDataUrl || null,
    hasSock: !!sock,
    msisdn: lastMsisdn || null,
    user: sock?.user || null
  };
}

async function safeEndSocket() {
  try { sock?.ev?.removeAllListeners?.(); } catch {}
  try { await sock?.logout?.(); ddebug('safeEndSocket(): logout ok'); } catch (e) { ddebug('safeEndSocket(): logout err:', e?.message || e); }
  try { sock?.end?.(); ddebug('safeEndSocket(): end ok'); } catch (e) { ddebug('safeEndSocket(): end err:', e?.message || e); }
  sock = null;
}

async function connect() {
  if (connected)  { ddebug('connect(): já conectado');  return status(); }
  if (connecting) { ddebug('connect(): já conectando'); return status(); }

  connecting = true;
  lastQRDataUrl = null;
  lastMsisdn = null;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  await safeEndSocket();

  const dir = authDirPath();
  ensureDir(dir);
  dlog('connect(): iniciando socket', { dir });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();
  ddebug('versão WA-Web (Baileys):', version);

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Desktop', 'Chrome', '120.0'],
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 15_000,
  });
  DIAG.push('Socket criado. Versão:', JSON.stringify(version));

  sock.ev.on('creds.update', () => {
    ddebug('creds.update → salvando');
    try { saveCreds(); } catch (e) { ddebug('saveCreds err:', e?.message || e); }
  });

  // ====== connection.update ======
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      try {
        ddebug('QR recebido (raw):', mask(qr));
        lastQRDataUrl = await qrcode.toDataURL(qr);
        DIAG.push('QR gerado (dataURL length=', String(lastQRDataUrl.length), ')');
        // empurra "connecting" + QR via SSE (opcional)
        sse?.broadcast?.('default', { type: 'status', payload: await status() });
      } catch (err) {
        lastQRDataUrl = null;
        DIAG.push('Falha ao gerar dataURL do QR:', err?.message || String(err));
      }
    }

    if (connection) DIAG.push('connection.update ->', connection);

    if (lastDisconnect) {
      const err  = lastDisconnect.error;
      const code = err?.output?.statusCode ?? err?.data?.statusCode ?? err?.status ?? err?.code ?? null;
      DIAG.push('lastDisconnect', JSON.stringify({
        code,
        message: err?.message,
        payload: err?.output?.payload,
      }));

      if (code === DisconnectReason.badSession)         DIAG.push('MOTIVO: badSession (credenciais corrompidas)');
      if (code === DisconnectReason.connectionReplaced) DIAG.push('MOTIVO: connectionReplaced (outra instância usando a sessão)');
      if (code === DisconnectReason.loggedOut)          DIAG.push('MOTIVO: loggedOut (sessão removida pelo WA)');
      if (code === 401)                                 DIAG.push('MOTIVO: 401 not-authorized (pareamento rejeitado)');
      if (code === 515)                                 DIAG.push('MOTIVO: 515 restartRequired (WA pediu reinício do socket)');
    }

    if (connection === 'open') {
      connected  = true;
      connecting = false;
      lastQRDataUrl = null;
      lastMsisdn = formatBrNumberFromJid(sock?.user?.id);
      DIAG.push('connection OPEN', JSON.stringify(sock?.user || {}), 'msisdn=', lastMsisdn);
      sse?.broadcast?.('default', { type: 'status', payload: await status() });
    }

    if (connection === 'close') {
      const err  = lastDisconnect?.error;
      const code = err?.output?.statusCode ?? err?.data?.statusCode ?? err?.status ?? err?.code ?? null;

      // 515: o WA pede restart do WebSocket → reconectar sozinho
      if (code === 515 /* restartRequired */) {
        connected = false; connecting = false; lastQRDataUrl = null; lastMsisdn = null;
        DIAG.push('restartRequired: tentando reconectar em 2s');
        sse?.broadcast?.('default', { type: 'status', payload: await status() });
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          if (!connecting && !connected) {
            connect().catch(e => DIAG.push('auto-reconnect error:', e?.message || String(e)));
          }
        }, 2000);
        return;
      }

      if (code === DisconnectReason.loggedOut) {
        try { await sock?.logout(); DIAG.push('logout() após loggedOut'); } catch {}
      }

      connected  = false;
      connecting = false;
      lastQRDataUrl = null;
      lastMsisdn = null;
      DIAG.push('connection CLOSED (code=', String(code), ')');
      sse?.broadcast?.('default', { type: 'status', payload: await status() });
    }
  });

  return status();
}

async function disconnect() {
  dlog('disconnect(): solicitado');
  await safeEndSocket();
  connected  = false;
  connecting = false;
  lastQRDataUrl = null;
  lastMsisdn = null;
  dlog('disconnect(): concluído');
  sse?.broadcast?.('default', { type: 'status', payload: await status() });
  return status();
}

function clearAuthFolder() {
  const dir = authDirPath();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    dlog('clearAuthFolder(): removido', { dir });
  } catch (e) {
    dlog('clearAuthFolder(): erro ao remover', { dir, error: e?.message || String(e) });
  }
}

// ====== ROTAS DE ADMIN (API) — mantidas e ampliadas ======
router.get('/wa/health', (_req, res) => res.json({ ok: true, ts: ts() }));

router.get('/wa/status', async (_req, res) => {
  const st = await status();
  ddebug('GET /admin/wa/status ->', { connected: st.connected, connecting: st.connecting, qr: !!st.qr, hasSock: st.hasSock, msisdn: st.msisdn });
  res.json(st);
});

router.post('/wa/connect', async (_req, res) => {
  dlog('POST /admin/wa/connect');
  const st = await connect();
  res.json(st);
});

router.post('/wa/disconnect', async (_req, res) => {
  dlog('POST /admin/wa/disconnect');
  const st = await disconnect();
  res.json(st);
});

// limpar sessão (apaga credenciais e zera estado)
router.post('/wa/clear', async (_req, res) => {
  try {
    dlog('POST /admin/wa/clear (limpar sessão)');
    await disconnect();
    clearAuthFolder();
    res.json({ ok: true, cleared: true, ts: ts() });
  } catch (e) {
    dlog('clear error:', e?.message || String(e));
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Alias compatível: /wa/reset
router.post('/wa/reset', async (_req, res) => {
  try {
    dlog('POST /admin/wa/reset (alias clear)');
    await disconnect();
    clearAuthFolder();
    res.json({ ok: true, reset: true, ts: ts() });
  } catch (e) {
    dlog('reset error:', e?.message || String(e));
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// === LOGS de diagnóstico (leitura simples) ===
router.get('/wa/logs', (_req, res) => {
  res.type('text/plain').send(DIAG.lines.join('\n'));
});

// (mantido) redireciona /admin -> /admin/whatsapp
router.get('/', (_req, res) => res.redirect('/admin/whatsapp'));

// (mantido) PÁGINA COMPLETA /admin/whatsapp
router.get('/whatsapp', (req, res) => {
  const file = path.join(__dirname, 'public', 'admin', 'whatsapp.html');
  if (fs.existsSync(file)) {
    return res.sendFile(file);
  }
  res.set('Content-Type', 'text/html; charset=utf-8').send(
    '<!doctype html><meta charset="utf-8"><title>WhatsApp</title><p>Suba <code>public/admin/whatsapp.html</code>.</p>'
  );
});

// UI (JS) que injeta painel flutuante em /admin/groups (mantido)
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
    .wa-dot.green{background:#34d399} .wa-dot.red{background:#ef4444}
    .wa-row{display:flex; gap:8px}
    .wa-btn{flex:1; padding:.55rem .8rem; border-radius:10px; border:0; cursor:pointer; color:#fff}
    .wa-btn.connect{background:#2563eb} .wa-btn.disconnect{background:#374151}
    .wa-btn:disabled{opacity:.65; cursor:not-allowed}
    /* modal */
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
      <small style="display:block;margin-top:8px;color:#9ca3af">Abra em iPhone: Ajustes → Dispositivos conectados</small>
    </div>
  </div>
  <div id="wa-modal" class="wa-modal">
    <div class="wa-modal-body">
      <h3 style="margin:0 0 8px 0">Escaneie o QR</h3>
      <p style="margin:0 0 8px 0">No iPhone: <b>Ajustes → Dispositivos conectados → Conectar um dispositivo</b></p>
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
        const r = await fetch('/admin/wa/status', { cache:'no-store' });
        const s = await r.json();
        if (s.connected){
          dot.classList.remove('red'); dot.classList.add('green');
          dot.title = 'conectado';
          conn.disabled = true; disc.disabled = false;
          showModal(false);
        }else{
          dot.classList.remove('green'); dot.classList.add('red');
          dot.title = s.connecting ? 'conectando…' : 'desconectado';
          conn.disabled = false; disc.disabled = false;
          if (s.qr){ img.src = s.qr; showModal(true); }
        }
      }catch(e){ console.error(e); }
    }

    async function doConnect(){
      await fetch('/admin/wa/connect', { method:'POST' });
      if (poll) clearInterval(poll);
      poll = setInterval(getStatus, 2000);
      await getStatus();
    }

    async function doDisconnect(){
      await fetch('/admin/wa/disconnect', { method:'POST' });
      await getStatus();
    }

    conn.addEventListener('click', doConnect);
    disc.addEventListener('click', doDisconnect);
    close.addEventListener('click', () => showModal(false));

    // status inicial
    getStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountUI);
  } else {
    mountUI();
  }
})();
`);
});

// ====== EXPORTA O ROUTER + helpers p/ outros módulos ======
module.exports = router;
module.exports.getStatus = status;
module.exports.getSock   = () => sock;
module.exports.disconnect = disconnect; // <— export para /api/whatsapp/disconnect (opcional)
