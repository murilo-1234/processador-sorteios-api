// src/services/wa-multi.js
// Utilitários para multi-instâncias do WhatsApp (IDs por env + rótulos persistidos).
//
// Este módulo NÃO interfere no fluxo atual — serve como helper para rotas/serviços
// que queiram listar/rotular instâncias e checar sessões no disco.
//
// Env relevantes:
//   WA_INSTANCE_IDS="48911111111,48922222222"   -> IDs de instância (separados por vírgula)
//   WA_SESSION_BASE="/data/wa-sessions"         -> base das pastas de sessão por instância
//   WA_LABELS_FILE="/data/wa-instance-labels.json" -> onde salvar os rótulos amigáveis

const fs = require('fs');
const path = require('path');

const SESSION_BASE = process.env.WA_SESSION_BASE || '/data/wa-sessions';
const LABELS_FILE =
  process.env.WA_LABELS_FILE ||
  path.join(SESSION_BASE, '..', 'wa-instance-labels.json');

function getEnvInstanceIds() {
  const raw = String(process.env.WA_INSTANCE_IDS || '').trim();
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function readLabels() {
  try { return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8')); }
  catch { return {}; }
}
function writeLabels(obj) {
  try { fs.mkdirSync(path.dirname(LABELS_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(LABELS_FILE, JSON.stringify(obj, null, 2));
}

function listInstances() {
  // se existir um registry opcional do projeto, usa ele
  try {
    const reg = require('./instance-registry');
    if (typeof reg.listInstances === 'function') {
      const arr = reg.listInstances() || [];
      if (arr.length) return arr.map(i => ({ id: i.id, label: i.label || i.id }));
    }
  } catch (_) {}

  const ids = getEnvInstanceIds();
  const labels = readLabels();
  return ids.map((id, idx) => ({
    id,
    label: labels[id] || (idx === 0 ? 'Celular 1' : `whatsapp ${idx + 1}`)
  }));
}

function sessionPathFor(id) {
  const clean = String(id || '').trim();
  if (!clean) return null;
  return path.join(SESSION_BASE, clean);
}

function hasSavedSession(id) {
  const dir = sessionPathFor(id);
  if (!dir) return { ok: false, dir: null, files: 0 };
  try {
    const files = fs.readdirSync(dir);
    const ok = files.some(f => /creds|app-state-sync|pre-key|sender-key/i.test(f));
    return { ok, dir, files: files.length };
  } catch {
    return { ok: false, dir, files: 0 };
  }
}

function clearSession(id) {
  const dir = sessionPathFor(id);
  if (!dir) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function setLabel(id, label) {
  const labels = readLabels();
  labels[String(id)] = String(label || '').trim() || String(id);
  writeLabels(labels);
  return labels[String(id)];
}

module.exports = {
  SESSION_BASE,
  LABELS_FILE,
  getEnvInstanceIds,
  readLabels,
  writeLabels,
  listInstances,
  sessionPathFor,
  hasSavedSession,
  clearSession,
  setLabel,
};
