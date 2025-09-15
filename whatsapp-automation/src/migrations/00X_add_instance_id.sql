-- src/migrations/00X_add_instance_id.sql
-- SQLite migration para habilitar multi-instância.
-- Obs.: o script JS (src/scripts/migrate.js) ignora erros como "duplicate column name"
-- para que esta migration seja idempotente em ambientes já migrados.

PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

-- ===== grupos_whatsapp =====
ALTER TABLE grupos_whatsapp ADD COLUMN instance_id TEXT DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_grupos_whatsapp_instance ON grupos_whatsapp(instance_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_grupos_whatsapp_instance_jid ON grupos_whatsapp(instance_id, jid);

-- ===== envios_whatsapp =====
ALTER TABLE envios_whatsapp ADD COLUMN instance_id TEXT DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_envios_whatsapp_instance ON envios_whatsapp(instance_id);
CREATE INDEX IF NOT EXISTS idx_envios_whatsapp_idempotency_instance ON envios_whatsapp(instance_id, idempotency_key);

-- ===== sorteios_processados =====
ALTER TABLE sorteios_processados ADD COLUMN instance_id TEXT DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_sorteios_processados_instance ON sorteios_processados(instance_id);

-- ===== tabela auxiliar de idempotência (usada por src/lib/idempotency.js) =====
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,
  instance_id   TEXT DEFAULT 'default',
  created_at    TEXT DEFAULT (datetime('now','utc')),
  expires_at    TEXT,                   -- datetime UTC (agora + ttl)
  status        TEXT,                   -- 'reserved' | 'done' | 'failed'
  meta          TEXT                    -- JSON opcional
);
CREATE INDEX IF NOT EXISTS idx_idem_instance_expires ON idempotency_keys(instance_id, expires_at);

-- ===== registro de migration (opcional, inofensivo se não usado) =====
CREATE TABLE IF NOT EXISTS _migrations (
  name       TEXT PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now','utc'))
);
INSERT OR IGNORE INTO _migrations(name) VALUES ('00X_add_instance_id.sql');

COMMIT;
PRAGMA foreign_keys=ON;
