// src/modules/assistant-bot.js
// Auto-responder simples: responde UMA vez por interação
// com aviso de mudança de número.
// Sem OpenAI, sem intents, sem SQLite, sem redirect-tracker.

const MENSAGEM_FIXA = [
  '📢 Aviso importante!',
  '',
  'Meu número de atendimento mudou!',
  'O novo número é: https://wa.me/5548991784533',
  '',
  'Por favor, salve o novo contato para continuar recebendo',
  'nossas ofertas, cupons e novidades. 😊',
  '',
  'Ainda posso te ajudar por aqui, mas em breve',
  'este número será desativado.',
  '',
  'Mais informações: https://www.muriloconsultor.com.br/',
  '',
  'Bjos',
  'Murilo Cerqueira',
].join('\n');

// Cooldown em ms: não responde ao mesmo JID dentro desse intervalo
// (evita spam se a pessoa mandar 5 msgs rápido)
// Padrão: 60s. Configurável via ENV.
const COOLDOWN_MS = Math.max(10000, Number(process.env.AUTORESPONDER_COOLDOWN_MS || 60000));

// Map: jid -> timestamp do último envio
const lastSent = new Map();

// Limpa entradas antigas a cada 10 min para não crescer
setInterval(() => {
  const now = Date.now();
  for (const [jid, ts] of lastSent) {
    if (now - ts > 3600000) lastSent.delete(jid);
  }
}, 600000);

function isGroup(jid) { return String(jid || '').endsWith('@g.us'); }
function isStatus(jid) { return String(jid || '') === 'status@broadcast'; }
function isFromMe(msg) { return !!msg?.key?.fromMe; }

function buildUpsertHandler(getSock) {
  return async (ev) => {
    try {
      // CRÍTICO: só processa mensagens novas (notify)
      // Ignora append (histórico), que causava o loop infinito
      if (ev?.type !== 'notify') return;
      if (!ev?.messages?.length) return;

      for (const m of ev.messages) {
        const jid = m?.key?.remoteJid;

        // Filtros básicos
        if (!jid) continue;
        if (isFromMe(m)) continue;
        if (isGroup(jid)) continue;
        if (isStatus(jid)) continue;

        // Cooldown: já respondeu recentemente?
        const now = Date.now();
        const last = lastSent.get(jid) || 0;
        if (now - last < COOLDOWN_MS) {
          console.log(`[autoresponder] cooldown ativo para ${jid}, ignorando`);
          continue;
        }

        // Marca ANTES de enviar (previne duplicatas de race condition)
        lastSent.set(jid, now);

        const sock = getSock();
        if (!sock) {
          console.warn('[autoresponder] sem socket disponível');
          continue;
        }

        try {
          await sock.sendMessage(jid, { text: MENSAGEM_FIXA });
          console.log(`[autoresponder] ✅ respondido para ${jid}`);
        } catch (e) {
          console.error(`[autoresponder] erro ao enviar para ${jid}:`, e?.message || e);
          // Remove do cooldown para tentar novamente
          lastSent.delete(jid);
        }
      }
    } catch (e) {
      console.error('[autoresponder] erro geral:', e?.message || e);
    }
  };
}

// ───────── Wire-up ─────────
function attachAssistant(appInstance) {
  // SEMPRE ativo - sem precisar de ASSISTANT_ENABLED ou REDIRECT_ENABLED
  console.log('[autoresponder] ativado - resposta fixa de mudança de número');
  console.log('[autoresponder] cooldown:', COOLDOWN_MS, 'ms');

  const getSock = () =>
    (appInstance?.waAdmin?.getSock && appInstance.waAdmin.getSock()) ||
    (appInstance?.whatsappClient?.sock);

  let currentSocketRef = null;
  let upsertHandler = null;

  const offSafe = (sock, event, handler) => {
    try {
      if (!sock?.ev || !handler) return;
      if (typeof sock.ev.off === 'function') sock.ev.off(event, handler);
      else if (typeof sock.ev.removeListener === 'function') sock.ev.removeListener(event, handler);
    } catch (_) {}
  };

  const wireToSock = (sock) => {
    if (!sock || !sock.ev || typeof sock.ev.on !== 'function') return false;
    if (currentSocketRef === sock && upsertHandler) return true;

    // Remove listener antigo se existir
    if (currentSocketRef && upsertHandler) {
      offSafe(currentSocketRef, 'messages.upsert', upsertHandler);
    }

    upsertHandler = buildUpsertHandler(getSock);
    sock.ev.on('messages.upsert', upsertHandler);
    currentSocketRef = sock;

    const sid =
      (sock?.user && (sock.user.id || sock.user.jid)) ||
      'unknown-sock';
    console.log('[autoresponder] conectado ao socket', sid);
    return true;
  };

  const ensureWired = () => {
    const sock = getSock();
    if (!sock) return false;
    if (sock !== currentSocketRef) return wireToSock(sock);
    return true;
  };

  // Conecta imediatamente e verifica a cada 15s
  ensureWired();
  setInterval(() => { try { ensureWired(); } catch (_) {} }, 15000);
}

module.exports = { attachAssistant };
