// src/modules/assistant-bot.js
// Auto-responder simples para multi-instância (bots/index.js)
// Responde UMA vez por interação com aviso de mudança de número.
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

// Map global: jid -> timestamp do último envio (compartilhado entre instâncias)
// Se pessoa manda msg pro bot1, NÃO recebe de novo do bot2 dentro do cooldown.
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
      // CRÍTICO: só processa mensagens novas (notify)
      // Ignora append (histórico) — era a causa do loop infinito
      if (ev?.type !== 'notify') return;
      if (!ev?.messages?.length) return;

      for (const m of ev.messages) {
        const jid = m?.key?.remoteJid;
        if (!jid) continue;
        if (isFromMe(m)) continue;
        if (isGroup(jid)) continue;
        if (isStatus(jid)) continue;

        // Cooldown: já respondeu recentemente?
        const now = Date.now();
        const last = lastSent.get(jid) || 0;
        if (now - last < COOLDOWN_MS) continue;

        // Marca ANTES de enviar (previne race condition)
        lastSent.set(jid, now);

        const sock = getSock();
        if (!sock) {
          console.warn(`[autoresponder:${label}] sem socket`);
          continue;
        }

        try {
          await sock.sendMessage(jid, { text: MENSAGEM_FIXA });
          console.log(`[autoresponder:${label}] ✅ ${jid}`);
        } catch (e) {
          console.error(`[autoresponder:${label}] erro ${jid}:`, e?.message || e);
          lastSent.delete(jid); // remove cooldown para tentar de novo
        }
      }
    } catch (e) {
      console.error(`[autoresponder:${label}] erro geral:`, e?.message || e);
    }
  };
}

// ───────── Wire-up (idempotente por instância) ─────────
function attachAssistant(appInstance) {
  const client = appInstance?.whatsappClient;
  if (!client) return;

  // IDEMPOTENTE: se já anexou a este client, só re-wira ao socket atual
  if (client.__ar_attached) {
    if (client.__ar_ensureWired) client.__ar_ensureWired();
    return;
  }
  client.__ar_attached = true;

  const label = client.sessionPath?.split(/[/\]/).pop() || '?';
  console.log(`[autoresponder:${label}] ativado (cooldown ${COOLDOWN_MS}ms)`);

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

    // Remove listener do socket anterior
    if (currentSockRef && handler) {
      offSafe(currentSockRef, 'messages.upsert', handler);
    }

    handler = buildUpsertHandler(getSock, label);
    sock.ev.on('messages.upsert', handler);
    currentSockRef = sock;
    console.log(`[autoresponder:${label}] wired`);
    return true;
  };

  const ensureWired = () => {
    const sock = getSock();
    if (!sock) return;
    if (sock !== currentSockRef) wireToSock(sock);
  };

  // Salva referência para chamadas subsequentes
  client.__ar_ensureWired = ensureWired;

  // Conecta agora e verifica a cada 10s
  ensureWired();
  setInterval(() => { try { ensureWired(); } catch (_) {} }, 10000);
}

module.exports = { attachAssistant };
