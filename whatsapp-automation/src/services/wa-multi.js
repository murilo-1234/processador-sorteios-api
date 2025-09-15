// src/services/wa-multi.js
// Utilitários para multi-instâncias do WhatsApp (IDs por env + rótulos persistidos).
//
// Este módulo NÃO interfere no fluxo atual — serve como helper para rotas/serviços
// que queiram listar/rotular instâncias e checar sessões no disco.
//
// Compatível com código existente: mantemos as mesmas exports originais
// (SESSION_BASE, LABELS_FILE, getEnvInstanceIds, readLabels, writeLabels,
//  listInstances, sessionPathFor, hasSavedSession, clearSession, setLabel)
// e adicionamos utilitários opcionais (backup/restore/estatísticas) sem efeitos colaterais.
//
// Env relevantes:
//   WA_INSTANCE_IDS="48911111111,48922222222"        -> IDs de instância (separados por vírgula)
//   WA_SESSION_BASE="/data/wa-sessions"              -> base das pastas de sessão por instância
//   WA_LABELS_FILE="/data/wa-instance-labels.json"   -> onde salvar os rótulos amigáveis
//   SESSION_BACKUP="/data/wa-session-backups"        -> (opcional) base para backups de sessões
//   SESSION_BACKUP_KEEP="3"                           -> (opcional) quantos snapshots manter por instância

const fs = require('fs');
const path = require('path');

const SESSION_BASE = process.env.WA_SESSION_BASE || '/data/wa-sessions';
const LABELS_FILE =
  process.env.WA_LABELS_FILE ||
  path.join(SESSION_BASE, '..', 'wa-instance-labels.json');

const BACKUP_BASE =
  process.env.SESSION_BACKUP ||
  path.join(SESSION_BASE, '..', 'wa-session-backups');

const BACKUP_KEEP = Math.max(0, Number(process.env.SESSION_BACKUP_KEEP || 3) | 0);

// ───────────────────────────── helpers base ─────────────────────────────
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

// ───────────────────────────── extras opcionais (upgrade) ─────────────────────────────
function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }

function folderSizeSync(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) total += folderSizeSync(full);
        else total += fs.statSync(full).size || 0;
      } catch {}
    }
  } catch {}
  return total;
}

function getSessionInfo(id) {
  const st = hasSavedSession(id);
  const dir = st.dir;
  const info = {
    id,
    ok: !!st.ok,
    dir: dir,
    files: st.files || 0,
    bytes: 0,
    mtimeMs: null,
  };
  if (!dir || !st.ok) return info;

  try {
    info.bytes = folderSizeSync(dir);
    const stats = fs.statSync(dir);
    info.mtimeMs = stats.mtimeMs || null;
  } catch {}
  return info;
}

function listInstancesWithSessions() {
  const list = listInstances();
  return list.map(i => {
    const si = getSessionInfo(i.id);
    return { ...i, session: si };
  });
}

function hasAnySavedSession() {
  return listInstances().some(i => hasSavedSession(i.id).ok);
}

// snapshot em pasta (sem compressão, para evitar dependências externas)
function backupSession(id) {
  const src = sessionPathFor(id);
  if (!src) return { ok: false, error: 'sessionPath inválido' };

  const probe = hasSavedSession(id);
  if (!probe.ok) return { ok: false, error: 'Nenhuma sessão salva para backup', dir: src };

  const ts = new Date();
  const stamp = [
    ts.getFullYear(),
    String(ts.getMonth() + 1).padStart(2, '0'),
    String(ts.getDate()).padStart(2, '0'),
    '-',
    String(ts.getHours()).padStart(2, '0'),
    String(ts.getMinutes()).padStart(2, '0'),
    String(ts.getSeconds()).padStart(2, '0'),
  ].join('');

  const dest = path.join(BACKUP_BASE, String(id), stamp);
  try {
    ensureDir(path.dirname(dest));
    ensureDir(dest);
    // Node 16+: cpSync recursivo
    fs.cpSync(src, dest, { recursive: true, force: true, errorOnExist: false });
    pruneBackups(id);
    const size = folderSizeSync(dest);
    return { ok: true, src, dest, bytes: size };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function listBackups(id) {
  const base = path.join(BACKUP_BASE, String(id));
  const out = [];
  try {
    const items = fs.readdirSync(base, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort(); // por nome já ordena por timestamp no nosso padrão
    for (const name of items) {
      const dir = path.join(base, name);
      let mtimeMs = null;
      try { mtimeMs = fs.statSync(dir).mtimeMs || null; } catch {}
      out.push({ id, name, dir, bytes: folderSizeSync(dir), mtimeMs });
    }
  } catch {}
  return out;
}

function pruneBackups(id) {
  if (BACKUP_KEEP <= 0) return { ok: true, removed: 0 };
  const list = listBackups(id); // já vem ordenado asc
  const excess = Math.max(0, list.length - BACKUP_KEEP);
  let removed = 0;
  for (let i = 0; i < excess; i++) {
    try { fs.rmSync(list[i].dir, { recursive: true, force: true }); removed++; } catch {}
  }
  return { ok: true, removed };
}

function restoreSession(id, backupName) {
  const dest = sessionPathFor(id);
  if (!dest) return { ok: false, error: 'sessionPath inválido' };
  const src = path.join(BACKUP_BASE, String(id), String(backupName || '').trim());
  try {
    // valida origem
    const stat = fs.statSync(src);
    if (!stat.isDirectory()) return { ok: false, error: 'Backup não encontrado' };

    // limpa destino e restaura
    fs.rmSync(dest, { recursive: true, force: true });
    ensureDir(dest);
    fs.cpSync(src, dest, { recursive: true, force: true, errorOnExist: false });

    return { ok: true, src, dest, bytes: folderSizeSync(dest) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function backupAll() {
  const res = [];
  for (const inst of listInstances()) {
    try { res.push({ id: inst.id, ...(backupSession(inst.id)) }); }
    catch (e) { res.push({ id: inst.id, ok: false, error: e?.message || String(e) }); }
  }
  return res;
}

module.exports = {
  // — exports originais (compat)
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

  // — exports novos (opcionais, sem impacto em fluxos existentes)
  BACKUP_BASE,
  BACKUP_KEEP,
  getSessionInfo,
  listInstancesWithSessions,
  hasAnySavedSession,
  backupSession,
  listBackups,
  pruneBackups,
  restoreSession,
  backupAll,
};
