// src/services/reply-queue.js
// Fila por JID com rate-limit leve, typing e split humanizado,
// NUNCA dividindo links e priorizando quebra em fim de frase.
// Também normaliza links Natura para evitar cortes “.com, \n br/...”.

const REPLY_MAX_BURST       = Number(process.env.REPLY_MAX_BURST || 2);
const REPLY_COOLDOWN_MS     = Number(process.env.REPLY_COOLDOWN_MS || 2000);
const SPLIT_TARGET_CHARS    = Number(process.env.SPLIT_TARGET_CHARS || 240);
const SPLIT_MAX_BLOCKS      = Number(process.env.SPLIT_MAX_BLOCKS || 4);
const TYPING_FIRST_MS       = Number(process.env.TYPING_FIRST_MS || 2500);
const SPLIT_DELAY_BASE_MS   = Number(process.env.SPLIT_DELAY_BASE_MS || 3500);
const SPLIT_DELAY_JITTER_MS = Number(process.env.SPLIT_DELAY_JITTER_MS || 400);
const EXTRA_PER_100CH_MS    = Number(process.env.EXTRA_PER_100CH_MS || 1000);

const queues = new Map(); // jid -> { running:boolean, items:[], nextAt:number, burst:number }

const URL_RE = /(https?:\/\/[^\s]+)/i;
function _now() { return Date.now(); }
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _getQ(jid) {
  let q = queues.get(jid);
  if (!q) { q = { running:false, items:[], nextAt:0, burst:REPLY_MAX_BURST }; queues.set(jid, q); }
  return q;
}

// ——— Normalização de links para evitar “https://www.natura.com,\nbr/...”
function _normalizeLinks(t) {
  let out = String(t || '');

  // juntar “https://www.natura.com, \n br/...” -> “https://www.natura.com.br/...”
  out = out.replace(/https:\/\/www\.natura\.com[,\s]*br\//gi, 'https://www.natura.com.br/');

  // remover pontuação colada ao final do link (vírgula, ponto e ponto-e-vírgula)
  out = out.replace(/(https?:\/\/[^\s,.;]+)[,.;]+/g, '$1');

  return out;
}

// Nunca dividir links: se houver qualquer URL, manda tudo em um bloco.
// Split “mais humano”: tenta evitar blocos muito curtos (anti-órfão) e
// respeita a ideia de parágrafos/sentenças.
function _splitText(txt) {
  const norm = _normalizeLinks(txt);
  const t = String(norm || '').trim();
  if (!t) return [];
  if (URL_RE.test(t)) return [t];

  // Quebra por frases, preservando pontuação.
  const sent = t
    .replace(/\s+/g, ' ')
    .match(/[^.!?]+[.!?]|[^.!?]+$/g) || [t];

  const out = [];
  let buf = '';

  for (const s of sent) {
    const piece = s.trim();

    // Se a sentença é muito curta e o buffer ainda cabe, tenta juntar para evitar “órfão”
    const candidate = buf ? (buf + ' ' + piece) : piece;
    const wouldOverflow = candidate.length > SPLIT_TARGET_CHARS;

    if (!wouldOverflow || !buf) {
      // Ainda cabe no buffer (ou é a primeira sentença)
      buf = candidate;
      continue;
    }

    // Estouraria o alvo. Decide se empurra agora ou tenta não criar bloco minúsculo.
    // Regra anti-órfão: se a sentença atual é bem curta (< 30) ou o buffer está abaixo de 80% do alvo,
    // permita estourar um pouco para evitar uma sobra muito pequena no próximo bloco.
    if (piece.length < 30 || buf.length < Math.floor(SPLIT_TARGET_CHARS * 0.8)) {
      buf = candidate; // estoura um pouco o alvo para evitar bloco minúsculo depois
      continue;
    }

    // Fecha bloco e inicia próximo
    out.push(buf.trim());
    buf = piece;

    if (out.length >= SPLIT_MAX_BLOCKS - 1) break;
  }

  if (buf) out.push(buf.trim());

  // Se o último bloco ficou muito curto (ex.: < 30 chars), junta ao anterior quando possível.
  if (out.length >= 2) {
    const last = out[out.length - 1];
    if (last.length < 30) {
      out[out.length - 2] = `${out[out.length - 2]} ${last}`.trim();
      out.pop();
    }
  }

  return out.slice(0, SPLIT_MAX_BLOCKS);
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
    if (q.burst > 0) q.burst -= 1;
    else if (now < q.nextAt) await _sleep(q.nextAt - now);
    q.nextAt = _now() + REPLY_COOLDOWN_MS;

    // typing inicial
    await _sendTyping(sock, jid, TYPING_FIRST_MS);

    const blocks = _splitText(item.text);
    for (let i = 0; i < blocks.length; i++) {
      const txt = blocks[i];
      try { await sock.sendMessage(jid, { text: txt }); }
      catch (e) { console.error('[reply-queue] send error:', e?.message || e); }

      if (i < blocks.length - 1) {
        const extra = Math.floor(txt.length / 100) * EXTRA_PER_100CH_MS;
        const jitter = Math.floor(Math.random() * (SPLIT_DELAY_JITTER_MS * 2)) - SPLIT_DELAY_JITTER_MS;
        await _sendTyping(sock, jid, Math.max(1200, SPLIT_DELAY_BASE_MS + extra + jitter));
      }
    }
  }

  q.burst = Math.min(REPLY_MAX_BURST, q.burst + 1);
  q.running = false;
}

function enqueueText(sock, jid, text) {
  const q = _getQ(jid);
  q.items.push({ text: String(text || '') });
  _worker(sock, jid);
}

function flushQueuesFor(jid) { queues.delete(jid); }
function clearAll() { queues.clear(); }

module.exports = { enqueueText, flushQueuesFor, clearAll };
