const fs = require('fs');
const path = require('path');

const SETTINGS_DIR = process.env.SETTINGS_DIR || '/data/config';
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

function ensureDir() {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
}

function load() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const s = JSON.parse(raw);

    // defaults
    if (!Array.isArray(s.groups)) s.groups = [];
    if (!('lastSyncAt' in s)) s.lastSyncAt = null;
    if (!Array.isArray(s.postedIds)) s.postedIds = [];

    // lista de grupos selecionados
    if (!Array.isArray(s.postGroupJids)) s.postGroupJids = [];
    // Compat: migra legado para a lista
    if (s.resultGroupJid && !s.postGroupJids.length) s.postGroupJids = [s.resultGroupJid];
    // Mantém legado vivo
    s.resultGroupJid = s.postGroupJids.length ? s.postGroupJids[0] : (s.resultGroupJid ?? null);

    // NOVO: estado de envio seguro (não quebra nada se ausente)
    if (typeof s.safeSend !== 'object' || s.safeSend === null) s.safeSend = {};
    if (typeof s.safeSend.lastAnySentAt !== 'number') s.safeSend.lastAnySentAt = 0;
    if (typeof s.safeSend.lastSentAtByGroup !== 'object') s.safeSend.lastSentAtByGroup = {};
    if (typeof s.safeSend.cursors !== 'object') s.safeSend.cursors = {};
    if (!Array.isArray(s.safeSend.sentLastHour)) s.safeSend.sentLastHour = [];
    if (!Array.isArray(s.safeSend.sentToday)) s.safeSend.sentToday = [];
    if (typeof s.safeSend.lock !== 'object' || s.safeSend.lock === null) s.safeSend.lock = { owner: '', until: 0 };

    return s;
  } catch {
    // Primeira execução
    return {
      groups: [],
      lastSyncAt: null,
      postedIds: [],
      postGroupJids: [],
      resultGroupJid: null,
      safeSend: {
        lastAnySentAt: 0,
        lastSentAtByGroup: {},
        cursors: {},
        sentLastHour: [],
        sentToday: [],
        lock: { owner: '', until: 0 }
      }
    };
  }
}

function save(data) {
  ensureDir();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

function dedup(arr) {
  return Array.from(new Set((arr || []).filter(Boolean).map(String))).map(s => s.trim()).filter(Boolean);
}

function deepMergeSafeSend(cur, patch) {
  const out = { ...cur };
  if (!patch) return out;
  if ('lastAnySentAt' in patch) out.lastAnySentAt = Number(patch.lastAnySentAt) || 0;
  if (patch.lastSentAtByGroup) out.lastSentAtByGroup = { ...(cur.lastSentAtByGroup || {}), ...(patch.lastSentAtByGroup || {}) };
  if (patch.cursors) out.cursors = { ...(cur.cursors || {}), ...(patch.cursors || {}) };
  if (patch.sentLastHour) out.sentLastHour = Array.isArray(patch.sentLastHour) ? patch.sentLastHour.slice() : (cur.sentLastHour || []);
  if (patch.sentToday) out.sentToday = Array.isArray(patch.sentToday) ? patch.sentToday.slice() : (cur.sentToday || []);
  if (patch.lock) out.lock = { ...(cur.lock || { owner: '', until: 0 }), ...(patch.lock || {}) };
  return out;
}

module.exports = {
  get() { return load(); },

  set(upd) {
    const cur = load();
    const out = { ...cur, ...upd };
    if (Array.isArray(out.postGroupJids)) {
      out.postGroupJids = dedup(out.postGroupJids);
      out.resultGroupJid = out.postGroupJids[0] || null;
    }
    // se veio safeSend no patch, merge cuidadoso
    if (upd && typeof upd.safeSend === 'object') {
      out.safeSend = deepMergeSafeSend(cur.safeSend || {}, upd.safeSend);
    }
    save(out);
    return out;
  },

  // define vários grupos, preservando compatibilidade
  setPostGroups(jids = []) {
    const s = load();
    s.postGroupJids = dedup(jids);
    s.resultGroupJid = s.postGroupJids[0] || null;
    save(s);
    return s;
  },

  addPosted(id) {
    const s = load();
    if (!s.postedIds.includes(id)) s.postedIds.push(id);
    save(s);
    return s;
  },

  hasPosted(id) {
    return load().postedIds.includes(id);
  },

  // NOVOS utilitários sem quebrar API existente
  getSafeSend() { return load().safeSend || { lastAnySentAt: 0, lastSentAtByGroup: {}, cursors: {}, sentLastHour: [], sentToday: [], lock: { owner: '', until: 0 } }; },
  setSafeSend(patch) {
    const s = load();
    s.safeSend = deepMergeSafeSend(s.safeSend || {}, patch || {});
    save(s);
    return s.safeSend;
  }
};
