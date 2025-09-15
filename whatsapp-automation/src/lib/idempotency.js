// src/lib/idempotency.js
// Chaves de idempotência com TTL curto (SQLite via config/database).

const database = require('../config/database');
const DEFAULT_TTL_SEC = Number(process.env.IDEMPOTENCY_TTL_SECONDS || 900); // 15 min

async function ensureTable(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key           TEXT PRIMARY KEY,
      instance_id   TEXT DEFAULT 'default',
      created_at    TEXT DEFAULT (datetime('now','utc')),
      expires_at    TEXT,
      status        TEXT,
      meta          TEXT
    );
  `);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_idem_instance_expires ON idempotency_keys(instance_id, expires_at);`);
}

function makeKey(...parts) {
  return parts
    .flat()
    .map(p => String(p ?? '').replace(/[^\w@.\-]+/g, '_'))
    .filter(Boolean)
    .join(':');
}

async function reserve(key, { instanceId = 'default', ttlSeconds = DEFAULT_TTL_SEC, meta = null } = {}) {
  const db = await database.getConnection();
  await ensureTable(db);

  // limpa expirados
  await db.run(`DELETE FROM idempotency_keys WHERE expires_at IS NOT NULL AND expires_at <= datetime('now','utc')`);

  const found = await db.get(`SELECT key FROM idempotency_keys WHERE key = ?`, [key]);
  if (found) return false;

  const expiresExpr = ttlSeconds > 0 ? `datetime('now','utc','+${ttlSeconds} seconds')` : `NULL`;
  await db.run(
    `INSERT INTO idempotency_keys (key, instance_id, status, expires_at, meta)
     VALUES (?, ?, 'reserved', ${expiresExpr}, ?)`,
    [key, instanceId, meta ? JSON.stringify(meta) : null]
  );
  return true;
}

async function complete(key, status = 'done', metaUpdate = null) {
  const db = await database.getConnection();
  await ensureTable(db);
  await db.run(
    `UPDATE idempotency_keys
       SET status = ?, meta = COALESCE(?, meta), expires_at = NULL
     WHERE key = ?`,
    [status, metaUpdate ? JSON.stringify(metaUpdate) : null, key]
  );
}

async function exists(key) {
  const db = await database.getConnection();
  await ensureTable(db);
  const r = await db.get(`SELECT 1 FROM idempotency_keys WHERE key = ?`, [key]);
  return !!r;
}

module.exports = {
  makeKey,
  reserve,
  complete,
  exists,
  DEFAULT_TTL_SEC,
};
