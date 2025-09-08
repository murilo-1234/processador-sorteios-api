// src/services/reply-queue.js
// Fila por JID com rate-limit leve, typing e split humanizado.

const REPLY_MAX_BURST          = Number(process.env.REPLY_MAX_BURST || 2);
const REPLY_COOLDOWN_MS        = Number(process.env.REPLY_COOLDOWN_MS || 2000);
const SPLIT_TARGET_CHARS       = Number(process.env.SPLIT_TARGET_CHARS || 220);
const SPLIT_MAX_BLOCKS         = Number(process.env.SPLIT_MAX_BLOCKS || 3);
const TYPING_FIRST_MS          = Number(process.env.TYPING_FIRST_MS || 2500);
const SPLIT_DELAY_BASE_MS      = Number(process.env.SPLIT_DELAY_BASE_MS || 3500);
const SPLIT_DELAY_JITTER_MS    = Number(process.env.SPLIT_DELAY_JITTER_MS || 400);
const EXTRA_PER_100CH_MS       = Number(process.env.EXTRA_PER_100CH_MS || 1000);

const queues = new Map(); // jid -> { running:boolean, items:[], nextAt:number, burst:number }

function _now() { return Date.now(); }
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _getQ(jid) {
  let q = queues.get(jid);
  if (!q) { q = { running:false, items:[], nextAt:0, burst:REPLY_MAX_BURST }; queues.set(jid, q); }
  return q;
}

function _splitText(txt) {
  const t = String(txt || '').trim();
  if (!t) return [];
  // tenta quebrar por parágrafos/frases
  const parts = [];
  const hard = t.split(/\n{2,}/);
  for (const chunk of hard) {
    let s = chunk.trim();
    while (s.length > SPLIT_TARGET_CHARS && parts.length < SPLIT_MAX_BLOCKS - 1) {
      // tenta quebrar em ".", "!" ou "?" mais próximos antes do limite
      const cut = s.lastIndexOf('.', SPLIT_TARGET_CHARS) > 80
        ? s.lastIndexOf('.', SPLIT_TARGET_CHARS)
        : (s.lastIndexOf('!', SPLIT_TARGET_CHARS) > 80 ? s.lastIndexOf('!', SPLIT_TARGET_CHARS)
        : (s.lastIndexOf('?', SPLIT_TARGET_CHARS) > 80 ? s.lastIndexOf('?', SPLIT_TARGET_CHARS)
        : s.lastIndexOf(' ', SPLIT_TARGET_CHARS)));
      const idx = cut > 60 ? cut + 1 : SPLIT_TARGET_CHARS;
      parts.push(s.slice(0, idx).trim());
      s = s.slice(idx).trim();
    }
    if (s) parts.push(s);
    if (parts.length >= SPLIT_MAX_BLOCKS) break;
  }
  return parts.slice(0, SPLIT_MAX_BLOCKS);
}

async function _sendTyping(sock, jid, ms) {
  try {
    if (sock?.presenceSubscribe) { await sock.presenceSubscribe(jid); }
    if (sock?.sendPresenceUpdate) { await sock.sendPresenceUpdate('composing', jid); }
  } catch (_) {}
  await _sleep(ms);
}

async function _worker(sock, jid) {
  const q = _getQ(jid);
  if (q.running) return;
  q.running = true;

  while (q.items.length) {
    const item = q.items.shift();
    // rate-limit leve
    const now = _now();
    if (q.burst > 0) {
      q.burst -= 1;
    } else if (now < q.nextAt) {
      await _sleep(q.nextAt - now);
    }
    q.nextAt = _now() + REPLY_COOLDOWN_MS;

    // typing inicial
    await _sendTyping(sock, jid, TYPING_FIRST_MS);

    const chunks = _splitText(item.text);
    const blocks = chunks.length ? chunks : [item.text];

    for (let i = 0; i < blocks.length; i++) {
      const txt = blocks[i];

      try {
        await sock.sendMessage(jid, { text: txt });
      } catch (e) {
        console.error('[reply-queue] send error:', e?.message || e);
      }

      if (i < blocks.length - 1) {
        const base = SPLIT_DELAY_BASE_MS;
        const extra = Math.floor((txt.length / 100)) * EXTRA_PER_100CH_MS;
        const jitter = Math.floor(Math.random() * (SPLIT_DELAY_JITTER_MS * 2)) - SPLIT_DELAY_JITTER_MS;
        await _sendTyping(sock, jid, Math.max(1200, base + extra + jitter));
      }
    }
  }

  // reseta burst devagar
  q.burst = Math.min(REPLY_MAX_BURST, q.burst + 1);
  q.running = false;
}

function enqueueText(sock, jid, text) {
  const q = _getQ(jid);
  q.items.push({ text: String(text || '') });
  _worker(sock, jid);
}

module.exports = { enqueueText };
