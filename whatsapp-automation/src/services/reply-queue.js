// src/services/reply-queue.js
// Fila por JID com rate-limit leve, typing e split humanizado.
// ⚠️ Compatível com:
// - REPLY_MAX_BURST, REPLY_COOLDOWN_MS, SPLIT_TARGET_CHARS, SPLIT_MAX_BLOCKS,
//   TYPING_FIRST_MS, SPLIT_DELAY_BASE_MS, SPLIT_DELAY_JITTER_MS, EXTRA_PER_100CH_MS
// - E também com as flags do atendente (opcionais):
//   ASSISTANT_SPLIT_MAX_CHARS, ASSISTANT_SPLIT_DELAY_MS, ASSISTANT_TYPING

const REPLY_MAX_BURST   = Number(process.env.REPLY_MAX_BURST || 2);
const REPLY_COOLDOWN_MS = Number(process.env.REPLY_COOLDOWN_MS || 2000);

// Se o atendente definiu um “máximo de chars”, ele sobrescreve o alvo do split
const _ASSIST_MAX = Number(process.env.ASSISTANT_SPLIT_MAX_CHARS || 0);
const SPLIT_TARGET_CHARS = Number(
  _ASSIST_MAX > 0 ? _ASSIST_MAX : (process.env.SPLIT_TARGET_CHARS || 220)
);

const SPLIT_MAX_BLOCKS = Number(process.env.SPLIT_MAX_BLOCKS || 3);
const TYPING_FIRST_MS  = Number(process.env.TYPING_FIRST_MS || 2500);

// Se o atendente definiu um delay entre partes, isso vira o “base” aqui
const _ASSIST_DELAY = Number(process.env.ASSISTANT_SPLIT_DELAY_MS || 0);
const SPLIT_DELAY_BASE_MS   = Number(_ASSIST_DELAY > 0 ? _ASSIST_DELAY : (process.env.SPLIT_DELAY_BASE_MS || 3500));
const SPLIT_DELAY_JITTER_MS = Number(process.env.SPLIT_DELAY_JITTER_MS || 400);
const EXTRA_PER_100CH_MS    = Number(process.env.EXTRA_PER_100CH_MS || 1000);

// Habilita/desabilita “digitando…” (compat com o atendente)
const TYPING_ENABLED = String(process.env.ASSISTANT_TYPING ?? '1') === '1';

const queues = new Map(); // jid -> { running:boolean, items:[], nextAt:number, burst:number }

function _now() { return Date.now(); }
function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function _getQ(jid) {
  let q = queues.get(jid);
  if (!q) {
    q = { running: false, items: [], nextAt: 0, burst: REPLY_MAX_BURST };
    queues.set(jid, q);
  }
  return q;
}

function _splitText(txt) {
  const t = String(txt || '').trim();
  if (!t) return [];
  const parts = [];

  // quebra dura por parágrafos duplos primeiro
  const hard = t.split(/\n{2,}/);
  for (const chunk of hard) {
    let s = chunk.trim();
    while (s.length > SPLIT_TARGET_CHARS && parts.length < SPLIT_MAX_BLOCKS - 1) {
      // tenta quebrar em ".", "!" ou "?" mais próximos antes do limite
      const dot  = s.lastIndexOf('.', SPLIT_TARGET_CHARS);
      const exc  = s.lastIndexOf('!', SPLIT_TARGET_CHARS);
      const qst  = s.lastIndexOf('?', SPLIT_TARGET_CHARS);
      const spc  = s.lastIndexOf(' ', SPLIT_TARGET_CHARS);
      const best = Math.max(dot, exc, qst, spc);

      const idx = best > 60 ? best + 1 : SPLIT_TARGET_CHARS;
      parts.push(s.slice(0, idx).trim());
      s = s.slice(idx).trim();
    }
    if (s) parts.push(s);
    if (parts.length >= SPLIT_MAX_BLOCKS) break;
  }
  return parts.slice(0, SPLIT_MAX_BLOCKS);
}

async function _typing(sock, jid, ms, state = 'composing') {
  if (!TYPING_ENABLED) {
    if (ms > 0) await _sleep(ms);
    return;
  }
  try {
    // alguns clients exigem subscribe antes de presence
    if (sock?.presenceSubscribe) { await sock.presenceSubscribe(jid).catch(() => {}); }
    if (sock?.sendPresenceUpdate) { await sock.sendPresenceUpdate(state, jid).catch(() => {}); }
  } catch (_) {}
  if (ms > 0) await _sleep(ms);
}

async function _worker(sock, jid) {
  const q = _getQ(jid);
  if (q.running) return;
  q.running = true;

  while (q.items.length) {
    const item = q.items.shift();

    // ---- rate-limit leve (burst + cooldown) ----
    const now = _now();
    if (q.burst > 0) {
      q.burst -= 1;
    } else if (now < q.nextAt) {
      await _sleep(q.nextAt - now);
    }
    q.nextAt = _now() + REPLY_COOLDOWN_MS;

    // typing inicial
    await _typing(sock, jid, TYPING_FIRST_MS, 'composing');

    // split "humano"
    const chunks = _splitText(item.text);
    const blocks = chunks.length ? chunks : [item.text];

    for (let i = 0; i < blocks.length; i++) {
      const txt = blocks[i];

      try {
        await sock.sendMessage(jid, { text: txt, ...(item.extraOpts || {}) });
      } catch (e) {
        console.error('[reply-queue] send error:', e?.message || e);
      }

      // entre partes: espera “humanizada” e mantém digitando…
      if (i < blocks.length - 1) {
        const base   = SPLIT_DELAY_BASE_MS;
        const extra  = Math.floor(txt.length / 100) * EXTRA_PER_100CH_MS;
        const jitter = Math.floor(Math.random() * (SPLIT_DELAY_JITTER_MS * 2)) - SPLIT_DELAY_JITTER_MS;
        const waitMs = Math.max(1200, base + extra + jitter);
        await _typing(sock, jid, waitMs, 'composing');
      }
    }

    // ao final, envia "paused" (quando habilitado) para limpar o estado
    await _typing(sock, jid, 0, 'paused');
  }

  // recuperação gradual do burst (1 “slot” por ciclo de worker)
  q.burst = Math.min(REPLY_MAX_BURST, q.burst + 1);
  q.running = false;
}

function enqueueText(sock, jid, text, extraOpts = {}) {
  const q = _getQ(jid);
  q.items.push({ text: String(text || ''), extraOpts });
  _worker(sock, jid);
}

// Aliases utilitários / manutenção
function sendTextQueued(sock, jid, text, extraOpts = {}) { return enqueueText(sock, jid, text, extraOpts); }
function flushQueuesFor(jid) { queues.delete(jid); }
function clearAll() { queues.clear(); }

module.exports = {
  enqueueText,
  sendTextQueued,   // alias retrocompatível
  flushQueuesFor,
  clearAll,
  // útil em testes/eventuais diagnósticos
  _splitText
};
