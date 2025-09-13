// whatsapp-automation/src/routes/api/hub.js
// API do Hub (isolada) + página multi-abas (compat).
// ► Agora cada aba (instância) usa um diretório de sessão próprio: ./data/baileys/<inst>
// ► Mantém compat com rotas antigas: aceita ?inst= e /inst/:id/...
// ► Não altera os módulos/rotas existentes do app (evita quebrar outras partes).

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const QRCode = require('qrcode');

const router = express.Router();

// ---------------------------------------------------------------------
// Registry de instâncias (IDs vindos do ENV ou arquivo)
// ---------------------------------------------------------------------
const {
  listInstances,
  getInstance,
} = require('../../services/instance-registry');

// ---------------------------------------------------------------------
// Base de sessões (default atualizado para ./data/baileys)
// Cada instância salva em ./data/baileys/<inst>
// ---------------------------------------------------------------------
const SESSION_BASE =
  process.env.WA_SESSION_BASE ||
  path.join(process.cwd(), 'data', 'baileys');

function sessionDirFor(inst) {
  return path.join(SESSION_BASE, String(inst));
}

function hasSessionFilesSync(dir) {
  try {
    const list = fs.readdirSync(dir);
    return list.some(f => /creds|app-state-sync|pre-key|sender-key/i.test(f));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// Gerenciador multi-instância (um cliente WhatsApp por instância)
// Usa o mesmo WhatsAppClient interno do projeto (fallback), mas isolado
// aqui para não interferir no restante do sistema.
// ---------------------------------------------------------------------
const WhatsAppClient = (() => {
  try {
    // mesmo cliente do seu projeto (usado no fallback do app)
    return require('../../services/whatsapp-client');
  } catch {
    return null;
  }
})();

const clients = new Map();
/*
  clients: Map(instId => {
    client,              // WhatsAppClient
    statusCache: {...},  // último status conhecido
    lastInitAt: number
  })
*/

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true }).catch(() => {});
}

/**
 * Cria (se preciso) e retorna o cliente da instância.
 * Para isolar as sessões, setamos WA_SESSION_PATH só no momento da criação.
 */
async function getOrCreateClient(inst, { create = false } = {}) {
  const id = String(inst || '').trim();
  if (!id) return null;
  if (clients.has(id)) return clients.get(id);

  if (!create) return null;
  if (!WhatsAppClient) return null; // fallback indisponível

  const sessDir = sessionDirFor(id);
  await ensureDir(sessDir);

  // Guardamos/restauramos o valor anterior para não poluir o processo
  const prevPath = process.env.WA_SESSION_PATH;
  try {
    process.env.WA_SESSION_PATH = sessDir;

    const client = new WhatsAppClient();
    // Não chamamos initialize() aqui para responder rápido ao POST /connect.
    // Inicialização pode ocorrer lazy no primeiro status/qr.
    const box = { client, statusCache: null, lastInitAt: 0, sessDir };
    clients.set(id, box);
    return box;
  } finally {
    if (prevPath == null) delete process.env.WA_SESSION_PATH;
    else process.env.WA_SESSION_PATH = prevPath;
  }
}

async function initIfNeeded(box) {
  if (!box) return false;
  if (box.client?.sock || box.client?.isConnected) return true;

  try {
    await box.client.initialize();
    box.lastInitAt = Date.now();
    return true;
  } catch (e) {
    console.warn(`[hub] initialize(${box.sessDir}) erro:`, e?.message || e);
    return false;
  }
}

async function buildStatus(inst) {
  const info = getInstance(inst);
  const sessDir = sessionDirFor(inst);

  const box = clients.get(inst) || null;
  const connected = !!(box?.client?.isConnected);
  const hasSock   = !!(box?.client?.sock);

  // formata msisdn do mesmo jeito do app (quando disponível)
  let msisdn = null;
  try {
    const u = box?.client?.user;
    if (u?.id) {
      const raw = String(u.id).replace('@s.whatsapp.net','').replace(/^55/,'');
      const m = /(\d{2})(\d{4,5})(\d{4})/.exec(raw);
      if (m) msisdn = `${m[1]} ${m[2]}-${m[3]}`;
    }
  } catch (_) {}

  return {
    ok: true,
    inst: String(inst),
    label: info?.label || String(inst),
    connected,
    connecting: false, // sem estado fino aqui
    hasSock,
    msisdn,
    isConnected: connected,
    qrCodeGenerated: !!box?.client?.getQRCode?.(),
    currentRetry: box?.client?.currentRetry || 0,
    maxRetries: box?.client?.maxRetries || 3,
    circuitBreakerState: box?.client?.circuitBreaker || 'CLOSED',
    failureCount: box?.client?.failureCount || 0,
    sessionDir: sessDir,
    sessionFiles: hasSessionFilesSync(sessDir) ? 'present' : 'none',
    user: box?.client?.user || null,
  };
}

