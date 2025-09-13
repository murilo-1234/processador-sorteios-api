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
    .map((s) => s.trim())
    .filter(Boolean);
}

// tenta usar um “registry” do projeto (se existir)
function tryListInstancesFromRegistry() {
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const { listInstances } = require('../../services/instance-registry');
    const arr = listInstances?.() || [];
    // normaliza: { id, label? }
    return arr
      .map((i) => ({ id: i.id, label: i.label || i.id }))
      .filter((i) => i.id);
  } catch {
    return null;
  }
}

function listInstances() {
  const fromSvc = tryListInstancesFromRegistry();
  if (fromSvc && Array.isArray(fromSvc) && fromSvc.length) return fromSvc;

  // fallback: só com env
  const ids = getEnvInstanceIds();
  return ids.map((id, idx) => ({
    id,
    label: idx === 0 ? 'Celular 1' : `whatsapp ${idx + 1}`,
  }));
}

const SESSION_BASE = process.env.WA_SESSION_BASE || '/data/wa-sessions';
const LABELS_FILE =
  process.env.WA_LABELS_FILE || path.join(SESSION_BASE, '..', 'wa-instance-labels.json');

function readLabels() {
  try {
    return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writeLabels(obj) {
  try {
    fs.mkdirSync(path.dirname(LABELS_FILE), { recursive: true });
  } catch {}
  fs.writeFileSync(LABELS_FILE, JSON.stringify(obj, null, 2));
}

function mergeLabels(insts) {
  const labels = readLabels();
  return insts.map((i) => ({
    id: i.id,
    label: labels[i.id] || i.label || i.id,
  }));
}

function escHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ------------------------------------------------------------------ */
/* /admin/hub - listagem simples                                       */
/* ------------------------------------------------------------------ */

router.get(['/hub', '/admin/hub'], (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`; // https://… (sem /admin)
  const insts = mergeLabels(listInstances());

  const rows = insts.length
    ? insts
        .map(
          (it) => `
          <tr>
            <td style="font-family:monospace">${escHtml(it.id)}</td>
            <td>
              <a href="${origin}/api/hub/inst/${encodeURIComponent(it.id)}/status" target="_blank">status</a> ·
              <a href="${origin}/api/hub/inst/${encodeURIComponent(it.id)}/qr" target="_blank">qr</a> ·
              <a href="#" onclick="post('${origin}/api/hub/inst/${encodeURIComponent(it.id)}/connect');return false;">conectar</a> ·
              <a href="#" onclick="post('${origin}/api/hub/inst/${encodeURIComponent(it.id)}/disconnect');return false;">desconectar</a> ·
              <a href="#" onclick="if(confirm('Limpar sessão de ${escHtml(
                it.id
              )}?')) post('${origin}/api/hub/inst/${encodeURIComponent(it.id)}/clear');return false;">limpar sessão</a> ·
              <a href="${origin}/admin/whatsapp?inst=${encodeURIComponent(
                it.id
              )}" target="_blank">UI clássica</a>
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
  a{color:#1f6feb;text-decoration:none}
  a:hover{text-decoration:underline}
  table{border-collapse:collapse;width:100%;max-width:900px}
  td,th{border:1px solid #ddd;padding:.5rem .75rem}
  th{background:#f7f7f7;text-align:left}
  code{background:#f2f2f2;padding:.1rem .3rem;border-radius:4px}
  small{color:#666}
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
  <p><a href="${origin}/admin/wa-multi">Ir para a tela multi (abas)</a></p>
  <table>
    <thead><tr><th>ID</th><th>Ações</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`);
});

/* ------------------------------------------------------------------ */
/* /admin/wa-multi - UI com abas                                       */
/* ------------------------------------------------------------------ */

router.get(['/wa-multi', '/admin/wa-multi'], (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`; // https://… (sem /admin)
  const adminBase = `${origin}/admin`; // https://…/admin
  const insts = mergeLabels(listInstances());

  const buttons = insts
    .map(
      (it, i) =>
        `<button class="tab${i === 0 ? ' active' : ''}" data-inst="${escHtml(it.id)}">${escHtml(
          it.label
        )}</button>`
    )
    .join(' ');

  res.type('html').send(`<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Hub – Admin (multi)</title>
<style>
  :root{
    --bg:#0f1623;--panel:#162231;--text:#d9e1ee;--muted:#9bb0c9;
    --brand:#1f6feb;--line:#20324a
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  .wrap{padding:24px;max-width:1200px;margin:0 auto}
  .bar{display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap}
  .tab,.plus{border:0;padding:8px 14px;border-radius:999px;background:#2b3b54;color:#fff;cursor:pointer}
  .tab.active{background:var(--brand)}
  .plus{width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center}
  h1{font-size:18px;margin:0 0 12px}
  small{color:var(--muted)}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
  h3{margin:0 0 12px;font-size:16px}
  .btn{border:1px solid var(--line);background:#20324a;color:#fff;border-radius:8px;padding:8px 12px;cursor:pointer}
  .btn.gray{opacity:.85}
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
  // Injeção do servidor
  const ORIGIN = ${JSON.stringify(origin)};      // https://… (sem /admin)
  const ADMIN  = ${JSON.stringify(adminBase)};   // https://…/admin
  const INSTS  = ${JSON.stringify(insts)};       // [{id,label},...]

  const API = ORIGIN + '/api/hub';               // raiz da sua API do hub

  let current = INSTS.length ? INSTS[0].id : '';

  async function postJson(url, body){
    const r = await fetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body || {})
    });
    return r.json().catch(()=> ({}));
  }

  // Alternar aba
  const $tabs = document.getElementById('tabs');
  $tabs.addEventListener('click', (ev)=>{
    const btn = ev.target.closest('button.tab');
    if(!btn) return;
    document.querySelectorAll('#tabs .tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    current = btn.dataset.inst;
    render();
  });

  // Renomear aba (duplo clique)
  $tabs.addEventListener('dblclick', async (ev)=>{
    const btn = ev.target.closest('button.tab');
    if(!btn) return;
    const id = btn.dataset.inst;
    const atual = btn.textContent.trim();
    const label = prompt('Novo nome para esta aba:', atual);
    if(!label || label === atual) return;

    // rota vive sob /admin
    const res = await postJson(ADMIN + '/api/instances/' + encodeURIComponent(id) + '/label', { label });
    if(res && res.ok) btn.textContent = label;
    else alert('Não consegui renomear: ' + (res && res.error || 'erro'));
  });

  // UI clássica
  document.getElementById('open-classic').onclick = ()=>{
    if(!current) return;
    window.open(ADMIN + '/whatsapp?inst=' + encodeURIComponent(current), '_blank');
  };

  // Status + QR
  async function render(){
    await renderStatus();
    renderQR();
  }
  async function renderStatus(){
    const txt = document.getElementById('status');
    if(!current){ txt.value = 'Nenhuma instância selecionada'; return; }
    txt.value = 'Carregando status...';
    try{
      const r = await fetch(API + '/inst/' + encodeURIComponent(current) + '/status');
      if(!r.ok) throw new Error(r.status);
      const j = await r.json();
      txt.value = JSON.stringify(j, null, 2);
    }catch(e){
      txt.value = 'Erro ao consultar status';
    }
  }
  function renderQR(){
    const box = document.getElementById('qr-area');
    if(!current){ box.textContent = 'Selecione uma instância'; return; }
    const ts = Date.now();
    box.innerHTML = '<img alt="QR" src="' + (API + '/inst/' + encodeURIComponent(current) + '/qr?ts=' + ts) + '">';
  }

  // Ações
  document.getElementById('btn-connect').onclick    = ()=> doAction('connect');
  document.getElementById('btn-disconnect').onclick = ()=> doAction('disconnect');
  document.getElementById('btn-clear').onclick      = ()=> doAction('clear');

  async function doAction(kind){
    if(!current) return;
    try{
      const r = await fetch(API + '/inst/' + encodeURIComponent(current) + '/' + kind, { method:'POST' });
      if(!r.ok) throw new Error(r.status);
      await render();
    }catch(e){
      alert('Falha na ação: ' + kind);
    }
  }

  // inicial
  const first = document.querySelector('#tabs .tab');
  if(first) first.click();
</script>
</body>
</html>`);
});

/* ------------------------------------------------------------------ */
/* API: salvar rótulo (rename)                                        */
/* POST /admin/api/instances/:id/label                                */
/* ------------------------------------------------------------------ */
router.post(
+  ['/api/instances/:id/label', '/admin/api/instances/:id/label'],
+  express.json(),
+  (req, res) => {
  const id = String(req.params.id || '').trim();
  const label = String(req.body?.label || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

  const labels = readLabels();
  labels[id] = label || id;
  writeLabels(labels);

  res.json({ ok: true, id, label: labels[id] });
});

module.exports = router;
