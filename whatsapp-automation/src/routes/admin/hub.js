// src/routes/admin/hub.js
const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Helpers: instâncias e rótulos                                       */
/* ------------------------------------------------------------------ */

function getEnvInstanceIds() {
  const raw = process.env.WA_INSTANCE_IDS || '';
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// tenta usar o registry do projeto (se existir)
function tryListInstancesFromRegistry() {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies, global-require
    const { listInstances } = require('../../services/instance-registry');
    const arr = listInstances?.() || [];
    // normaliza: { id, label? }
    return arr.map(i => ({ id: i.id, label: i.label || i.id })).filter(i => i.id);
  } catch (_) {
    return null;
  }
}

function listInstances() {
  const fromSvc = tryListInstancesFromRegistry();
  if (fromSvc && Array.isArray(fromSvc) && fromSvc.length) return fromSvc;

  // fallback: só com env
  const ids = getEnvInstanceIds();
  return ids.map(id => ({ id, label: id }));
}

const SESSION_BASE = process.env.WA_SESSION_BASE || '/data/wa-sessions';
const LABELS_FILE =
  process.env.WA_LABELS_FILE ||
  path.join(SESSION_BASE, '..', 'wa-instance-labels.json');

function readLabels() {
  try {
    return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writeLabels(obj) {
  try { fs.mkdirSync(path.dirname(LABELS_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(LABELS_FILE, JSON.stringify(obj, null, 2));
}

function mergeLabels(insts) {
  const labels = readLabels();
  return insts.map(i => ({
    id: i.id,
    label: labels[i.id] || i.label || i.id,
  }));
}

/* ------------------------------------------------------------------ */
/* /admin/hub - listagem simples                                       */
/* ------------------------------------------------------------------ */

router.get('/hub', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const insts = mergeLabels(listInstances());

  const rows = insts.length
    ? insts
        .map(
          (it) => `
          <tr>
            <td style="font-family:monospace">${it.id}</td>
            <td>
              <a href="${origin}/api/hub/instances/${encodeURIComponent(it.id)}/status" target="_blank">status</a> ·
              <a href="${origin}/api/hub/instances/${encodeURIComponent(it.id)}/qr" target="_blank">qr</a> ·
              <a href="#" onclick="post('${origin}/api/hub/instances/${encodeURIComponent(it.id)}/connect');return false;">conectar</a> ·
              <a href="#" onclick="post('${origin}/api/hub/instances/${encodeURIComponent(it.id)}/disconnect');return false;">desconectar</a> ·
              <a href="#" onclick="if(confirm('Limpar sessão de ${it.id}?')) post('${origin}/api/hub/instances/${encodeURIComponent(it.id)}/clear');return false;">limpar sessão</a> ·
              <a href="${origin}/admin/whatsapp?inst=${encodeURIComponent(it.id)}" target="_blank">UI clássica</a>
            </td>
          </tr>`
        )
        .join('')
    : `<tr><td colspan="2">Sem IDs. Defina a env <code>WA_INSTANCE_IDS</code> (ex.: 489111707,48922223333)</td></tr>`;

  res.type('html').send(`<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>Hub – Admin</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:2rem;line-height:1.4}
  table{border-collapse:collapse;width:100%;max-width:900px}
  td,th{border:1px solid #ddd;padding:.5rem .75rem}
  th{background:#f7f7f7;text-align:left}
  code{background:#f2f2f2;padding:.1rem .3rem;border-radius:4px}
  small{color:#666}
</style>
<script>
 async function post(url){
   const res = await fetch(url,{method:'POST'});
   if(res.ok){ alert('OK'); } else { alert('ERRO: '+res.status); }
 }
</script>
</head>
<body>
  <h1>Hub – Admin <small>(listagem)</small></h1>
  <p><a href="${origin}/admin/wa-multi">Abrir UI em abas (multi)</a></p>
  <table>
    <thead><tr><th>ID</th><th>Ações</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`);
});

/* ------------------------------------------------------------------ */
/* /admin/wa-multi - UI em abas + rename rótulo                        */
/* ------------------------------------------------------------------ */

router.get('/admin/wa-multi', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;        // ex.: https://app.onrender.com
  const adminBase = `${origin}${req.baseUrl || '/admin'}`;      // ex.: https://app.onrender.com/admin

  const insts = mergeLabels(listInstances());
  const buttons = insts
    .map(
      (inst, i) => `
      <button class="tab${i === 0 ? ' active' : ''}"
              data-inst="${inst.id}"
              title="Duplo clique para renomear">${inst.label}</button>`
    )
    .join('');

  const html = `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8" />
<title>Hub – Admin (multi)</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background:#0c1220; color:#e8eefc; margin:0; }
  h1 { font-size:20px; font-weight:600; margin:16px 20px 12px; }
  small { color:#98a2b3; }
  .bar { display:flex; align-items:center; gap:8px; padding:8px 20px 14px; }
  #tabs { display:flex; gap:10px; align-items:center; flex-wrap:wrap; padding:0 20px 8px; }
  button.tab { background:#ef4444; color:#fff; border:0; border-radius:20px; padding:6px 14px; cursor:pointer; }
  button.tab.active { outline:2px solid #fca5a5; }
  button.plus { background:#334155; color:#fff; border:0; border-radius:20px; padding:6px 12px; cursor:pointer; }
  .wrap { display:grid; grid-template-columns:1fr 1fr; gap:16px; padding:16px 20px 28px; }
  .card { background:#0f172a; border:1px solid #1e293b; border-radius:16px; padding:14px; }
  .btn { background:#3b82f6; color:#fff; border:0; border-radius:8px; padding:8px 12px; cursor:pointer; }
  .btn.gray { background:#334155; }
  textarea { width:100%; min-height:240px; background:#0b1220; border:1px solid #1e293b; color:#e8eefc; border-radius:12px; padding:12px; }
  .qr { display:flex; align-items:center; justify-content:center; height:320px; border:1px dashed #334155; border-radius:12px; color:#9aa4b2; }
  a, a:visited { color:#60a5fa; }
</style>
</head>
<body>
  <h1>Hub – Admin <small>(multi)</small></h1>

  <div class="bar">
    <small>Os botões abaixo são as “abas”. Clique para alternar e dê <b>duplo clique</b> para renomear.</small>
  </div>

  <div id="tabs">${buttons}<button class="plus" id="open-classic">+</button></div>

  <div class="wrap">
    <div class="card">
      <h3>Status</h3>
      <div style="display:flex; gap:8px; margin-bottom:10px">
        <button id="btn-connect" class="btn">Conectar</button>
        <button id="btn-disconnect" class="btn gray">Desconectar</button>
        <button id="btn-clear" class="btn gray">Limpar sessão</button>
      </div>
      <textarea id="status" readonly>{"ok": true}</textarea>
    </div>

    <div class="card">
      <h3>QR Code</h3>
      <div id="qr-area" class="qr">Aguardando geração do QR…</div>
      <p style="color:#9aa4b2; font-size:12px; margin-top:10px">
        iPhone: Ajustes → Dispositivos conectados → Conectar um dispositivo. Android:
        “Conectar um dispositivo” no WhatsApp → escaneie o QR.
      </p>
    </div>
  </div>

  <script>
    // Injeção do servidor
    const ORIGIN = ${JSON.stringify(origin)};          // https://... (sem /admin)
    const ADMIN  = ${JSON.stringify(adminBase)};       // https://.../admin
    const INSTS  = ${JSON.stringify(insts)};           // [{id,label},...]

    let current = INSTS.length ? INSTS[0].id : '';

    async function postJson(url, body) {
      const r = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body || {})
      });
      return r.json().catch(()=> ({}));
    }

    // Alternar aba
    const $tabs = document.getElementById('tabs');
    $tabs.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button.tab');
      if (!btn) return;
      document.querySelectorAll('#tabs .tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      current = btn.dataset.inst;
      render();
    });

    // Renomear aba (duplo clique)
    $tabs.addEventListener('dblclick', async (ev) => {
      const btn = ev.target.closest('button.tab');
      if (!btn) return;
      const id = btn.dataset.inst;
      const atual = btn.textContent.trim();
      const label = prompt('Novo nome para esta aba:', atual);
      if (!label || label === atual) return;

      const res = await postJson(\`\${ADMIN}/api/instances/\${encodeURIComponent(id)}/label\`, { label });
      if (res && res.ok) btn.textContent = label;
      else alert('Não consegui renomear: ' + (res?.error || 'erro'));
    });

    // Abrir UI clássica
    document.getElementById('open-classic').onclick = () => {
      if (!current) return;
      window.open(\`\${ADMIN}/whatsapp?inst=\${encodeURIComponent(current)}\`, '_blank');
    };

    // Botões (usam a API /api/hub/instances/:id/..)
    document.getElementById('btn-connect').onclick    = () => action('connect');
    document.getElementById('btn-disconnect').onclick = () => action('disconnect');
    document.getElementById('btn-clear').onclick      = () => action('clear');

    async function action(kind){
      if(!current) return;
      const url = \`\${ORIGIN}/api/hub/instances/\${encodeURIComponent(current)}/\${kind}\`;
      const r = await fetch(url, { method:'POST' });
      if (!r.ok) alert('Falha na ação: ' + kind);
      render();
    }

    async function render(){
      const txt = document.getElementById('status');
      txt.value = 'Carregando...';
      try{
        const r = await fetch(\`\${ORIGIN}/api/hub/instances/\${encodeURIComponent(current)}/status\`);
        const j = await r.json();
        txt.value = JSON.stringify(j, null, 2);
      }catch(e){
        txt.value = 'Erro ao consultar status';
      }
      document.getElementById('qr-area').textContent = 'Aguardando geração do QR...';
    }

    // inicial
    const first = document.querySelector('#tabs .tab');
    if(first) first.click();
  </script>
</body>
</html>`;

  res.type('html').send(html);
});

/* ------------------------------------------------------------------ */
/* API: salvar rótulo (rename)                                        */
/* POST /admin/api/instances/:id/label                                */
/* ------------------------------------------------------------------ */
router.post('/admin/api/instances/:id/label', express.json(), (req, res) => {
  const id = String(req.params.id || '').trim();
  const label = String(req.body?.label || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

  const labels = readLabels();
  labels[id] = label || id;
  writeLabels(labels);

  res.json({ ok: true, id, label: labels[id] });
});

module.exports = router;
