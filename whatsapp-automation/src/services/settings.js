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
    return JSON.parse(raw);
  } catch {
    return { resultGroupJid: null, groups: [], lastSyncAt: null };
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
  }
};
