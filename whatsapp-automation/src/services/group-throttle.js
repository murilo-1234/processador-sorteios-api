// src/services/group-throttle.js
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const MIN_MIN = Math.max(0, Number(process.env.GROUP_POST_DELAY_MINUTES || 2));
const MAX_MIN = Math.max(MIN_MIN, Number(process.env.GROUP_POST_DELAY_MAX_MINUTES || MIN_MIN));
const SETTINGS_DIR = process.env.SETTINGS_DIR || '/data/config';
const STATE_PATH = process.env.THROTTLE_STATE_PATH || path.join(SETTINGS_DIR, 'throttle.json');

let state = { lastAt: 0 };
let initialized = false;

async function ensureDir(p) {
  try { await fsp.mkdir(path.dirname(p), { recursive: true }); } catch {}
}

async function loadState() {
  await ensureDir(STATE_PATH);
  try {
    const raw = await fsp.readFile(STATE_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.lastAt === 'number') state.lastAt = data.lastAt;
  } catch {}
  initialized = true;
}

async function saveState() {
  try { await fsp.writeFile(STATE_PATH, JSON.stringify(state), 'utf8'); } catch {}
}

function pickDelayMs() {
  const min = MIN_MIN * 60_000;
  const max = MAX_MIN * 60_000;
  if (max <= min) return min;
  const span = max - min;
  const rnd = Math.floor(Math.random() * (span + 1));
  return min + rnd;
}

async function wait(label = 'wa_global') {
  if (!initialized) await loadState();

  const now = Date.now();
  const minWait = pickDelayMs();
  const nextAt = Math.max(now, state.lastAt + minWait);

  const toWait = Math.max(0, nextAt - now);
  if (toWait > 0) {
    await new Promise(r => setTimeout(r, toWait));
  }

  state.lastAt = Date.now();
  await saveState();
}

module.exports = { wait };
