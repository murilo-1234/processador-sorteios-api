// src/services/job-lock.js
'use strict';

const fs = require('fs/promises');
const path = require('path');

const BASE_DIR = process.env.JOB_LOCK_DIR || process.env.SETTINGS_DIR || '/data/config';
const TTL_SEC = Number(process.env.JOB_LOCK_TTL_SECONDS || 7200);

async function acquire(name) {
  const dir = BASE_DIR;
  const file = path.join(dir, `lock-${name}.json`);
  await fs.mkdir(dir, { recursive: true });

  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const now = Date.now();
    let stale = true;

    try {
      const raw = await fs.readFile(file, 'utf8');
      if (raw) {
        const cur = JSON.parse(raw);
        const ageMs = now - (cur.ts || 0);
        stale = ageMs > TTL_SEC * 1000;
      }
    } catch {
      stale = true;
    }

    if (!stale) return null;

    await fs.writeFile(file, JSON.stringify({ ts: now, token }), 'utf8');

    // re-check: if someone raced and replaced our token quickly, read back
    try {
      const echo = JSON.parse(await fs.readFile(file, 'utf8'));
      if (echo.token !== token) return null;
    } catch { return null; }

    async function release() {
      try {
        const cur = JSON.parse(await fs.readFile(file, 'utf8'));
        if (cur.token === token) await fs.unlink(file);
      } catch {}
    }

    return { release };
  } catch {
    return null;
  }
}

module.exports = { acquire };
