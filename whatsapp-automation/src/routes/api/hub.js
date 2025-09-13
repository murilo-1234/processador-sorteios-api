// whatsapp-automation/src/routes/api/hub.js
// API do Hub (isolada) + página multi-abas, com retrocompat.
// Mantém compat: não mexe nas rotas antigas do sistema.

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const {
  listInstances,
  getInstance,
} = require('../../services/instance-registry');

/* ==============================================================================================
 * Helpers de rótulos (labels das abas)
 * - Salva/ler rótulos num JSON dentro do diretório de sessão
 * - DEFAULT do dir agora é ./data/baileys (não mais /data/wa-sessions)
 * ============================================================================================*/
const SESSION_BASE =
  process.env.WA_SESSION_BASE ||
  path.join(process.cwd(), 'data', 'baileys');

const LABELS_FILE = path.join(SESSION_BASE, 'wa-instance-labels.json');

function readLabels() {
  try { return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8')); }
  catch { return {}; }
}
function writeLabels(obj) {
  try { fs.mkdirSync(path.dirname(LABELS_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(LABELS_FILE, JSON.stringify(obj, null, 2));
}

/* ==============================================================================================
 * Utils
 * ============================================================================================*/
function escHtml(s = '') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// PNG 1x1 transparente (placeholder) — satisfaz <img src="/qr">
const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/atqK1QAAAAASUVORK5CYII=',
  'base64'
);

/* ==============================================================================================
 * API NOVA
 * ============================================================================================*/
router.get('/api/hub/instances', (_req, res) => {
  return res.json({ ok: true, instances: listInstances() });
});

router.get('/api/hub/status', (req, res) => {
  const inst = String(req.query.inst || '').trim();
  const info = getInstance(inst);
  if (!info) return res.status(404).json({ ok: false, error: 'instance_not_found' });

  // STUB: integre com status real do WhatsApp quando quiser
  return res.json({
    ok: true,
    inst,
    connected: false,
    connecting: false,
    hasSock: false,
    qrCodeGenerated: false,
  });
});

router.get('/api/hub/stream', (req, res) => {
  const inst = String(req.query.inst || '').trim();
  if (!getInstance(inst)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('instance_not_found');
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send('hello', { inst, t: Date.now() });
  const interval = setInterval(() => send('ping', { t: Date.now() }), 25_000);
  req.on('close', () => clearInterval(interval));
});

router.post('/api/hub/connect', (req, res) => {
  const inst = String(req.query.inst || '').trim();
  if (!getInstance(inst)) return res.status(404).json({ ok: false, error: 'instance_not_found' });
  return res.status(202).json({ ok: true, inst, queued: true });
});

router.post('/api/hub/disconnect', (req, res) => {
  const inst = String(req.query.inst || '').trim();
  if (!getInstance(inst)) return res.status(404).json({ ok: false, error: 'instance_not_found' });
  return res.status(202).json({ ok: true, inst, queued: true });
});

/* ==============================================================================================
 * API ANTIGA (retrocompat com a UI que chama /api/hub/inst/:id/...)
 *   - status / qr / connect / disconnect / clear
 *   - também oferece alias /api/hub/instances/:id/status para quem preferir /instances
 * ============================================================================================*/

// STATUS
function statusPayload(id) {
  // STUB compatível com a UI
  return {
    ok: true,
    id,
    connected: false,
    connecting: false,
    hasSock: false,
    qr: false,
    msisdn: null,
    user: null,
  };
}
router.get('/api/hub/inst/:id/status', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!getInstance(id)) return res.status(404).json({ ok: false, error: 'instance_not_found' });
  return res.json(statusPayload(id));
});
// alias
router.get('/api/hub/instances/:id/status', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!getInstance(id)) return res.status(404).json({ ok: false, error: 'instance_not_found' });
  return res.json(statusPayload(id));
});

// QR (placeholder PNG para não quebrar a <img>)
router.get('/api/hub/inst/:id/qr', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!getInstance(id)) return res.status(404).end();
  res.set('Content-Type', 'image/png');
  res.send(ONE_BY_ONE_PNG);
});

// CONNECT / DISCONNECT / CLEAR (stubs 202)
function actionOk(id, action) {
  return { ok: true, id, action, queued: true };
}
router.post('/api/hub/inst/:id/connect', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!getInstance(id)) return res.status(404).json({ ok: false, error: 'instance_not_found' });
  return res.status(202).json(actionOk(id, 'connect'));
});
router.post('/api/hub/inst/:id/disconnect', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!getInstance(id)) return res.status(404).json({ ok: false, error: 'instance_not_found' });
  return res.status(202).json(actionOk(id, 'disconnect'));
});
router.post('/api/hub/inst/:id/clear', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!getInstance(id)) return res.status(404).json({ ok: false, error: 'instance_not_found' });
  return res.status(202).json(actionOk(id, 'clear'));
});

