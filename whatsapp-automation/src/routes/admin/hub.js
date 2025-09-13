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
  // Base ex.: https://app.onrender.com/admin
  const base = ${JSON.stringify(base)};

  // raiz da API do hub (sem /admin)
  const apiRoot = base.replace(/\/admin$/, '') + '/api/hub';

  // id atual (primeira aba por padrão)
  let current = ${JSON.stringify(instances[0]?.id || '')};

  // ==== util ====
  async function postJSON(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body || {})
    });
    return r.json().catch(() => ({}));
  }

  // ==== abas (clique e renomear) ====
  const $tabs = document.getElementById('tabs');

  // ativa aba
  function setActive(id){
    current = id;
    document.querySelectorAll('#tabs .tab').forEach(b => {
      b.classList.toggle('active', b.dataset.inst === id);
    });
    render();
  }

  // clique: troca aba
  $tabs.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button.tab');
    if (!btn) return;
    setActive(btn.dataset.inst);
  });

  // duplo clique: renomeia
  $tabs.addEventListener('dblclick', async (ev) => {
    const btn = ev.target.closest('button.tab');
    if (!btn) return;
    const id = btn.dataset.inst;
    const atual = btn.textContent.trim();
    const label = prompt('Novo nome para esta aba:', atual);
    if (!label || label === atual) return;

    // nossa rota de rename vive sob /admin
    const res = await postJSON(`${base}/api/instances/${encodeURIComponent(id)}/label`, { label });
    if (res && res.ok) btn.textContent = label;
    else alert('Não consegui renomear: ' + (res?.error || 'erro'));
  });

  // ==== Status + QR ====
  async function render() {
    await renderStatus();
    renderQR(); // só atualiza a imagem do QR
  }

  async function renderStatus() {
    const txt = document.getElementById('status');
    if (!current) { txt.value = 'Nenhuma instância selecionada'; return; }
    txt.value = 'Carregando status...';
    try {
      const r = await fetch(`${apiRoot}/inst/${encodeURIComponent(current)}/status`);
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      txt.value = JSON.stringify(j, null, 2);
    } catch (e) {
      txt.value = 'Erro ao consultar status';
    }
  }

  function renderQR() {
    const $qr = document.getElementById('qr-area');
    if (!current) { $qr.textContent = 'Selecione uma instância'; return; }
    // o backend já expõe /api/hub/inst/:id/qr — mostramos como <img>
    const ts = Date.now(); // evita cache
    $qr.innerHTML = `<img alt="QR" style="max-width:100%;height:auto"
                       src="${apiRoot}/inst/${encodeURIComponent(current)}/qr?ts=${ts}">`;
  }

  // ==== Ações (conectar / desconectar / limpar) ====
  document.getElementById('btn-connect').onclick = () => doAction('connect');
  document.getElementById('btn-disconnect').onclick = () => doAction('disconnect');
  document.getElementById('btn-clear').onclick = () => doAction('clear');

  async function doAction(action) {
    if (!current) return;
    try {
      const r = await fetch(`${apiRoot}/inst/${encodeURIComponent(current)}/${action}`, { method: 'POST' });
      if (!r.ok) throw new Error(r.status);
      await render();
    } catch (e) {
      alert('Falha na ação: ' + action);
    }
  }

  // botão "UI clássica": abre a tela antiga para a instância atual
  document.getElementById('open-classic').onclick = () => {
    if (!current) return;
    window.open(base.replace(/\/admin$/, '') + '/admin/whatsapp?inst=' + encodeURIComponent(current), '_blank');
  };

  // seleciona a primeira aba
  const first = document.querySelector('#tabs .tab');
  if (first) setActive(first.dataset.inst);
</script>

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
