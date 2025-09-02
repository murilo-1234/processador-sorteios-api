// whatsapp-automation/admin-wa-bundle.js
// Rotas + UI (bundle) para conectar/desconectar WhatsApp com QR (Baileys),
// injetar um painel flutuante na tela "Grupos do WhatsApp"
// e (página) um painel completo em /admin/whatsapp.

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

// ====== WHATSAPP SESSION ======
let sock = null;
let lastQRDataUrl = null;
let connecting = false;
let connected  = false;

// Diretório de credenciais do Baileys usado por este painel
const AUTH_DIR = path.join(process.cwd(), 'data', 'baileys');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function clearAuthDir() {
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
  ensureDir(AUTH_DIR);
}

async function status() {
  return { ok: true, connected, connecting, qr: lastQRDataUrl || null };
}

async function connect() {
  if (connected)  return status();
  if (connecting) return status();

  connecting = true;
  lastQRDataUrl = null;

  // encerra/zera socket anterior se existir
  try { sock?.end(); } catch {}
  sock = null;

  ensureDir(AUTH_DIR);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,    // o QR vai via dataURL (imagem) para o frontend
    logger: pino({ level: 'silent' }),
    browser: ['Chrome (Render)', 'Chrome', '123'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      // gera imagem base64 do QR para mostrar no modal/painel
      try { lastQRDataUrl = await qrcode.toDataURL(qr); } catch { lastQRDataUrl = null; }
    }

    if (connection === 'open') {
      connected  = true;
      connecting = false;
      lastQRDataUrl = null;
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      // se desconectou por "logged out" ou conflito, limpa o estado
      if (code === DisconnectReason.loggedOut) {
        try { await sock?.logout(); } catch {}
      }
      connected  = false;
      connecting = false;
      lastQRDataUrl = null;
    }
  });

  return status();
}

async function disconnect() {
  try { await sock?.logout(); } catch {}
  try { sock?.end?.(); } catch {}
  sock = null;
  connected  = false;
  connecting = false;
  lastQRDataUrl = null;
  return status();
}

// ====== ROTAS DE ADMIN (API) — MANTIDAS ======
router.get('/wa/status', async (_req, res) => res.json(await status()));
router.post('/wa/connect', async (_req, res) => res.json(await connect()));
router.post('/wa/disconnect', async (_req, res) => res.json(await disconnect()));

// ====== (NOVO) reset da sessão do painel ======
router.post('/wa/reset', async (_req, res) => {
  try {
    try { await sock?.logout(); } catch {}
    try { sock?.end?.(); } catch {}
    sock = null;
    clearAuthDir();
    connected = false;
    connecting = false;
    lastQRDataUrl = null;
    return res.json({ ok: true, reset: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ====== (MANTIDO) redireciona /admin -> /admin/whatsapp
router.get('/', (_req, res) => res.redirect('/admin/whatsapp'));

// ====== (MANTIDO) PÁGINA COMPLETA /admin/whatsapp (HTML inline)
// >>> CSS anti-overflow + não imprime "qr" no JSON do status + botão "Limpar sessão"
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
      --bg:#0f172a; --panel:#111827; --b:#1f2937; --muted:#94a3b8; --fg:#e2e8f0; --btn:#1e293b; --accent:#0ea5e9;
    }
    *{box-sizing:border-box}
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px}
    .wrap{max-width:900px;margin:0 auto}
    h1{font-size:22px;margin:0 0 16px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0}
    @media (max-width: 920px){ .grid{ grid-template-columns: 1fr; } }
    .card{background:var(--panel);border:1px solid var(--b);border-radius:12px;padding:16px;min-width:0}
    button{padding:10px 14px;border-radius:10px;border:1px solid var(--b);background:var(--btn);color:var(--fg);cursor:pointer}
    button:hover{background:var(--accent);border-color:var(--accent)}
    pre{background:#0b1220;border:1px solid var(--b);border-radius:10px;padding:12px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;overflow:auto;max-height:220px}
    a.link{color:#93c5fd;text-decoration:none}
    a.link:hover{text-decoration:underline}
    .muted{color:var(--muted)}
    .qr{display:flex;align-items:center;justify-content:center;height:280px;background:#0b1220;border:1px dashed var(--b);border-radius:12px;margin-top:12px}
    .qr img{max-width:260px;max-height:260px;border-radius:8px;background:#fff}
    .row{display:flex;gap:8px;flex-wrap:wrap}
    .dot{width:10px;height:10px;border-radius:999px;display:inline-block;vertical-align:middle;margin-right:6px}
    .dot.red{background:#ef4444}
    .dot.green{background:#34d399}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>📱 Painel do WhatsApp</h1>

    <div class="grid">
      <div class="card">
        <h3>Status <span id="stateDot" class="dot red"></span></h3>
        <div class="row" style="margin-bottom:10px">
          <button onclick="doConnect()">📷 Conectar</button>
          <button onclick="doDisconnect()">🔌 Desconectar</button>
          <button onclick="doReset()">🧹 Limpar sessão</button>
          <a class="link" href="/admin/groups">➡️ Ir para Grupos</a>
        </div>
        <pre id="statusBox" class="muted">{ "ok": true, "connected": false, "connecting": false }</pre>
      </div>

      <div class="card">
        <h3>QR Code</h3>
        <div id="qrBox" class="qr"><span class="muted">Aguardando geração do QR…</span></div>
        <p class="muted" style="margin-top:10px">
          iPhone: Ajustes → Dispositivos conectados → Conectar um dispositivo.
          Android: “Conectar um dispositivo” no WhatsApp → escaneie o QR.
        </p>
      </div>
    </div>
  </div>

<script>
let poll = null;

function renderStatus(obj){
  // NÃO inclui o base64 do QR no painel de status
  const view = { ...obj };
  delete view.qr;
  document.getElementById('statusBox').textContent = JSON.stringify(view, null, 2);
}

async function getStatus(){
  const r = await fetch('/admin/wa/status', { cache:'no-store' });
  const s = await r.json().catch(()=>({}));
  const dot = document.getElementById('stateDot');
  const qrB = document.getElementById('qrBox');

  renderStatus(s);

  if (s.connected){
    dot.classList.remove('red'); dot.classList.add('green');
    qrB.innerHTML = '<span class="muted">Conectado ✅</span>';
  }else{
    dot.classList.remove('green'); dot.classList.add('red');
    if (s.qr){
      const img = new Image();
      img.src = s.qr;
      img.alt = 'QR Code';
      qrB.innerHTML = '';
      qrB.appendChild(img);
    }else{
      qrB.innerHTML = '<span class="muted">Aguardando geração do QR…</span>';
    }
  }
}

async function doConnect(){
  await fetch('/admin/wa/connect', { method:'POST' });
  if (poll) clearInterval(poll);
  poll = setInterval(getStatus, 2000);
  await getStatus();
}

async function doDisconnect(){
  await fetch('/admin/wa/disconnect', { method:'POST' });
  if (poll) { clearInterval(poll); poll = null; }
  await getStatus();
}

async function doReset(){
  await fetch('/admin/wa/reset', { method:'POST' });
  if (poll) { clearInterval(poll); poll = null; }
  await getStatus();
}

getStatus();
</script>
</body>
</html>
  `;
  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});

// ====== UI (JS) que injeta painel flutuante em /admin/groups (MANTIDO)
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
        const r = await fetch('/admin/wa/status');
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