/* ==============================================================================================
 * API: salvar rótulo da instância (dois caminhos compatíveis)
 * ============================================================================================*/
const saveLabelHandler = [
  express.json(),
  (req, res) => {
    const id = String(req.params.id || '').trim();
    const label = String(req.body?.label || '').trim();
    if (!id)    return res.status(400).json({ ok: false, error: 'missing id' });
    if (!label) return res.status(400).json({ ok: false, error: 'label obrigatório' });

    if (!getInstance(id)) {
      return res.status(404).json({ ok: false, error: 'instância não encontrada' });
    }

    const labels = readLabels();
    labels[id] = label;
    writeLabels(labels);

    return res.json({ ok: true, instance: { id, label } });
  }
];
router.post('/api/instances/:id/label',  ...saveLabelHandler);
router.post('/admin/api/instances/:id/label', ...saveLabelHandler);

/* ==============================================================================================
 * Página multi-abas (dois aliases: /admin/wa-multi e /wa-multi)
 *   - Usa a UI clássica dentro de um iframe: /admin/whatsapp?inst=...
 *   - Renomear aba usa /admin/api/instances/:id/label
 * ============================================================================================*/
router.get(['/admin/wa-multi', '/wa-multi'], async (req, res) => {
  // Tenta via HTTP (absolute) e cai para leitura direta se falhar
  let instances = [];
  try {
    const origin = `${req.protocol}://${req.get('host')}`;
    const r = await fetch(origin + '/api/hub/instances');
    const j = await r.json().catch(() => ({}));
    instances = Array.isArray(j.instances) ? j.instances : [];
  } catch {
    instances = listInstances();
  }

  const labels = readLabels();
  const withLabels = instances.map((inst, idx) => ({
    id: String(inst.id),
    label: labels[inst.id] || inst.label || `whatsapp ${idx + 1}`,
  }));

  const tabs = withLabels.map((inst, i) =>
    `<button class="tab ${i === 0 ? 'active' : ''}" data-inst="${escHtml(inst.id)}" data-label="${escHtml(inst.label)}">${escHtml(inst.label)}</button>`
  ).join('');

  const first = withLabels[0]?.id || '';

  res.type('html').send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>Hub – Admin (multi)</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  body{background:#0b1220;color:#e6edf3;font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0}
  .wrap{max-width:1200px;margin:0 auto;padding:24px}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  .tab{background:#a31515;color:#fff;border:0;border-radius:999px;padding:8px 14px;cursor:pointer}
  .tab.active{outline:2px solid #ffb3b3}
  .tab:hover{filter:brightness(1.05)}
  .pill{display:inline-block;padding:6px 10px;border-radius:8px;background:#10192b;margin-right:8px;color:#b7c0d8}
  .toolbar{margin:16px 0}
  iframe{width:100%;min-height:720px;border:1px solid #1e293b;border-radius:12px;background:#0b1220}
  small.tip{color:#94a3b8}
</style>
</head>
<body>
  <div class="wrap">
    <h2>Hub – Admin <small class="tip">(multi)</small></h2>
    <p class="tip">Os botões abaixo são as “abas”. Clique para alternar. Dê <b>duplo clique</b> para renomear.</p>

    <div class="row" id="tabs">${tabs}
      <button id="add" class="tab" style="background:#253051" title="Abrir lista clássica">+</button>
    </div>

    <div class="toolbar">
      <span class="pill">WhatsApp</span>
      <span class="pill">Grupos</span>
      <span class="pill">Logs</span>
      <span class="pill">Status JSON</span>
    </div>

    <iframe id="frame" src="/admin/whatsapp?inst=${encodeURIComponent(first)}"
      loading="lazy" referrerpolicy="no-referrer" allow="clipboard-write"></iframe>
  </div>

<script>
  const tabsEl = document.getElementById('tabs');
  const frame  = document.getElementById('frame');

  function setActive(btn){
    [...tabsEl.querySelectorAll('.tab')].forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  tabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn || btn.id === 'add') return;
    const inst = btn.dataset.inst;
    setActive(btn);
    frame.src = "/admin/whatsapp?inst=" + encodeURIComponent(inst);
  });

  tabsEl.addEventListener('dblclick', async (e) => {
    const btn = e.target.closest('.tab');
    if (!btn || btn.id === 'add') return;
    const inst = btn.dataset.inst;
    const current = btn.dataset.label || btn.textContent.trim();
    const next = prompt("Nome da aba:", current);
    if (!next || next === current) return;

    const ok = await fetch("/admin/api/instances/" + encodeURIComponent(inst) + "/label", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: next })
    }).then(r => r.ok).catch(() => false);

    if (ok) { btn.dataset.label = next; btn.textContent = next; }
    else { alert("Não foi possível salvar o nome. Tente novamente."); }
  });

  document.getElementById('add').addEventListener('click', () => {
    window.open("/admin/hub", "_blank");
  });
</script>
</body>
</html>`);
});

module.exports = router;
