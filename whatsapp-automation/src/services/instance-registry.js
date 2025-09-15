// src/services/instance-registry.js
// Fonte: ENV WA_INSTANCE_IDS ou arquivo JSON (opcional).
// Compatível com a versão anterior, com melhorias:
// - Suporte a WA_INSTANCES_FILE para definir o caminho do JSON
// - Gravação opcional no arquivo quando a origem for um JSON (add/remove/update/setLabel/setEnabled)
// - Parsing mais tolerante do ENV (vírgula/; / espaço)
// - Dedupe e normalização de campos

const fs = require('fs');
const path = require('path');

const ENV_FILE = (process.env.WA_INSTANCES_FILE || '').trim();
const FILE_CANDIDATES = [
  ENV_FILE && path.resolve(ENV_FILE),
  path.resolve('/data/wa-instances.json'),
  path.resolve(process.cwd(), 'data', 'wa-instances.json'),
].filter(Boolean);

let cache = [];
let lastSource = 'env';
let persistPath = null;

// ─── utils ────────────────────────────────────────────────────────────────────
function normalizeItem(it, idx) {
  const id = String(it?.id || '').trim();
  if (!id) return null;
  const label =
    typeof it?.label === 'string' && it.label.trim()
      ? it.label.trim()
      : (idx === 0 ? 'Celular 1' : `whatsapp ${idx + 1}`);
  const enabled = it?.enabled !== false; // default true
  return { id, label, enabled };
}

function dedupeById(arr) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    if (!it) continue;
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

function parseFromEnv() {
  const raw = (process.env.WA_INSTANCE_IDS || '').trim();
  if (!raw) return [];
  // vírgula, ponto-e-vírgula ou espaço(s)
  const items = raw.split(/[,\s;]+/).map(s => s.trim()).filter(Boolean);
  return items
    .map((id, i) => normalizeItem({ id, enabled: true }, i))
    .filter(Boolean);
}

function readJsonIfExists(file) {
  try {
    if (fs.existsSync(file)) {
      const txt = fs.readFileSync(file, 'utf8');
      const arr = JSON.parse(txt);
      if (Array.isArray(arr)) return arr;
    }
  } catch (_) {}
  return null;
}

function safeWriteFileAtomic(file, txt) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {}
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, txt);
  fs.renameSync(tmp, file);
  return true;
}

// ─── load/persist ────────────────────────────────────────────────────────────
function load() {
  // 1) ENV
  const fromEnv = parseFromEnv();
  if (fromEnv.length > 0) {
    cache = dedupeById(fromEnv);
    lastSource = 'env';
    persistPath = null; // não persistimos alterações quando origem é ENV
    return;
  }

  // 2) Arquivo
  for (const f of FILE_CANDIDATES) {
    const arr = readJsonIfExists(f);
    if (arr && arr.length) {
      const norm = arr.map((it, i) => normalizeItem(it, i)).filter(Boolean);
      cache = dedupeById(norm);
      lastSource = f;
      persistPath = f;
      return;
    }
  }

  // 3) Nenhum
  cache = [];
  lastSource = 'none';
  // Se WA_INSTANCES_FILE vier setado, ainda podemos persistir depois
  persistPath = ENV_FILE || null;
}

function persistIfPossible() {
  if (!persistPath) return false;
  try {
    const txt = JSON.stringify(cache, null, 2);
    return safeWriteFileAtomic(persistPath, txt);
  } catch (_) {
    return false;
  }
}

// ─── API pública (back-compat) ───────────────────────────────────────────────
function listInstances() {
  if (!cache.length) load();
  return cache.slice();
}

function getInstance(id) {
  if (!cache.length) load();
  return cache.find(x => x.id === id) || null;
}

function addInstance(obj) {
  if (!cache.length) load();
  const newItem = normalizeItem(obj, cache.length);
  if (!newItem) return listInstances();
  if (!cache.some(x => x.id === newItem.id)) {
    cache.push(newItem);
    cache = dedupeById(cache);
    persistIfPossible();
  }
  return listInstances();
}

function removeInstance(id) {
  if (!cache.length) load();
  const before = cache.length;
  cache = cache.filter(x => x.id !== id);
  if (cache.length !== before) persistIfPossible();
  return listInstances();
}

function reload() {
  cache = [];
  load();
  return listInstances();
}

// ─── API extra (opcional, não quebra compat) ─────────────────────────────────
function updateInstance(id, patch = {}) {
  if (!cache.length) load();
  const idx = cache.findIndex(x => x.id === id);
  if (idx === -1) return listInstances();
  const curr = cache[idx];
  const next = normalizeItem(
    { ...curr, ...patch, id: curr.id }, // id é imutável
    idx
  );
  if (!next) return listInstances();
  cache[idx] = next;
  persistIfPossible();
  return listInstances();
}

function setLabel(id, label) {
  return updateInstance(id, { label: String(label || '').trim() });
}

function setEnabled(id, enabled) {
  return updateInstance(id, { enabled: !!enabled });
}

// carga inicial
load();

module.exports = {
  listInstances,
  getInstance,
  addInstance,
  removeInstance,
  reload,
  // extras
  updateInstance,
  setLabel,
  setEnabled,
  _lastSource: () => lastSource,
  _persistPath: () => persistPath,
};