async function forceQR(box) {
  if (!box?.client?.forceQRGeneration) return false;
  try {
    return !!(await box.client.forceQRGeneration());
  } catch (e) {
    console.warn('[hub] forceQR erro:', e?.message || e);
    return false;
  }
}

// ---------------------------------------------------------------------
// Helpers de rótulos (labels das abas)
// Salva/ler rótulos num JSON em ./data/baileys/wa-instance-labels.json
// ---------------------------------------------------------------------
const LABELS_FILE = path.join(SESSION_BASE, 'wa-instance-labels.json');

function readLabels() {
  try { return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8')); }
  catch { return {}; }
}
function writeLabels(obj) {
  try { fs.mkdirSync(path.dirname(LABELS_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(LABELS_FILE, JSON.stringify(obj, null, 2));
}

// =====================================================================
// API
// =====================================================================

// Lista de instâncias (como já estava)
router.get('/api/hub/instances', (_req, res) => {
  res.json({ ok: true, instances: listInstances() });
});

// -------- STATUS (aceita dois formatos) --------
async function statusHandler(inst, res) {
  const id = String(inst || '').trim();
  if (!getInstance(id)) {
    return res.status(404).json({ ok: false, error: 'instance_not_found' });
  }
  // Tenta inicializar lazy (se já existir cliente)
  const box = await getOrCreateClient(id, { create: false });
  if (box && !box.client?.isConnected && !box.client?.sock) {
    // não bloqueia, apenas tenta de leve
    await initIfNeeded(box);
  }
  const st = await buildStatus(id);
  return res.json(st);
}
router.get('/api/hub/status', (req, res) => statusHandler(req.query.inst, res));
router.get('/api/hub/inst/:id/status', (req, res) => statusHandler(req.params.id, res));

// -------- QR (SVG) --------
async function qrHandler(inst, res) {
  const id = String(inst || '').trim();
  if (!getInstance(id)) {
    return res.status(404).send('instance_not_found');
  }
  const box = (await getOrCreateClient(id, { create: true }));
  await initIfNeeded(box);

  // tenta garantir que há um QR pronto
  if (!box.client.getQRCode?.()) {
    await forceQR(box);
  }
  const qr = box.client.getQRCode?.();
  if (!qr) return res.status(404).send('QR não disponível');

  try {
    const svg = await QRCode.toString(qr, { type: 'svg', margin: 1, width: 320 });
    res.set('Content-Type', 'image/svg+xml').send(svg);
  } catch (e) {
    res.status(500).send(e?.message || String(e));
  }
}
router.get('/api/hub/qr', (req, res) => qrHandler(req.query.inst, res));
router.get('/api/hub/inst/:id/qr', (req, res) => qrHandler(req.params.id, res));

// -------- CONNECT (aceita dois formatos) --------
async function connectHandler(inst, res) {
  const id = String(inst || '').trim();
  if (!getInstance(id)) {
    return res.status(404).json({ ok: false, error: 'instance_not_found' });
  }
  if (!WhatsAppClient) {
    return res.status(501).json({ ok: false, error: 'whatsapp_client_unavailable' });
  }
  const box = await getOrCreateClient(id, { create: true });
  // inicializa em background; QR é solicitado na tela
  initIfNeeded(box).then(() => forceQR(box)).catch(() => {});
  return res.status(202).json({ ok: true, inst: id, queued: true });
}
router.post('/api/hub/connect', (req, res) => connectHandler(req.query.inst, res));
router.post('/api/hub/inst/:id/connect', (req, res) => connectHandler(req.params.id, res));

// -------- DISCONNECT (aceita dois formatos) --------
async function disconnectHandler(inst, res) {
  const id = String(inst || '').trim();
  if (!getInstance(id)) {
    return res.status(404).json({ ok: false, error: 'instance_not_found' });
  }
  const box = clients.get(id);
  try {
    if (box?.client?.clearSession) {
      await box.client.clearSession();
    }
  } catch (_) {}
  clients.delete(id); // solta da memória; arquivos já foram limpos
  return res.json({ ok: true, inst: id });
}
router.post('/api/hub/disconnect', (req, res) => disconnectHandler(req.query.inst, res));
router.post('/api/hub/inst/:id/disconnect', (req, res) => disconnectHandler(req.params.id, res));

// -------- CLEAR (apaga a sessão no disco) --------
async function clearHandler(inst, res) {
  const id = String(inst || '').trim();
  if (!getInstance(id)) {
    return res.status(404).json({ ok: false, error: 'instance_not_found' });
  }
  const box = clients.get(id);
  try {
    if (box?.client?.clearSession) {
      await box.client.clearSession();
    }
  } catch (_) {}

  // remove diretório físico
  try {
    await fsp.rm(sessionDirFor(id), { recursive: true, force: true });
  } catch (_) {}
  clients.delete(id);
  return res.json({ ok: true, inst: id, cleared: true });
}
router.post('/api/hub/clear', (req, res) => clearHandler(req.query.inst, res));
router.post('/api/hub/inst/:id/clear', (req, res) => clearHandler(req.params.id, res));

// -------- SSE keepalive (hello + ping) --------
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

// -------- Labels (compat com /api/... e /admin/api/...) --------
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

// =====================================================================
// Página multi-abas (mantida, simples e compatível)
// =====================================================================
router.get(['/admin/wa-multi', '/wa-multi'], async (req, res) => {
  // Tenta obter via HTTP e cai para leitura direta se falhar
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
    `<button class="tab ${i === 0 ? 'active' : ''}" data-inst="${inst.id}" data-label="${inst.label}">${inst.label}</button>`
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
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .card{background:#10192b;border:1px solid #20324a;border-radius:12px;padding:16px}
  textarea{width:100%;height:360px;background:#0d1521;color:#dfe7f7;border:1px solid #20324a;border-radius:8px;padding:12px;font-family:ui-monospace, SFMono-Regular, Menlo, monospace}
  .qr{display:flex;align-items:center;justify-content:center;min-height:360px;border:1px dashed #20324a;border-radius:12px;background:#0d1521}
  .qr img{max-width:100%;height:auto;display:block}
  .btn{border:1px solid #20324a;background:#20324a;color:#fff;border-radius:8px;padding:8px 12px;cursor:pointer}
  .btn.gray{opacity:.85}
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

    <div class="cols">
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
  const API = '/api/hub';
  const tabsEl = document.getElementById('tabs');
  const frameStatus = document.getElementById('status');
  const qrArea = document.getElementById('qr-area');

  let current = '${first}';

  function setActive(btn){
    [...tabsEl.querySelectorAll('.tab')].forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  tabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn || btn.id === 'add') return;
    current = btn.dataset.inst;
    setActive(btn);
    render();
  });

  // Renomear aba
  tabsEl.addEventListener('dblclick', async (e) => {
    const btn = e.target.closest('.tab');
    if (!btn || btn.id === 'add') return;
    const inst = btn.dataset.inst;
    const currentLabel = btn.dataset.label || btn.textContent.trim();
    const next = prompt('Nome da aba:', currentLabel);
    if (!next || next === currentLabel) return;

    const ok = await fetch('/admin/api/instances/' + encodeURIComponent(inst) + '/label', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: next })
    }).then(r => r.ok).catch(() => false);

    if (ok) { btn.dataset.label = next; btn.textContent = next; }
    else { alert('Não foi possível salvar o nome.'); }
  });

  // Ações
  document.getElementById('btn-connect').onclick    = () => doAction('connect');
  document.getElementById('btn-disconnect').onclick = () => doAction('disconnect');
  document.getElementById('btn-clear').onclick      = () => doAction('clear');

  async function doAction(kind){
    if(!current) return;
    try{
      const r = await fetch(API + '/inst/' + encodeURIComponent(current) + '/' + kind, { method:'POST' });
      if(!r.ok) throw new Error(r.status);
      await render();
    }catch(e){ alert('Falha na ação: ' + kind); }
  }

  async function render(){
    frameStatus.value = 'Carregando...';
    try{
      const r = await fetch(API + '/inst/' + encodeURIComponent(current) + '/status');
      const j = await r.json();
      frameStatus.value = JSON.stringify(j, null, 2);
    }catch(_){
      frameStatus.value = 'Erro ao consultar status';
    }
    const ts = Date.now();
    qrArea.innerHTML = '<img alt="QR" src="' + (API + '/inst/' + encodeURIComponent(current) + '/qr?ts=' + ts) + '" onerror="this.style.display=\\'none\\'">';
  }

  // botão "+"
  document.getElementById('add').addEventListener('click', () => {
    window.open('/admin/hub', '_blank');
  });

  // inicial
  const firstBtn = document.querySelector('#tabs .tab');
  if(firstBtn){ setActive(firstBtn); current = firstBtn.dataset.inst; }
  render();
</script>
</body>
</html>`);
});

module.exports = router;
