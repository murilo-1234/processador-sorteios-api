// src/routes/admin/hub.js
const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

/* ------------------- util ------------------- */
function getInstanceIds() {
  const raw = process.env.WA_INSTANCE_IDS || '';
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

const LABELS_FILE =
  process.env.WA_LABELS_FILE ||
  path.join(process.env.WA_SESSION_BASE || '/data/wa-sessions', '..', 'wa-instance-labels.json');

function readLabels() {
  try { return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8')); } catch { return {}; }
}
function writeLabels(obj) {
  try { fs.mkdirSync(path.dirname(LABELS_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(LABELS_FILE, JSON.stringify(obj, null, 2));
}
function escHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ------------------- UI simples original (/admin/hub) ------------------- */
/* mantém a sua página antiga em /admin/hub (lista em tabela) */
router.get('/admin/hub', (req, res) => {
  const ids = getInstanceIds();
  const base = req.protocol + '://' + req.get('host');

  const rows = ids.length
    ? ids.map((id, idx) => {
        return `
          <tr>
            <td style="font-family:monospace">${escHtml(id)}</td>
            <td>
              <a href="${base}/api/hub/inst/${encodeURIComponent(id)}/status" target="_blank">status</a> ·
              <a href="${base}/api/hub/inst/${encodeURIComponent(id)}/qr" target="_blank">qr</a> ·
              <a href="#" onclick="post('${base}/api/hub/inst/${encodeURIComponent(id)}/connect');return false;">conectar</a> ·
              <a href="#" onclick="post('${base}/api/hub/inst/${encodeURIComponent(id)}/disconnect');return false;">desconectar</a> ·
              <a href="#" onclick="if(confirm('Limpar sessão de ${escHtml(id)}?')) post('${base}/api/hub/inst/${encodeURIComponent(id)}/clear');return false;">limpar sessão</a> ·
              <a href="${base}/admin/whatsapp?inst=${encodeURIComponent(id)}" target="_blank">UI clássica</a>
            </td>
          </tr>
        `;
      }).join('')
    : `<tr><td colspan="2">Sem IDs. Defina a env <code>WA_INSTANCE_IDS</code> (ex.: 489111707,48922223333)</td></tr>`;

  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.send(`<!doctype html>
<html><head>
<meta charset="utf-8"/>
<title>Hub – Admin</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:2rem;line-height:1.4}
  table{border-collapse:collapse;width:100%;max-width:900px}
  td,th{border:1px solid #ddd;padding:.5rem .75rem}
  th{background:#f7f7f7;text-align:left}
  code{background:#f2f2f2;padding:.1rem .3rem;border-radius:4px}
  small{color:#666}
  .ok{color:#2d7a2d}
</style>
<script>
 async function post(url){
   const res = await fetch(url,{method:'POST'});
   if(res.ok){ alert('OK: '+url); } else { alert('ERRO: '+res.status+' '+url); }
 }
</script>
</head>
<body>
<h1>Hub – Admin</h1>
<p><a href="${base}/admin/wa-multi">Ir para a tela multi (abas)</a></p>
<table>
  <thead><tr><th>ID</th><th>Ações</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`);
});

/* ------------------- NOVA UI multi-abas (/admin/wa-multi) ------------------- */
router.get('/admin/wa-multi', (req, res) => {
  const base = req.protocol + '://' + req.get('host') + '/admin'; // prefixo da área admin
  const ids = getInstanceIds();
  const labels = readLabels();

  const buttons = ids.map((id, i) => {
    const label = labels[id] || (i === 0 ? 'Celular 1' : `whatsapp ${i+1}`);
    return `<button class="tab${i===0?' active':''}" data-inst="${escHtml(id)}">${escHtml(label)}</button>`;
  }).join(' ');

  const firstId = ids[0] || '';

  res.set('content-type','text/html; charset=utf-8').send(`<!doctype html>
<html><head>
<meta charset="utf-8"/>
<title>Hub – Admin (multi)</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  :root{
    --bg:#0f1623;--panel:#162231;--text:#d9e1ee;--muted:#9bb0c9;
    --brand:#1f6feb;--ok:#2ecc71;--warn:#f39c12;--danger:#e74c3c;--line:#20324a
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  .wrap{padding:24px;max-width:1200px;margin:0 auto}
  .bar{display:flex;align-items:center;gap:8px;margin-bottom:16px}
  .tab,.plus{border:0;padding:8px 14px;border-radius:999px;background:#2b3b54;color:#fff;cursor:pointer}
  .tab.active{background:var(--brand)}
  .plus{width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center}
  h1{font-size:18px;margin:0 0 12px}
  small{color:var(--muted)}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
  h3{margin:0 0 12px;font-size:16px}
  .btn{border:1px solid var(--line);background:#20324a;color:#fff;border-radius:8px;padding:8px 12px;cursor:pointer}
  .btn.gray{opacity:.8}
  textarea{width:100%;height:360px;background:#0d1521;color:#dfe7f7;border:1px solid var(--line);border-radius:8px;padding:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .qr{display:flex;align-items:center;justify-content:center;min-height:360px;border:1px dashed var(--line);border-radius:12px;background:#0d1521}
  .qr img{max-width:100%;height:auto;display:block}
</style>
</head>
<body>
  <div class="wrap">
    <h1>Hub – Admin <small>(multi)</small></h1>
    <p>Os botões abaixo são as “abas”. Clique para alternar e dê <b>duplo clique</b> para renomear.</p>

    <div class="bar" id="tabs">${buttons} <button class="plus" id="open-classic">+</button></div>

    <div class="grid">
      <div class="card">
        <h3>Status</h3>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <button class="btn" id="btn-connect">Conectar</button>
          <button class="btn gray" id="btn-disconnect">Desconectar</button>
          <button class="btn gray" id="btn-clear">Limpar sessão</button>
        </div>
        <textarea id="status" readonly>Carregando…</textarea>
      </div>

      <div class="card">
        <h3>QR Code</h3>
        <div class="qr" id="qr-area">Aguardando geração do QR…</div>
        <p style="color:#9bb0c9;font-size:13px;margin-top:12px">
          iPhone: Ajustes → Dispositivos conectados → Conectar um dispositivo. Android:
          “Conectar um dispositivo” no WhatsApp → escaneie o QR.
        </p>
      </div>
    </div>
  </div>

<script>
  // base admin (ex.: https://…/admin)
  const base = ${JSON.stringify(base)};
  // raiz da API do hub no seu backend antigo
  const apiRoot = base.replace(/\\/admin$/, '') + '/api/hub';

  // id inicial
  let current = ${JSON.stringify(firstId)};

  async function postJSON(url, body){
    const r = await fetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body || {})
    });
    return r.json().catch(()=>({}));
  }

  // --- abas ---
  const $tabs = document.getElementById('tabs');

  function setActive(id){
    current = id;
    document.querySelectorAll('#tabs .tab').forEach(b=>{
      b.classList.toggle('active', b.dataset.inst === id);
    });
    render();
  }

  $tabs.addEventListener('click', (ev)=>{
    const btn = ev.target.closest('button.tab');
    if (!btn) return;
    setActive(btn.dataset.inst);
  });

  // duplo clique para renomear (rota sob /admin)
  $tabs.addEventListener('dblclick', async (ev)=>{
    const btn = ev.target.closest('button.tab');
    if (!btn) return;
    const id = btn.dataset.inst;
    const atual = btn.textContent.trim();
    const label = prompt('Novo nome para esta aba:', atual);
    if (!label || label === atual) return;

    const res = await postJSON(base + '/api/instances/' + encodeURIComponent(id) + '/label', { label });
    if (res && res.ok) btn.textContent = label;
    else alert('Não consegui renomear: ' + (res && res.error || 'erro'));
  });

  // --- Status + QR ---
  async function render(){
    await renderStatus();
    renderQR();
  }

  async function renderStatus(){
    const $txt = document.getElementById('status');
    if (!current){ $txt.value = 'Nenhuma instância selecionada'; return; }
    $txt.value = 'Carregando status...';
    try{
      const r = await fetch(apiRoot + '/inst/' + encodeURIComponent(current) + '/status');
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      $txt.value = JSON.stringify(j, null, 2);
    }catch(e){
      $txt.value = 'Erro ao consultar status';
    }
  }

  function renderQR(){
    const $qr = document.getElementById('qr-area');
    if (!current){ $qr.textContent = 'Selecione uma instância'; return; }
    const ts = Date.now();
    $qr.innerHTML = '<img alt="QR" src="' + (apiRoot + '/inst/' + encodeURIComponent(current) + '/qr?ts=' + ts) + '">';
  }

  // --- Ações ---
  document.getElementById('btn-connect').onclick    = () => doAction('connect');
  document.getElementById('btn-disconnect').onclick = () => doAction('disconnect');
  document.getElementById('btn-clear').onclick      = () => doAction('clear');

  async function doAction(action){
    if (!current) return;
    try{
      const r = await fetch(apiRoot + '/inst/' + encodeURIComponent(current) + '/' + action, { method:'POST' });
      if (!r.ok) throw new Error(r.status);
      await render();
    }catch(e){
      alert('Falha na ação: ' + action);
    }
  }

  // UI clássica da instância corrente
  document.getElementById('open-classic').onclick = ()=>{
    if (!current) return;
    window.open(base.replace(/\\/admin$/, '') + '/admin/whatsapp?inst=' + encodeURIComponent(current), '_blank');
  };

  // selecionar a primeira aba ao abrir
  const first = document.querySelector('#tabs .tab');
  if (first) setActive(first.dataset.inst);
</script>
</body></html>`);
});

/* --------- API p/ salvar rótulo das abas (rename) --------- */
router.post('/api/instances/:id/label', express.json(), (req, res) => {
  const id = String(req.params.id || '').trim();
  const label = String(req.body?.label || '').trim();
  if (!id) return res.status(400).json({ ok:false, error:'missing id' });

  const labels = readLabels();
  labels[id] = label || id;
  writeLabels(labels);

  res.json({ ok:true, id, label: labels[id] });
});

module.exports = router;
