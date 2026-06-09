/**
 * Limpeza de disco para o serviço de bots (Render disk em /data).
 *
 * PROBLEMA: o Baileys grava 1 arquivo por contato (lid-mapping-*.json,
 * sender-key-memory-*.json). Em contas com muitos contatos/grupos isso
 * acumula MILHARES de arquivinhos e estoura o disco/inodes -> ENOSPC
 * ("No space left on device") -> a sessão não consegue salvar -> número cai.
 *
 * SOLUÇÃO: apagar periodicamente SÓ o que o Baileys recria sozinho:
 *   - lid-mapping-*.json        (mapa telefone<->LID, refeito sob demanda)
 *   - sender-key-memory-*.json  (memória de quem já tem sender key)
 *   - mídia antiga em /data/media e /data/images
 *
 * NUNCA apaga: creds.json, app-state-sync-key-*, app-state-sync-version-*,
 * session-*, sender-key-* (apagar esses derrubaria/deslogaria a sessão).
 */

const fs = require('fs');
const path = require('path');

const WA_SESSION_BASE = process.env.WA_SESSION_BASE || './data/baileys-bots';

// Pastas de mídia que podem crescer sem limite (do app de sorteios).
const MEDIA_DIRS = Array.from(new Set([
  process.env.MEDIA_DIR || '/data/media',
  '/data/images',
  './data/media',
  './data/images',
].map((p) => path.resolve(p))));

// Mídia mais velha que isso é removida pela limpeza.
const MEDIA_MAX_AGE_MS = Number(process.env.DISK_MEDIA_MAX_AGE_HOURS || 48) * 3600 * 1000;
// Intervalo da limpeza automática.
const AUTO_INTERVAL_MS = Number(process.env.DISK_CLEANUP_INTERVAL_MIN || 60) * 60 * 1000;

// Prefixos de arquivos de sessão seguros para apagar (o Baileys recria).
const SAFE_SESSION_PREFIXES = ['lid-mapping-', 'sender-key-memory-'];

function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }
function isDir(p) { const s = safeStat(p); return !!s && s.isDirectory(); }
function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// Soma tamanho/quantidade de arquivos de uma pasta (recursivo).
function dirUsage(dir) {
  let bytes = 0, files = 0;
  if (!isDir(dir)) return { bytes, files };
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      const st = safeStat(full);
      if (st) { bytes += st.size; files += 1; }
    }
  }
  return { bytes, files };
}

// Apaga arquivos de sessão seguros (lid-mapping / sender-key-memory) de todas as instâncias.
function cleanSessionCache() {
  let removed = 0, bytes = 0;
  if (!isDir(WA_SESSION_BASE)) return { removed, bytes };
  let bots;
  try { bots = fs.readdirSync(WA_SESSION_BASE, { withFileTypes: true }); } catch { return { removed, bytes }; }
  for (const b of bots) {
    if (!b.isDirectory()) continue;
    const dir = path.join(WA_SESSION_BASE, b.name);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const isSafe = SAFE_SESSION_PREFIXES.some((pfx) => f.startsWith(pfx)) && f.endsWith('.json');
      if (!isSafe) continue;
      const full = path.join(dir, f);
      const st = safeStat(full);
      try { fs.unlinkSync(full); removed++; if (st) bytes += st.size; } catch {}
    }
  }
  return { removed, bytes };
}

// Apaga arquivos mais velhos que maxAgeMs dentro de uma pasta (recursivo).
function cleanOldFiles(dir, maxAgeMs) {
  let removed = 0, bytes = 0;
  if (!isDir(dir)) return { removed, bytes };
  const now = Date.now();
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      const st = safeStat(full);
      if (!st) continue;
      if (now - st.mtimeMs > maxAgeMs) {
        try { fs.unlinkSync(full); removed++; bytes += st.size; } catch {}
      }
    }
  }
  return { removed, bytes };
}

// Uso atual do disco por área (e espaço livre, se disponível).
function getUsage() {
  const areas = [];
  const sess = dirUsage(WA_SESSION_BASE);
  areas.push({ name: 'Sessões WhatsApp', path: path.resolve(WA_SESSION_BASE), bytes: sess.bytes, files: sess.files });
  for (const d of MEDIA_DIRS) {
    if (!isDir(d)) continue;
    const u = dirUsage(d);
    areas.push({ name: 'Mídia', path: d, bytes: u.bytes, files: u.files });
  }

  let disk = null;
  try {
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync('/data');
      disk = {
        total: s.blocks * s.bsize,
        free: s.bfree * s.bsize,
        available: s.bavail * s.bsize,
      };
    }
  } catch {}

  return { at: new Date().toISOString(), areas, disk };
}

// Executa a limpeza segura. Retorna o que foi liberado.
function runCleanup({ mediaMaxAgeMs = MEDIA_MAX_AGE_MS } = {}) {
  const session = cleanSessionCache();
  let media = { removed: 0, bytes: 0 };
  for (const d of MEDIA_DIRS) {
    const r = cleanOldFiles(d, mediaMaxAgeMs);
    media.removed += r.removed;
    media.bytes += r.bytes;
  }
  const totalRemoved = session.removed + media.removed;
  const totalBytes = session.bytes + media.bytes;
  return {
    at: new Date().toISOString(),
    session,
    media,
    totalRemoved,
    totalBytes,
    totalHuman: fmtBytes(totalBytes),
  };
}

let autoTimer = null;
function startAutoCleanup() {
  if (autoTimer) return;
  // roda uma vez logo no boot (libera espaço se já estiver cheio)
  try {
    const r = runCleanup();
    console.log(`[disk-cleanup] inicial: ${r.totalRemoved} arquivos / ${r.totalHuman} liberados (sessão=${r.session.removed}, mídia=${r.media.removed})`);
  } catch (e) {
    console.warn('[disk-cleanup] erro inicial:', e?.message || e);
  }
  autoTimer = setInterval(() => {
    try {
      const r = runCleanup();
      if (r.totalRemoved > 0) {
        console.log(`[disk-cleanup] auto: ${r.totalRemoved} arquivos / ${r.totalHuman} liberados`);
      }
    } catch (e) {
      console.warn('[disk-cleanup] erro auto:', e?.message || e);
    }
  }, AUTO_INTERVAL_MS);
  if (autoTimer.unref) autoTimer.unref();
  console.log(`[disk-cleanup] limpeza automática ativa (a cada ${Math.round(AUTO_INTERVAL_MS / 60000)} min; mídia > ${Math.round(MEDIA_MAX_AGE_MS / 3600000)}h).`);
}

module.exports = { getUsage, runCleanup, startAutoCleanup, fmtBytes };
