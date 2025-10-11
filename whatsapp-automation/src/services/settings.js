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

    // defaults existentes
    if (!Array.isArray(s.groups)) s.groups = [];
    if (!('lastSyncAt' in s)) s.lastSyncAt = null;
    if (!Array.isArray(s.postedIds)) s.postedIds = [];

    // NOVO: lista de grupos selecionados
    if (!Array.isArray(s.postGroupJids)) s.postGroupJids = [];

    // Compatibilidade legado
    if (s.resultGroupJid && !s.postGroupJids.length) {
      s.postGroupJids = [s.resultGroupJid];
    }
    s.resultGroupJid = s.postGroupJids.length ? s.postGroupJids[0] : (s.resultGroupJid ?? null);

    // ===== NOVO: controle diário e cooldown por grupo =====
    if (!s.postDaily) s.postDaily = { date: null, sent: 0 };
    if (!s.lastGroupSendAt) s.lastGroupSendAt = {}; // { jid: ISO-string }

    return s;
  } catch {
    // Primeira execução
    return {
      groups: [],
      lastSyncAt: null,
      postedIds: [],
      postGroupJids: [],
      resultGroupJid: null,
      postDaily: { date: null, sent: 0 },
      lastGroupSendAt: {}
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

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
  },

  // ===== NOVO: contadores e cooldown =====
  getDaily() {
    const s = load();
    const key = todayKey();
    if (s.postDaily?.date !== key) {
      s.postDaily = { date: key, sent: 0 };
      save(s);
    }
    return { ...s.postDaily };
  },

  incDaily(n = 1) {
    const s = load();
    const key = todayKey();
    if (s.postDaily?.date !== key) s.postDaily = { date: key, sent: 0 };
    s.postDaily.sent = (s.postDaily.sent || 0) + Number(n || 0);
    save(s);
    return { ...s.postDaily };
  },

  canSendMore(cap = 0) {
    const c = this.getDaily();
    if (!cap || cap <= 0) return true; // sem limite
    return (c.sent || 0) < cap;
  },

  getLastGroupSendAt(jid) {
    const s = load();
    const v = s.lastGroupSendAt?.[jid];
    return v ? new Date(v).getTime() : 0;
  },

  setLastGroupSendAt(jid, whenMs) {
    if (!jid) return;
    const s = load();
    if (!s.lastGroupSendAt) s.lastGroupSendAt = {};
    s.lastGroupSendAt[jid] = new Date(whenMs || Date.now()).toISOString();
    save(s);
  }
};
