const fs = require('fs');
const path = require('path'); // mantido por compatibilidade (ok ter import aqui)

const SETTINGS_DIR = process.env.SETTINGS_DIR || '/data/config';
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

function ensureDir() {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
}

function load() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    // Garante campos padrão sem quebrar arquivos existentes
    if (!Array.isArray(parsed.postedIds)) parsed.postedIds = [];
    if (!('resultGroupJid' in parsed)) parsed.resultGroupJid = null;
    if (!Array.isArray(parsed.groups)) parsed.groups = [];
    if (!('lastSyncAt' in parsed)) parsed.lastSyncAt = null;

    return parsed;
  } catch {
    // Primeira execução: cria estrutura básica
    return { resultGroupJid: null, groups: [], lastSyncAt: null, postedIds: [] };
  }
}

function save(data) {
  ensureDir();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

module.exports = {
  // Lê o settings atual
  get() { return load(); },

  // Faz merge e salva
  set(upd) {
    const cur = load();
    const out = { ...cur, ...upd };
    save(out);
    return out;
  },

  // NOVO: marca um id de sorteio como já postado (evita duplicar)
  addPosted(id) {
    const cur = load();
    if (!Array.isArray(cur.postedIds)) cur.postedIds = [];
    if (!cur.postedIds.includes(id)) {
      cur.postedIds.push(id);
      save(cur);
    }
    return cur;
  },

  // NOVO: consulta se já foi postado
  hasPosted(id) {
    const cur = load();
    return Array.isArray(cur.postedIds) && cur.postedIds.includes(id);
  }
};
