// src/services/inbox-state.js
// Estado leve por JID: coalesce de entrada + greeted TTL
const COALESCE_WINDOW_MS = Number(process.env.COALESCE_WINDOW_MS || 1200);
// TTL padrão: 24h (evita repetir saudação dentro do mesmo assunto)
const GREET_TTL_SECONDS  = Number(process.env.GREET_TTL_SECONDS  || 86400);

const buckets = new Map(); // jid -> { timer, msgs:[], lastGreetAt:number }
const now = () => Date.now();

function _get(jid) {
  let s = buckets.get(jid);
  if (!s) { s = { timer: null, msgs: [], lastGreetAt: 0 }; buckets.set(jid, s); }
  return s;
}

/**
 * Enfileira mensagem recebida e agenda o "flush" do pacote após COALESCE_WINDOW_MS.
 * handler(batch, ctx) recebe as mensagens e contexto com flags de greeting.
 */
function pushIncoming(jid, msg, handler) {
  const s = _get(jid);
  s.msgs.push(String(msg ?? ''));

  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    try {
      const batch = s.msgs.splice(0, s.msgs.length);
      s.timer = null;
      const greetedRecently = (now() - s.lastGreetAt) < GREET_TTL_SECONDS * 1000;
      const ctx = { shouldGreet: !greetedRecently, greetedRecently };
      handler(batch, ctx);
    } catch (e) {
      console.error('[inbox-state] handler error:', e?.message || e);
    }
  }, COALESCE_WINDOW_MS);
}

function markGreeted(jid) { _get(jid).lastGreetAt = now(); }

function reset(jid) {
  const s = _get(jid);
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  s.msgs = [];
  s.lastGreetAt = 0;
}

module.exports = { pushIncoming, markGreeted, reset };
