// whatsapp-automation/src/services/instance-registry.js
// Lê instâncias do ENV WA_INSTANCE_IDS (CSV) ou de um arquivo JSON.
// Mantém em memória e expõe helpers simples.

const fs = require('fs');
const path = require('path');

const FILE_CANDIDATES = [
  path.resolve('/data/wa-instances.json'),
  path.resolve(process.cwd(), 'data', 'wa-instances.json'), // fallback no projeto
];

let cache = [];
let lastSource = 'env';

function parseFromEnv() {
  const csv = (process.env.WA_INSTANCE_IDS || '').trim();
  if (!csv) return [];
  return csv
    .split(',')
    .map((raw, i) => {
      const id = raw.trim();
      return id ? { id, label: i === 0 ? 'Celular 1' : `whatsapp ${i + 1}`, enabled: true } : null;
    })
    .filter(Boolean);
}

function readJsonIfExists(file) {
  try {
    if (fs.existsSync(file)) {
      const txt = fs.readFileSync(file, 'utf8');
      const arr = JSON.parse(txt);
      if (Array.isArray(arr)) return arr;
    }
  } catch (_) { /* ignore */ }
  return null;
}

function load() {
  const fromEnv = parseFromEnv();
  if (fromEnv.length > 0) { cache = fromEnv; lastSource = 'env'; return; }
  for (const f of FILE_CANDIDATES) {
    const arr = readJsonIfExists(f);
    if (arr && arr.length) { cache = arr; lastSource = f; return; }
  }
  cache = []; lastSource = 'none';
}

function listInstances() { if (!cache.length) load(); return cache.slice(); }
function getInstance(id) { if (!cache.length) load(); return cache.find(x => x.id === id) || null; }
function addInstance(obj){ if (!cache.length) load(); if(!cache.some(x=>x.id===obj.id)) cache.push({ ...obj, enabled: obj.enabled !== false }); return listInstances(); }
function removeInstance(id){ if (!cache.length) load(); cache = cache.filter(x=>x.id!==id); return listInstances(); }
function reload(){ cache = []; load(); return listInstances(); }

load();

module.exports = {
  listInstances, getInstance, addInstance, removeInstance, reload,
  _lastSource: () => lastSource,
};
