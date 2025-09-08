// src/modules/reply-queue.js
// Fila simples por JID para enviar textos em partes com delay (sem depender de nada externo)

const queues = new Map();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function splitText(text, max) {
  if (!max || max <= 0) return [text];
  const s = String(text || '');
  if (s.length <= max) return [s];

  const parts = [];
  let rest = s;
  while (rest.length) {
    if (rest.length <= max) { parts.push(rest); break; }
    // tenta cortar em \n ou espaço para não quebrar palavras
    const slice = rest.slice(0, max + 1);
    let cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
    if (cut < max * 0.6) cut = max; // se não achou boa quebra, corta seco
    parts.push(slice.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  return parts;
}

function getOrCreateQueue(jid) {
  let q = queues.get(jid);
  if (!q) { q = { busy: false, items: [] }; queues.set(jid, q); }
  return q;
}

async function drain(jid) {
  const q = queues.get(jid);
  if (!q || q.busy) return;
  q.busy = true;
  while (q.items.length) {
    const job = q.items.shift();
    try { await job(); } catch (e) { console.error('[reply-queue] job error:', e?.message || e); }
  }
  q.busy = false;
}

function enqueue(jid, fn) {
  const q = getOrCreateQueue(jid);
  q.items.push(fn);
  drain(jid);
}

/**
 * Envia texto com fila, fracionando por ASSISTANT_SPLIT_MAX_CHARS e aguardando ASSISTANT_SPLIT_DELAY_MS entre partes.
 * @param {*} sock  socket do Baileys
 * @param {string} jid  destinatário
 * @param {string} text  mensagem completa
 * @param {object} extraOpts  opções adicionais do sendMessage (opcional)
 */
function sendTextQueued(sock, jid, text, extraOpts = {}) {
  const max = Number(process.env.ASSISTANT_SPLIT_MAX_CHARS || 0);
  const delayMs = Number(process.env.ASSISTANT_SPLIT_DELAY_MS || 0);
  const chunks = splitText(text, max);

  enqueue(jid, async () => {
    for (let i = 0; i < chunks.length; i++) {
      const part = chunks[i];
      try { await sock.sendPresenceUpdate?.('composing', jid); } catch {}
      await sock.sendMessage(jid, { text: part, ...extraOpts });
      try { await sock.sendPresenceUpdate?.('paused', jid); } catch {}
      if (i < chunks.length - 1 && delayMs > 0) await wait(delayMs);
    }
  });
}

function flushQueuesFor(jid) { queues.delete(jid); }
function clearAll() { queues.clear(); }

module.exports = { sendTextQueued, flushQueuesFor, clearAll, splitText };
