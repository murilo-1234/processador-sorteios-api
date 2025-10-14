// src/services/send-ledger.js
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const SETTINGS_DIR = process.env.SETTINGS_DIR || '/data/config';
const LEDGER_PATH = process.env.DEDUP_LEDGER_PATH || path.join(SETTINGS_DIR, 'wa-ledger.jsonl');
const RES_TTL_MIN = Number(process.env.RESERVATION_TTL_MINUTES || 45);
const DEDUP_TTL_H = Number(process.env.DEDUP_TTL_HOURS || 240);

let inited = false;
const rec = new Map(); // IK -> {status, reserved_at, sent_at, data}

async function init() {
  await fsp.mkdir(path.dirname(LEDGER_PATH), { recursive: true });
  try {
    const fd = await fsp.open(LEDGER_PATH, 'a+');
    const read = await fd.readFile('utf8');
    if (read) {
      for (const line of read.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          const cur = rec.get(ev.IK) || {};
          if (ev.type === 'reserve') {
            rec.set(ev.IK, {
              status: 'reserved',
              reserved_at: ev.ts,
              sent_at: cur.sent_at || 0,
              data: { ...(cur.data || {}), ...(ev.data || {}) }
            });
          } else if (ev.type === 'commit') {
            rec.set(ev.IK, {
              status: 'done',
              reserved_at: cur.reserved_at || ev.ts,
              sent_at: ev.ts,
              data: { ...(cur.data || {}), ...(ev.data || {}) }
            });
          }
        } catch {}
      }
    }
    await fd.close();
  } catch {}
  inited = true;
}

async function append(ev) {
  const line = JSON.stringify(ev) + '\n';
  await fsp.appendFile(LEDGER_PATH, line, 'utf8');
}

function isExpired(ts, ttlMs) {
  if (!ts) return true;
  return Date.now() - ts > ttlMs;
}

async function reserve(IK, data = {}) {
  if (!inited) await init();

  const cur = rec.get(IK);
  const ttlResMs = RES_TTL_MIN * 60_000;
  const ttlDoneMs = DEDUP_TTL_H * 3_600_000;

  if (cur) {
    if (cur.status === 'done' && !isExpired(cur.sent_at, ttlDoneMs)) {
      return { status: 'exists', reason: 'done', record: cur };
    }
    if (cur.status === 'reserved' && !isExpired(cur.reserved_at, ttlResMs)) {
      return { status: 'exists', reason: 'reserved', record: cur };
    }
  }

  const now = Date.now();
  const record = { status: 'reserved', reserved_at: now, sent_at: 0, data: { ...data } };
  rec.set(IK, record);
  await append({ type: 'reserve', IK, ts: now, data });
  return { status: 'ok', record };
}

async function commit(IK, data = {}) {
  if (!inited) await init();

  const now = Date.now();
  const cur = rec.get(IK) || { data: {} };
  const next = { status: 'done', reserved_at: cur.reserved_at || now, sent_at: now, data: { ...cur.data, ...data } };
  rec.set(IK, next);
  await append({ type: 'commit', IK, ts: now, data });
  return { status: 'ok', record: next };
}

module.exports = { reserve, commit };
