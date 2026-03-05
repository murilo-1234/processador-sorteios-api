// src/modules/assistant-bot.js
// Auto-responder simples para multi-instância (bots/index.js)
// Responde UMA vez por interação com aviso de mudança de número.
// Sem OpenAI, sem intents, sem SQLite, sem redirect-tracker.

const MENSAGEM_FIXA = [
  '\u{1F4E2} Aviso importante!',
  '',
  'Meu n\u00famero de atendimento mudou!',
  'O novo n\u00famero \u00e9: https://wa.me/5548991784533',
  '',
  'Por favor, salve o novo contato para continuar recebendo',
  'nossas ofertas, cupons e novidades. \u{1F60A}',
  '',
  'Ainda posso te ajudar por aqui, mas em breve',
  'este n\u00famero ser\u00e1 desativado.',
  '',
  'Mais informa\u00e7\u00f5es: https://www.muriloconsultor.com.br/',
  '',
  'Bjos',
  'Murilo Cerqueira',
].join('\n');

// Cooldown em ms: não responde ao mesmo JID dentro desse intervalo
const COOLDOWN_MS = Math.max(10000, Number(process.env.AUTORESPONDER_COOLDOWN_MS || 60000));

// Map global: jid -> timestamp do último envio
const lastSent = new Map();

// Limpa entradas antigas a cada 10 min
setInterval(() => {
  const now = Date.now();
  for (const [jid, ts] of lastSent) {
    if (now - ts > 3600000) lastSent.delete(jid);
  }
}, 600000);

function isGroup(jid) { return String(jid || '').endsWith('@g.us'); }
function isStatus(jid) { return String(jid || '') === 'status@broadcast'; }
function isFromMe(msg) { return !!msg?.key?.fromMe; }

function buildUpsertHandler(getSock, label) {
  return async (ev) => {
    try {
      // Filtra histórico (append) mas aceita notify E undefined
      // (versões antigas do Baileys não têm ev.type)
      if (ev?.type === 'append') return;
      if (!ev?.messages?.length) return;

      console.log('[autoresponder:' + label + '] upsert type=' + (ev?.type || 'undefined') + ' msgs=' + ev.messages.length);

      for (const m of ev.messages) {
        const jid = m?.key?.remoteJid;
        if (!jid) continue;
        if (isFromMe(m)) continue;
        if (isGroup(jid)) continue;
        if (isStatus(jid)) continue;

        // Cooldown
        const now = Date.now();
        const last = lastSent.get(jid) || 0;
        if (now - last < COOLDOWN_MS) {
          console.log('[autoresponder:' + label + '] cooldown ' + jid);
          continue;
        }

        lastSent.set(jid, now);

        const sock = getSock();
        if (!sock) {
          console.warn('[autoresponder:' + label + '] sem socket');
          continue;
        }

        try {
          await sock.sendMessage(jid, { text: MENSAGEM_FIXA });
          console.log('[autoresponder:' + label + '] enviado ' + jid);
        } catch (e) {
          console.error('[autoresponder:' + label + '] erro ' + jid + ': ' + (e?.message || e));
          lastSent.delete(jid);
        }
      }
    } catch (e) {
      console.error('[autoresponder:' + label + '] erro geral: ' + (e?.message || e));
    }
  };
}

// ───────── Wire-up (idempotente por instância) ─────────
function attachAssistant(appInstance) {
  const client = appInstance?.whatsappClient;
  if (!client) {
    console.warn('[autoresponder] client nulo, ignorando');
    return;
  }

  const label = (client.sessionPath || '').split(/[/\]/).pop() || '?';

  // IDEMPOTENTE: se já anexou, só re-wira ao socket atual
  if (client.__ar_attached) {
    console.log('[autoresponder:' + label + '] re-wire (já anexado)');
    if (client.__ar_ensureWired) client.__ar_ensureWired();
    return;
  }
  client.__ar_attached = true;

  console.log('[autoresponder:' + label + '] ATIVADO (cooldown ' + COOLDOWN_MS + 'ms)');

  const getSock = () => client?.sock;

  let currentSockRef = null;
  let handler = null;

  const offSafe = (sock, ev, fn) => {
    try {
      if (typeof sock?.ev?.off === 'function') sock.ev.off(ev, fn);
      else if (typeof sock?.ev?.removeListener === 'function') sock.ev.removeListener(ev, fn);
    } catch (_) {}
  };

  const wireToSock = (sock) => {
    if (!sock?.ev?.on) return false;
    if (currentSockRef === sock && handler) return true;

    if (currentSockRef && handler) {
      offSafe(currentSockRef, 'messages.upsert', handler);
    }

    handler = buildUpsertHandler(getSock, label);
    sock.ev.on('messages.upsert', handler);
    currentSockRef = sock;
    console.log('[autoresponder:' + label + '] WIRED ao socket');
    return true;
  };

  const ensureWired = () => {
    const sock = getSock();
    if (!sock) return;
    if (sock !== currentSockRef) wireToSock(sock);
  };

  client.__ar_ensureWired = ensureWired;

  ensureWired();
  setInterval(() => { try { ensureWired(); } catch (_) {} }, 10000);
}

module.exports = { attachAssistant };
