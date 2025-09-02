// whatsapp-automation/admin-wa-bundle.js
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

/* ===================== DIAGNÓSTICO ===================== */
const WA_DEBUG = process.env.WA_DEBUG === '1';
const ts = () => new Date().toISOString();
const dlog   = (...a) => console.log('[WA-ADMIN]', ts(), ...a);
const ddebug = (...a) => { if (WA_DEBUG) console.log('[WA-ADMIN:DEBUG]', ts(), ...a); };
const mask = (s, keep = 32) => (typeof s === 'string' && s.length > keep ? s.slice(0, keep) + `…(${s.length})` : String(s));
/* ======================================================= */

// ====== WHATSAPP SESSION ======
let sock = null;
let lastQRDataUrl = null;
let connecting = false;
let connected  = false;

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function authDirPath() {
  return path.join(process.cwd(), 'data', 'baileys');
}

async function status() {
  return {
    ok: true,
    connected,
    connecting,
    qr: lastQRDataUrl || null,
    hasSock: !!sock,
  };
}

async function connect() {
  if (connected)  { ddebug('connect(): já conectado');  return status(); }
  if (connecting) { ddebug('connect(): já conectando'); return status(); }

  connecting = true;
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
    browser: ['Chrome (Render)', 'Chrome', '123'],
  });

  sock.ev.on('creds.update', () => {
    ddebug('creds.update → salvando');
    saveCreds();
  });

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      try {
        ddebug('QR recebido (raw):', mask(qr));
        lastQRDataUrl = await qrcode.toDataURL(qr);
        dlog('QR gerado (dataURL)', { length: lastQRDataUrl.length });
      } catch (err) {
        lastQRDataUrl = null;
        dlog('falha ao gerar dataURL do QR:', err?.message || String(err));
      }
    }

    if (connection === 'open') {
      connected  = true;
      connecting = false;
      lastQRDataUrl = null;
      dlog('conexão aberta ✅', { me: sock?.user || {} });
    }

    if (connection === 'close') {
      const boom  = lastDisconnect?.error;
      const code =
        boom?.output?.statusCode ||
        boom?.data?.statusCode ||
        boom?.status ||
        boom?.code || null;

      let reason = 'desconhecido';
      if (code === DisconnectReason.loggedOut) reason = 'loggedOut';

      dlog('conexão fechada ❌', {
        code, reason, message: boom?.message || String(boom || ''),
      });

      if (code === DisconnectReason.loggedOut) {
        try { await sock?.logout(); ddebug('logout() após loggedOut'); } catch {}
      }

      connected  = false;
      connecting = false;
      lastQRDataUrl = null;
    }
  });

  return status();
}

async function disconnect() {
  dlog('disconnect(): solicitado');
  try { await sock?.logout(); ddebug('logout() ok'); } catch (e) { ddebug('logout() erro:', e?.message || e); }
  try { sock?.end?.(); ddebug('end() ok'); } catch (e) { ddebug('end() erro:', e?.message || e); }
  sock = null;
  connected  = false;
  connecting = false;
  lastQRDataUrl = null;
  dlog('disconnect(): concluído');
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
router.get('/wa/status', async (_req, res) => {
  const st = await status();
  ddebug('GET /admin/wa/status ->', { connected: st.connected, connecting: st.connecting, qr: !!st.qr });
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

// NOVO: limpar sessão (apaga credenciais e zera estado)
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

// Alias de compatibilidade: /wa/reset → mesmo efeito de /wa/clear
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

// (mantido) redireciona /admin -> /admin/whatsapp
router.get('/', (_req, res) => res.redirect('/admin/whatsapp'));

// (mantido) PÁGINA COMPLETA /admin/whatsapp
// Agora servimos o arquivo real do /public, para não duplicar markup.
router.get('/whatsapp', (req, res) => {
  const file = path.join(__dirname, 'public', 'admin', 'whatsapp.html');
  if (fs.existsSync(file)) {
    return res.sendFile(file);
  }
  // Fallback: se o arquivo não existir por algum motivo, retornamos um mínimo
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><title>WhatsApp</title><p>Suba <code>public/admin/whatsapp.html</code>.</p>`);
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

// ====== EXPORTA O ROUTER ======
module.exports = router;
