import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';

const dbFile = process.env.SQLITE_PATH || '/tmp/whatsapp-automation.db';

// Inicializar banco
const db = await open({
  filename: dbFile,
  driver: sqlite3.Database
});

// Criar tabelas
const initSql = `
CREATE TABLE IF NOT EXISTS groups (
  jid TEXT PRIMARY KEY,
  name TEXT,
  is_group INTEGER DEFAULT 1,
  participants_count INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 0,
  ativo_sorteios INTEGER DEFAULT 0,
  last_synced_at TEXT
);
`;

await db.exec(initSql);

export async function upsertGroup(g) {
  const stmt = await db.prepare(`
    INSERT INTO groups (jid, name, is_group, participants_count, enabled, ativo_sorteios, last_synced_at)
    VALUES (?, ?, ?, ?, COALESCE(?, 0), COALESCE(?, 0), ?)
    ON CONFLICT(jid) DO UPDATE SET
      name=excluded.name,
      is_group=excluded.is_group,
      participants_count=excluded.participants_count,
      last_synced_at=excluded.last_synced_at
  `);
  
  await stmt.run(g.jid, g.name, g.is_group, g.participants_count, g.enabled, g.ativo_sorteios, g.last_synced_at);
  await stmt.finalize();
}

export const listGroups = async () => {
  return await db.all('SELECT * FROM groups ORDER BY name COLLATE NOCASE');
};

export const listActiveGroups = async () => {
  return await db.all('SELECT * FROM groups WHERE enabled=1 OR ativo_sorteios=1 ORDER BY name');
};

export const setGroupField = async (jid, field, value) => {
  const allowedFields = ['enabled', 'ativo_sorteios'];
  if (!allowedFields.includes(field)) {
    throw new Error('Campo não permitido');
  }
  
  const stmt = await db.prepare(`UPDATE groups SET ${field}=? WHERE jid=?`);
  await stmt.run(value ? 1 : 0, jid);
  await stmt.finalize();
};

export default db;

