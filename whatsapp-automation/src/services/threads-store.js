// src/services/threads-store.js
// Persistência leve: /data/wa-threads.json
const fs = require('fs/promises');
const path = require('path');

const FILE = path.join(process.cwd(), 'data', 'wa-threads.json');

async function _load() {
  try { const j = JSON.parse(await fs.readFile(FILE, 'utf8')); return j && typeof j === 'object' ? j : {}; }
  catch { return {}; }
}
async function _save(map) {
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch (e) { console.error('[threads-store] save error:', e?.message || e); }
}

async function getThreadId(jid) {
  const m = await _load();
  return m[jid] || null;
}
async function setThreadId(jid, threadId) {
  const m = await _load();
  m[jid] = threadId;
  await _save(m);
  return threadId;
}

module.exports = { getThreadId, setThreadId };
