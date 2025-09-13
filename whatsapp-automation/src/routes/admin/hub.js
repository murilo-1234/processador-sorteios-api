// src/routes/admin/hub.js
const express = require('express');
const path = require('path');
const router = express.Router();

function getInstanceIds() {
  const raw = process.env.WA_INSTANCE_IDS || '';
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

router.get('/admin/hub', (req, res) => {
  const ids = getInstanceIds();
  const base = req.protocol + '://' + req.get('host');

  const rows = ids.length
    ? ids.map((id, idx) => {
        const n = idx + 1;
        return `
          <tr>
            <td style="font-family:monospace">${id}</td>
            <td>
              <a href="${base}/api/hub/inst/${id}/status" target="_blank">status</a> ·
              <a href="${base}/api/hub/inst/${id}/qr" target="_blank">qr</a> ·
              <a href="#" onclick="post('${base}/api/hub/inst/${id}/connect');return false;">conectar</a> ·
              <a href="#" onclick="post('${base}/api/hub/inst/${id}/disconnect');return false;">desconectar</a> ·
              <a href="#" onclick="if(confirm('Limpar sessão de ${id}?')) post('${base}/api/hub/inst/${id}/clear');return false;">limpar sessão</a> ·
              <a href="${base}/admin/whatsapp?inst=${encodeURIComponent(id)}" target="_blank">UI clássica</a>
            </td>
          </tr>
        `;
      }).join('')
    : `<tr><td colspan="2">Sem IDs. Defina a env <code>WA_INSTANCE_IDS</code> (ex.: 489111707,48922223333)</td></tr>`;

  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>Hub – Admin (multi)</title>
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
  <h1>Hub – Admin <small>(staging)</small></h1>
  <p>Rota do Admin conectada <span class="ok">✔</span></p>

  <p><a href="${base}/api/hub/instances" target="_blank">Ver instâncias (JSON)</a> ·
     <a href="${base}/health" target="_blank">Healthcheck</a></p>

  <table>
    <thead><tr><th>ID</th><th>Ações</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <p><small>Use “UI clássica” para abrir a tela com QR e botões focada para o ID escolhido.</small></p>
</body>
</html>
  `);
});

// Nova UI com abas por instância
router.get('/admin/wa-multi', (req, res) => {
  res.sendFile(path.join(__dirname, '../../../public/admin-multi.html'));
});

// ========= UI multi-abas =========
router.get('/wa-multi', async (req, res) => {
  const base = req.baseUrl?.replace(/\/+$/, '') || '/admin';

  // Carrega instâncias + rótulos salvos
  const fs = require('fs');
  const path = require('path');
  const LABELS_FILE =
    process.env.WA_LABELS_FILE ||
    path.join(process.env.WA_SESSION_BASE || '/data/wa-sessions', '..', 'wa-instance-labels.json');

  function readLabels() {
    try { return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8')); } catch { return {}; }
  }

  // liste suas instâncias de onde você já lista hoje:
  const { listInstances } = require('../../services/instance-registry');
  const instances = listInstances().map(x => ({ id: String(x.id), label: x.label || x.id }));

  // aplica rótulos persistidos
  const labels = readLabels();
  for (const it of instances) it.label = labels[it.id] || it.label;

  // HTML simplificado com abas e renomeio por duplo clique
  const buttons = instances.map(inst => (
    `<button class="tab" data-inst="${inst.id}">${inst.label}</button>`
  )).join('\n');

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Hub – Admin (multi)</title>
  <style>
    body{font-family:system-ui,Arial,sans-serif;background:#0e1320;color:#e8eefc;margin:0}
    .bar{padding:16px;border-bottom:1px solid #1c2440}
    .tab{background:#d9534f;border:none;border-radius:999px;color:#fff;padding:8px 12px;margin:0 8px 8px 0;cursor:pointer}
    .tab.active{background:#c12e2a}
    .plus{background:#243; color:#9cf; border-radius:999px; padding:8px 12px; border:1px solid #355}
    .wrap{padding:24px}
    .card{background:#0b1020;border:1px solid #1c2440;border-radius:12px;padding:24px;display:grid;grid-template-columns:1fr 1fr;gap:24px}
    .box{background:#0a0f1e;border:1px solid #1c2440;border-radius:8px;padding:16px}
    textarea{width:100%;height:280px;background:#0a0f1e;color:#e8eefc;border:1px solid #1c2440;border-radius:8px;padding:12px}
    .btn{background:#2a6df1;border:none;color:#fff;border-radius:8px;padding:10px 14px;cursor:pointer;margin-right:8px}
    .btn.gray{background:#30405a}
    .qr{height:320px;display:flex;align-items:center;justify-content:center;border:1px dashed #3a4b70;border-radius:8px;color:#9bb3d6}
  </style>
</head>
<body>
  <div class="bar">
    <small>Hub – Admin <b>(multi)</b></small>
    <p>Os botões abaixo são as “abas”. Dê <b>duplo clique</b> para renomear.</p>
    <div id="tabs">${buttons}<button class="plus" id="open-classic">+</button></div>
  </div>
  <div class="wrap">
    <div class="card">
      <div class="box">
        <h3>Status</h3>
        <div>
          <button class="btn" id="btn-connect">Conectar</button>
          <button class="btn gray" id="btn-disconnect">Desconectar</button>
          <button class="btn gray" id="btn-clear">Limpar sessão</button>
        </div>
        <textarea id="status" readonly></textarea>
      </div>
      <div class="box">
        <h3>QR Code</h3>
        <div class="qr" id="qr-area">Aguardando geração do QR…</div>
      </div>
    </div>
  </div>

<script>
  const base = ${JSON.stringify(base)};
  let current = ${JSON.stringify(instances[0]?.id || '')};

  function setActive(id){
    current = id;
    for (const b of document.querySelectorAll('.tab')){
      b.classList.toggle('active', b.dataset.inst === id);
    }
    render();
  }

  // rename por duplo clique
  document.addEventListener('dblclick', async (ev)=>{
    const b = ev.target.closest('.tab');
    if(!b) return;
    const id = b.dataset.inst;
    const novo = prompt('Novo nome para a aba:', b.textContent.trim());
    if(novo == null) return;
    const res = await fetch(base.replace(/\\/admin$/, '') + '/api/instances/' + id + '/label', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({ label: novo })
    });
    const j = await res.json().catch(()=>({}));
    if(j?.ok){ b.textContent = novo; } else { alert('Falha ao salvar rótulo'); }
  });

  document.getElementById('tabs').addEventListener('click', (ev)=>{
    const b = ev.target.closest('.tab');
    if(b) setActive(b.dataset.inst);
  });

  document.getElementById('open-classic').onclick = ()=>{
    if(!current) return;
    window.open(base + '/whatsapp?inst=' + encodeURIComponent(current), '_blank');
  };

  async function render(){
    // carrega status JSON da instância atual (ex.: sua rota já existente)
    const txt = document.getElementById('status');
    txt.value = 'Carregando...';
    try{
      const r = await fetch(base.replace(/\\/admin$/, '') + '/api/hub/instances/' + current + '/status');
      const j = await r.json();
      txt.value = JSON.stringify(j, null, 2);
    }catch(e){
      txt.value = 'Erro ao consultar status';
    }
    document.getElementById('qr-area').textContent = 'Aguardando geração do QR...';
  }

  // Botões
  document.getElementById('btn-connect').onclick = ()=> post('connect');
  document.getElementById('btn-disconnect').onclick = ()=> post('disconnect');
  document.getElementById('btn-clear').onclick = ()=> post('clear');

  async function post(action){
    if(!current) return;
    const url = base.replace(/\\/admin$/, '') + '/api/hub/instances/' + current + '/' + action;
    const res = await fetch(url, { method:'POST' });
    if(res.ok) render(); else alert('Falha na ação: ' + action);
  }

  // seleciona a primeira aba ao abrir
  const first = document.querySelector('.tab');
  if(first) setActive(first.dataset.inst);
</script>
</body>
</html>`;

  res.set('content-type', 'text/html; charset=utf-8').send(html);
});

// ========= API para salvar rótulo (rename) =========
router.post('/api/instances/:id/label', require('express').json(), (req, res) => {
  const fs = require('fs');
  const path = require('path');

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

  const id = String(req.params.id || '').trim();
  const label = String(req.body?.label || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

  const labels = readLabels();
  labels[id] = label || id;
  writeLabels(labels);
  res.json({ ok: true, id, label: labels[id] });
});

module.exports = router;
