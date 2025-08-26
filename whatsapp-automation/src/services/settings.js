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
    const parsed = JSON.parse(raw);
    // garante campos padrão sem quebrar o que já existe
    if (!Array.isArray(parsed.postedIds)) parsed.postedIds = [];
    if (!('resultGroupJid' in parsed)) parsed.resultGroupJid = null;
    if (!Array.isArray(parsed.groups)) parsed.groups = [];
    if (!('lastSyncAt' in parsed)) parsed.lastSyncAt = null;
    return parsed;
  } catch {
    return { resultGroupJid: null, groups: [], lastSyncAt: null, postedIds: [] };
  }
}

function save(data) {
  ensureDir();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

module.exports = {
  get() { return load(); },

  set(upd) {
    const cur = load();
    const out = { ...cur, ...upd };
    save(out);
    return out;
  },

  // NOVO: evita postar duas vezes o mesmo id
  addPosted(id) {
    const cur = load();
    if (!Array.isArray(cur.postedIds)) cur.postedIds = [];
    if (!cur.postedIds.includes(id)) {
      cur.postedIds.push(id);
      save(cur);
    }
    return cur;
  },

  hasPosted(id) {
    const cur = load();
    return Array.isArray(cur.postedIds) && cur.postedIds.includes(id);
  }
};
