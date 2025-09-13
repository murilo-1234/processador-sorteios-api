// whatsapp-automation/src/services/wa-session-store-disk.js
// Resolve o diretório de sessão por instância, garantindo que exista.

const fs = require('fs');
const path = require('path');

const BASE = process.env.WA_SESSION_BASE || '/data/whatsapp-session';

function sanitize(id) {
  return String(id || '')
    .replace(/[^a-zA-Z0-9_\-\.]/g, '-')   // evita barras e caracteres estranhos
    .slice(0, 128);
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function sessionPath(inst) {
  const safe = sanitize(inst || 'default');
  const p = path.resolve(BASE, safe);
  ensureDir(p);
  return p;
}

module.exports = { sessionPath };
