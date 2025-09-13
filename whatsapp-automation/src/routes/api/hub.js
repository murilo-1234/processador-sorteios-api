// whatsapp-automation/src/routes/api/hub.js
// API NOVA do Hub (isolada). Não mexe nas rotas antigas.
// Por enquanto é um esqueleto seguro: lista instâncias, status "stub",
// SSE de keepalive e endpoints de connect/disconnect com TODO.

const express = require('express');
const router = express.Router();

const {
  listInstances,
  getInstance,
} = require('../../services/instance-registry');

// Lista instâncias configuradas
router.get('/api/hub/instances', (req, res) => {
  return res.json({ ok: true, instances: listInstances() });
});

// Status "stub" (vamos integrar ao WhatsApp depois)
router.get('/api/hub/status', (req, res) => {
  const inst = String(req.query.inst || '').trim();
  const info = getInstance(inst);
  if (!info) return res.status(404).json({ ok: false, error: 'instance_not_found' });

  // TODO: integrar com o status real do WhatsApp (sock)
  return res.json({
    ok: true,
    inst,
    connected: false,
    connecting: false,
    hasSock: false,
    qrCodeGenerated: false,
  });
});

// SSE de keepalive (a UI fica "ouvindo" e a gente manda pings)
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

  // hello imediato e pings periódicos
  send('hello', { inst, t: Date.now() });
  const interval = setInterval(() => send('ping', { t: Date.now() }), 25000);

  req.on('close', () => clearInterval(interval));
});

// Conectar (stub) – futuramente dispara o fluxo que gera QR
router.post('/api/hub/connect', (req, res) => {
  const inst = String(req.query.inst || '').trim();
  if (!getInstance(inst)) return res.status(404).json({ ok: false, error: 'instance_not_found' });

  // TODO: acionar connect real
  return res.status(202).json({ ok: true, inst, queued: true });
});

// Desconectar (stub) – futuramente faz logout/clear session
router.post('/api/hub/disconnect', (req, res) => {
  const inst = String(req.query.inst || '').trim();
  if (!getInstance(inst)) return res.status(404).json({ ok: false, error: 'instance_not_found' });

  // TODO: acionar disconnect real
  return res.status(202).json({ ok: true, inst, queued: true });
});

// ====== Suporte a rótulos (nomes das abas) ======
const fs = require('fs');
const path = require('path');
const express = require('express');

const LABELS_FILE =
  process.env.WA_LABELS_FILE ||
  path.join(process.env.WA_SESSION_BASE || '/data/wa-sessions', '..', 'wa-instance-labels.json');

function readLabels() {
  try {
    return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}
function writeLabels(obj) {
  try {
    fs.mkdirSync(path.dirname(LABELS_FILE), { recursive: true });
  } catch {}
  fs.writeFileSync(LABELS_FILE, JSON.stringify(obj, null, 2));
}

// API para salvar rótulo da instância
router.post('/api/instances/:id/label', express.json(), (req, res) => {
  const id = String(req.params.id || '').trim();
  const label = String(req.body?.label || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const labels = readLabels();
  labels[id] = label || id;
  writeLabels(labels);
  return res.json({ ok: true, id, label: labels[id] });
});

// ====== Página com múltiplas abas ======
router.get('/wa-multi', async (req, res) => {
  // URL base (o admin fica montado sob /admin, então removemos "/admin")
  const base = req.baseUrl.replace(/\/admin$/, '');

  // Consulta as instâncias do hub
  // (usa sua própria API já existente: /api/hub/instances)
  const instancesResp = await fetch(`${base}/api/hub/instances`);
  const instancesJson = await instancesResp.json().catch(() => ({ instances: [] }));
  const instances = Array.isArray(instancesJson.instances) ? instancesJson.instances : [];

  // Mescla rótulos salvos em disco
  const labels = readLabels();
  const withLabels = instances.map((inst, idx) => ({
    id: String(inst.id),
    label: labels[inst.id] || inst.label || `whatsapp ${idx + 1}`,
  }));

  // Gera botões/abas
  const tabs = withLabels
    .map(
      (inst, i) => `
      <button class="tab ${i === 0 ? 'active' : ''}" data-inst="${inst.id}" data-label="${inst.label}">
        ${inst.label}
      </button>`
    )
    .join('');

  // Primeira aba selecionada
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
    <p class="tip">Dica: os botões abaixo são as “abas”. Clique para alternar entre os números.  
    Dê <b>duplo-clique</b> em uma aba para renomear.</p>

    <div class="row" id="tabs">${tabs}
      <button id="add" class="tab" style="background:#253051" title="Abrir UI clássica">
        +
      </button>
    </div>

    <div class="toolbar">
      <span class="pill">WhatsApp</span>
      <span class="pill">Grupos</span>
      <span class="pill">Logs</span>
      <span class="pill">Status JSON</span>
    </div>

    <iframe id="frame"
      src="${base}/admin/whatsapp?inst=${encodeURIComponent(first)}"
      loading="lazy"
      referrerpolicy="no-referrer"
      allow="clipboard-write"></iframe>
  </div>

<script>
  const base = "${base}";
  const tabsEl = document.getElementById('tabs');
  const frame = document.getElementById('frame');

  function setActive(btn){
    [...tabsEl.querySelectorAll('.tab')].forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  tabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn || btn.id === 'add') return;
    const inst = btn.dataset.inst;
    setActive(btn);
    frame.src = base + "/admin/whatsapp?inst=" + encodeURIComponent(inst);
  });

  // Renomear com duplo-clique
  tabsEl.addEventListener('dblclick', async (e) => {
    const btn = e.target.closest('.tab');
    if (!btn || btn.id === 'add') return;
    const inst = btn.dataset.inst;
    const current = btn.dataset.label || btn.textContent.trim();
    const next = prompt("Nome da aba:", current);
    if (!next || next === current) return;

    const ok = await fetch(base + "/admin/api/instances/" + encodeURIComponent(inst) + "/label", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: next })
    }).then(r => r.ok).catch(() => false);

    if (ok) {
      btn.dataset.label = next;
      btn.textContent = next;
    } else {
      alert("Não foi possível salvar o nome. Tente novamente.");
    }
  });

  // Botão “+” → abre a UI clássica (só para o usuário escolher)
  document.getElementById('add').addEventListener('click', () => {
    const act = tabsEl.querySelector('.tab.active');
    const inst = act?.dataset.inst || '';
    window.open(base + "/admin/hub", "_blank");
  });
</script>
</body>
</html>`);
});

module.exports = router;
