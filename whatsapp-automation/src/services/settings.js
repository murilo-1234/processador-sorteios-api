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

    // Compat: migra legado para lista
    if (s.resultGroupJid && !s.postGroupJids.length) {
      s.postGroupJids = [s.resultGroupJid];
    }

    // Mantém resultGroupJid igual ao primeiro da lista
    s.resultGroupJid = s.postGroupJids.length ? s.postGroupJids[0] : (s.resultGroupJid ?? null);

    // NOVO: bloco de estado da fila segura (opcional, sem quebrar)
    const ss = s.safeSend || {};
    s.safeSend = {
      lastSentAtByGroup: ss.lastSentAtByGroup || {},
      cursors: ss.cursors || {},
      sentLastHour: Array.isArray(ss.sentLastHour) ? ss.sentLastHour : [],
      sentToday: Array.isArray(ss.sentToday) ? ss.sentToday : [],
      lastGlobalSentAt: Number(ss.lastGlobalSentAt || 0),
      locks: ss.locks || {}
    };

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
        lastSentAtByGroup: {},
        cursors: {},
        sentLastHour: [],
        sentToday: [],
        lastGlobalSentAt: 0,
        locks: {}
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

module.exports = {
  get() { return load(); },

  set(upd) {
    const cur = load();
    const out = { ...cur, ...upd };
    // coerência com o legado
    if (Array.isArray(out.postGroupJids)) {
      out.postGroupJids = dedup(out.postGroupJids);
      out.resultGroupJid = out.postGroupJids[0] || null;
    }
    // garante shape do safeSend mesmo se vier parcial
    if (out.safeSend) {
      const ss = out.safeSend;
      out.safeSend = {
        lastSentAtByGroup: ss.lastSentAtByGroup || {},
        cursors: ss.cursors || {},
        sentLastHour: Array.isArray(ss.sentLastHour) ? ss.sentLastHour : [],
        sentToday: Array.isArray(ss.sentToday) ? ss.sentToday : [],
        lastGlobalSentAt: Number(ss.lastGlobalSentAt || 0),
        locks: ss.locks || {}
      };
    }
    save(out);
    return out;
  },

  // define vários grupos
  setPostGroups(jids = []) {
    const s = load();
    s.postGroupJids = dedup(jids);
    s.resultGroupJid = s.postGroupJids[0] || null; // mantém legado vivo
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
  }
};
