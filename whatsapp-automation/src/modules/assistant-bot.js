// src/modules/assistant-bot.js
// Liga entrada (mensagens 1:1) -> coalesce/greet -> assistant/cupom -> reply-queue

const axios = require('axios');
const { pushIncoming, markGreeted } = require('../services/inbox-state');
const { enqueueText } = require('../services/reply-queue');
const { fetchTopCoupons } = require('../services/coupons');

const ASSISTANT_ENABLED = String(process.env.ASSISTANT_ENABLED || '0') === '1';
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL      = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// saudação padrão curta (humanizada)
const GREET_TEXT = process.env.ASSISTANT_GREET_TEXT ||
  'Oi! 👋 Posso te ajudar com cupons, promoções e dúvidas rápidas.';

// pequena “intent” de cupons
function wantsCoupon(text) {
  const s = String(text || '').toLowerCase();
  return /(cupom|cupons|promo|desconto|oferta|promoção)/i.test(s);
}

async function replyCoupons(sock, jid) {
  try {
    const list = await fetchTopCoupons(2);
    if (Array.isArray(list) && list.length) {
      if (list.length === 1) {
        enqueueText(sock, jid, `Tenho um cupom agora: **${list[0]}** 😉`);
      } else {
        enqueueText(sock, jid, `Tenho dois cupons agora: **${list[0]}** ou **${list[1]}** 😉`);
      }
      return true;
    }
  } catch (_) {}
  enqueueText(sock, jid, 'No momento não achei cupons ativos. Posso te avisar quando aparecer?');
  return true;
}

async function askOpenAI(prompt, jid) {
  if (!OPENAI_API_KEY) {
    return 'Estou online! Se quiser, posso buscar cupons ou tirar dúvidas rápidas.';
  }
  // Chat Completions (sem instalar SDK)
  const messages = [
    { role: 'system', content: 'Você é um atendente do WhatsApp. Responda em tom natural, objetivo e educado. Evite textões; se precisar, divida em blocos curtos.' },
    { role: 'user',   content: String(prompt || '') }
  ];
  try {
    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model: OPENAI_MODEL, temperature: 0.5, messages },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    const out = data?.choices?.[0]?.message?.content?.trim();
    return out || 'Certo! 🙂';
  } catch (e) {
    console.error('[assistant] openai error:', e?.response?.data || e?.message || e);
    return 'Estou com um probleminha para consultar agora, mas posso tentar de novo em instantes.';
  }
}

function extractText(msg) {
  try {
    // Baileys: message.conversation | extendedTextMessage.text | etc.
    const m = msg?.message || {};
    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
  } catch (_) {}
  return '';
}

function isGroup(jid) { return String(jid || '').endsWith('@g.us'); }
function isFromMe(msg) { return !!msg?.key?.fromMe; }

function attachAssistant(appInstance) {
  if (!ASSISTANT_ENABLED) {
    console.log('[assistant] disabled (ASSISTANT_ENABLED!=1)');
    return;
  }
  console.log('[assistant] enabled');

  // Tentativa periódica de plugar no socket
  const INTERVAL = 2500;
  let wired = false;

  const tick = async () => {
    try {
      if (wired) return;
      const sock =
        (appInstance?.waAdmin?.getSock && appInstance.waAdmin.getSock()) ||
        (appInstance?.whatsappClient?.sock);

      if (!sock || !sock.ev || typeof sock.ev.on !== 'function') return;

      // listener
      sock.ev.on('messages.upsert', async (ev) => {
        try {
          if (!ev?.messages?.length) return;
          const m = ev.messages[0];
          const jid = m?.key?.remoteJid;
          if (!jid || isFromMe(m) || isGroup(jid)) return; // só 1:1 recebidas

          const text = extractText(m);
          if (!text) return;

          // coalesce por JID
          pushIncoming(jid, text, async (batch, ctx) => {
            const sockNow =
              (appInstance?.waAdmin?.getSock && appInstance.waAdmin.getSock()) ||
              (appInstance?.whatsappClient?.sock);
            if (!sockNow) return;

            // saudação (1x dentro do TTL)
            if (ctx.shouldGreet) {
              enqueueText(sockNow, jid, GREET_TEXT);
              markGreeted(jid);
            }

            // intenção simples: cupom
            const joined = batch.join(' ').trim();
            if (wantsCoupon(joined)) {
              await replyCoupons(sockNow, jid);
              return;
            }

            // fallback: pergunta para OpenAI
            const out = await askOpenAI(joined, jid);
            enqueueText(sockNow, jid, out);
          });
        } catch (e) {
          console.error('[assistant] upsert error', e?.message || e);
        }
      });

      wired = true;
      console.log('[assistant] wired to sock');
    } catch (_) {}
  };

  setInterval(tick, INTERVAL);
}

module.exports = { attachAssistant };
