// src/services/session-backup.js
// Backups rotativos das pastas de sessão do WhatsApp (multi-instância ou single).
// Ative via ENV: SESSION_BACKUP=1, SESSION_BACKUP_DIR, SESSION_BACKUP_RETENTION

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ENABLED = String(process.env.SESSION_BACKUP || '0') === '1';
const BACKUP_DIR = process.env.SESSION_BACKUP_DIR || path.resolve('/data/wa-backups');
const RETENTION = Math.max(1, Number(process.env.SESSION_BACKUP_RETENTION || 3));
const SESSION_BASE = process.env.WA_SESSION_BASE || null; // preferível em multi-instância
const SINGLE_SESSION_DIR = process.env.WHATSAPP_SESSION_PATH || path.resolve('data', 'whatsapp-session');

function sessionDirFor(instanceId = 'default') {
  if (SESSION_BASE) return path.join(SESSION_BASE, String(instanceId));
  // Single-instância: ignora instanceId e usa o diretório único
  return SINGLE_SESSION_DIR;
}

async function safeCp(src, dest) {
  // Node >=16 tem fs.cp; fallback simples para versões antigas
  if (fs.cp) return fs.promises.cp(src, dest, { recursive: true, force: true });
  // fallback: copiar recursivo
  const stat = await fsp.stat(src);
  if (stat.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    const items = await fsp.readdir(src);
    for (const it of items) {
      await safeCp(path.join(src, it), path.join(dest, it));
    }
  } else {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
  }
}

async function listBackups(instanceId = 'default') {
  const dir = path.join(BACKUP_DIR, String(instanceId));
  try {
    const entries = await fsp.readdir(dir);
    return entries
      .map(name => ({ name, full: path.join(dir, name) }))
      .filter(e => fs.existsSync(e.full) && fs.statSync(e.full).isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function prune(instanceId = 'default') {
  const list = await listBackups(instanceId);
  const extra = Math.max(0, list.length - RETENTION);
  for (let i = 0; i < extra; i++) {
    try {
      await fsp.rm(list[i].full, { recursive: true, force: true });
    } catch {}
  }
}

async function backup(instanceId = 'default') {
  if (!ENABLED) return { ok: false, error: 'SESSION_BACKUP desabilitado' };
  const src = sessionDirFor(instanceId);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, String(instanceId), ts);

  try {
    await fsp.mkdir(dest, { recursive: true });
    await safeCp(src, dest);
    await prune(instanceId);
    return { ok: true, snapshot: ts, path: dest };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function restore(instanceId = 'default', snapshotName) {
  if (!snapshotName) return { ok: false, error: 'snapshotName obrigatório' };
  const snap = path.join(BACKUP_DIR, String(instanceId), snapshotName);
  const dst = sessionDirFor(instanceId);
  try {
    // apaga sessão atual e coloca o snapshot
    await fsp.rm(dst, { recursive: true, force: true });
    await fsp.mkdir(dst, { recursive: true });
    await safeCp(snap, dst);
    return { ok: true, restoredTo: dst };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

module.exports = {
  ENABLED,
  BACKUP_DIR,
  RETENTION,
  sessionDirFor,
  listBackups,
  backup,
  restore,
};
