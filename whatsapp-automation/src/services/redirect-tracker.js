// src/services/redirect-tracker.js
// Módulo de redirect: avisa clientes sobre mudança de número e rastreia notificações.
// Ativado por ENV REDIRECT_ENABLED=1, seguro com =0 (default).

const database = require('../config/database');

const REDIRECT_ENABLED = String(process.env.REDIRECT_ENABLED || '0') === '1';
const REDIRECT_PHONE   = process.env.REDIRECT_PHONE || '5548991591707';

// Cache em memória: jid -> { notifiedAt, msgCount }
const cache = new Map();

let tableReady = false;

// ───────── Table ─────────
async function ensureTable() {
  if (tableReady) return;
  try {
    const db = await database.getConnection();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS redirect_notificacoes (
        jid TEXT PRIMARY KEY,
        notified_at DATETIME DEFAULT (datetime('now','utc')),
        msg_count INTEGER DEFAULT 0
      );
    `);
    // Pré-carrega cache do SQLite
    const rows = await db.all('SELECT jid, notified_at, msg_count FROM redirect_notificacoes');
    for (const r of rows) {
      cache.set(r.jid, { notifiedAt: r.notified_at, msgCount: r.msg_count });
    }
    tableReady = true;
    console.log(`[redirect] tabela pronta, ${rows.length} jids em cache`);
  } catch (e) {
    console.error('[redirect] ensureTable error:', e?.message);
  }
}

// ───────── Queries ─────────
function isEnabled() {
  return REDIRECT_ENABLED;
}

function wasNotified(jid) {
  return cache.has(jid);
}

async function markNotified(jid) {
  cache.set(jid, { notifiedAt: new Date().toISOString(), msgCount: 0 });
  try {
    const db = await database.getConnection();
    await db.run(
      `INSERT OR IGNORE INTO redirect_notificacoes (jid) VALUES (?)`,
      [jid]
    );
  } catch (e) {
    console.error('[redirect] markNotified error:', e?.message);
  }
}

async function incrementMessageCount(jid) {
  const entry = cache.get(jid);
  if (entry) entry.msgCount = (entry.msgCount || 0) + 1;
  try {
    const db = await database.getConnection();
    await db.run(
      `UPDATE redirect_notificacoes SET msg_count = msg_count + 1 WHERE jid = ?`,
      [jid]
    );
  } catch (e) {
    console.error('[redirect] incrementMessageCount error:', e?.message);
  }
}

// ───────── Mensagens ─────────
function getFullRedirectMessage() {
  return (
    `📢 *Aviso importante!*\n\n` +
    `Nosso número de atendimento mudou!\n` +
    `O novo número é: https://wa.me/${REDIRECT_PHONE}\n\n` +
    `Por favor, salve o novo contato para continuar recebendo\n` +
    `nossas ofertas, cupons e novidades. 😊\n\n` +
    `Ainda posso te ajudar por aqui, mas em breve\n` +
    `este número será desativado.`
  );
}

function getFooter() {
  return `📱 *Lembrete:* novo número ➡️ https://wa.me/${REDIRECT_PHONE}`;
}

// ───────── Stats ─────────
async function getStats() {
  try {
    const db = await database.getConnection();
    const total = await db.get('SELECT COUNT(*) as cnt FROM redirect_notificacoes');
    const totalMsgs = await db.get('SELECT COALESCE(SUM(msg_count),0) as cnt FROM redirect_notificacoes');
    const last24h = await db.get(
      `SELECT COUNT(*) as cnt FROM redirect_notificacoes
       WHERE notified_at >= datetime('now','-1 day')`
    );
    return {
      enabled: REDIRECT_ENABLED,
      phone: REDIRECT_PHONE,
      total_notified: total?.cnt || 0,
      msgs_after_redirect: totalMsgs?.cnt || 0,
      notified_last_24h: last24h?.cnt || 0,
      cache_size: cache.size,
    };
  } catch (e) {
    return { enabled: REDIRECT_ENABLED, phone: REDIRECT_PHONE, error: e?.message };
  }
}

module.exports = {
  isEnabled,
  ensureTable,
  wasNotified,
  markNotified,
  incrementMessageCount,
  getFullRedirectMessage,
  getFooter,
  getStats,
};
