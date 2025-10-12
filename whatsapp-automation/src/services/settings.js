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

    // NOVO: lista de grupos selecionados
    if (!Array.isArray(s.postGroupJids)) s.postGroupJids = [];

    // Compat: se só existir o antigo, migra para a lista
    if (s.resultGroupJid && !s.postGroupJids.length) {
      s.postGroupJids = [s.resultGroupJid];
    }

    // Mantém resultGroupJid igual ao primeiro da lista para não quebrar legado
    s.resultGroupJid = s.postGroupJids.length ? s.postGroupJids[0] : (s.resultGroupJid ?? null);

    return s;
  } catch {
    // Primeira execução
    return {
      groups: [],
      lastSyncAt: null,
      postedIds: [],
      postGroupJids: [],
      resultGroupJid: null
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
    // Se alguém alterou a lista externamente, mantenha coerência com o legado
    if (Array.isArray(out.postGroupJids)) {
      out.postGroupJids = dedup(out.postGroupJids);
      out.resultGroupJid = out.postGroupJids[0] || null;
    }
    save(out);
    return out;
  },

  // NOVO: define vários grupos, preservando compatibilidade
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
