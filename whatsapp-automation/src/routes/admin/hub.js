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
<script>
  // Base da sua API
  const base = ${JSON.stringify(base)};

  // estado atual
  let current = ${JSON.stringify(instances[0]?.id || '')};

  // utilitário: faz POST JSON
  async function post(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body || {})
    });
    return r.json();
  }

  // ---- Renomear aba com duplo clique (delegation no #tabs) ----
  const $tabs = document.getElementById('tabs');
  $tabs.addEventListener('dblclick', async (ev) => {
    const btn = ev.target.closest('button.tab');
    if (!btn) return;
    const id = btn.dataset.inst;
    const atual = btn.textContent.trim();
    const label = prompt('Novo nome para esta aba:', atual);
    if (!label || label === atual) return;

    try {
      const res = await post(`${base}/api/hub/instances/${encodeURIComponent(id)}/label`, { label });
      if (res && res.ok) {
        btn.textContent = label;
      } else {
        alert('Não consegui renomear: ' + (res?.error || 'erro'));
      }
    } catch (e) {
      alert('Erro de rede ao renomear: ' + e.message);
    }
  });

  // ---- (exemplo) quando clica numa aba, ativa aquela instância ----
  $tabs.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button.tab');
    if (!btn) return;
    document.querySelectorAll('#tabs .tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    current = btn.dataset.inst;
    // aqui você pode disparar algum refresh de status/QR dessa instância…
  });
</script>

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
// Ouça só na barra de abas
document.getElementById('tabs').addEventListener('dblclick', async (ev)=>{
  const b = ev.target.closest('.tab');
  if(!b) return;
  const id = b.dataset.inst;
  const novo = prompt('Novo nome para a aba:', b.textContent.trim());
  if(novo == null) return;

  // IMPORTANTE: rota vive sob /admin, então poste em /admin/...
  const res = await fetch(base + '/api/instances/' + id + '/label', {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({ label: novo })
  });

  const j = await res.json().catch(()=>({}));
  if (j?.ok) b.textContent = novo;
  else alert('Falha ao salvar rótulo');
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
