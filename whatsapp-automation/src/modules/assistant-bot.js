// src/modules/assistant-bot.js
// Liga entrada (mensagens 1:1) -> coalesce/greet -> intents (cupons/promos/sorteio/agradecimento) -> OpenAI -> reply-queue

const fs = require('fs');
const axios = require('axios');
const { pushIncoming, markGreeted } = require('../services/inbox-state');
const { enqueueText } = require('../services/reply-queue');
const { fetchTopCoupons } = require('../services/coupons');

const ASSISTANT_ENABLED   = String(process.env.ASSISTANT_ENABLED || '0') === '1';
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL        = process.env.OPENAI_MODEL || 'gpt-4o';
const ASSISTANT_TEMP      = Number(process.env.ASSISTANT_TEMPERATURE || 0.6);

// Saudação fixa OPCIONAL: deixe vazia para a IA variar naturalmente e evitar dupla saudação
const GREET_TEXT = (process.env.ASSISTANT_GREET_TEXT || '').trim();

// Links oficiais (sempre com consultoria=clubemac)
const LINKS = {
  promosProgressivo: 'https://www.natura.com.br/c/promocao-da-semana?consultoria=clubemac',
  promosGerais:      'https://www.natura.com.br/c/promocoes?consultoria=clubemac',
  monteSeuKit:       'https://www.natura.com.br/c/monte-seu-kit?consultoria=clubemac',
  cuponsSite:        'https://clubemac.com.br/cupons',
  sorteioWhats:      'https://wa.me/5548991021707',
  sorteioInsta:      'https://ig.me/m/murilo_cerqueira_consultoria',
  sorteioMsg:        'http://m.me/murilocerqueiraconsultor',
  grupoResultados:   'https://chat.whatsapp.com/JSBFWPmUdCZ2Ef5saq0kE6',
};

// ====== System instructions (preferir arquivo/ENV; fallback mantém suas regras) ======
function loadSystemText() {
  try {
    const file = (process.env.ASSISTANT_SYSTEM_FILE || '').trim();
    if (file) {
      const txt = fs.readFileSync(file, 'utf8');
      if (txt && txt.trim()) return txt.trim();
    }
  } catch (_) {}
  const envTxt = (process.env.ASSISTANT_SYSTEM || '').trim();
  if (envTxt) return envTxt;

  // Fallback minimalista (mantém regras essenciais)
  return `
Você é Murilo, consultor on-line da Natura. Use tom humano, objetivo e até 3 emojis. Use somente links em texto puro com "?consultoria=clubemac". 
Quando o cliente pedir promoções, envie: 
• ${LINKS.promosProgressivo}
• ${LINKS.promosGerais}
• ${LINKS.monteSeuKit}
Cupons: use os retornados pelo sistema; se não houver, encaminhe para ${LINKS.cuponsSite} e NÃO invente códigos. 
Diga que os cupons valem apenas no Espaço Natura do Murilo (selecionar "Murilo Cerqueira" no pagamento).
`.trim();
}
const SYSTEM_TEXT = loadSystemText();

// ───────────── Intents ─────────────
function wantsCoupon(text) {
  const s = String(text || '').toLowerCase();
  return /\bcupom\b|\bcupons\b/.test(s);
}
function wantsPromos(text) {
  const s = String(text || '').toLowerCase();
  return /(promo(ç|c)[aã]o|promo\b|oferta|desconto|liquid(a|ã)o|sale)/i.test(s);
}
function wantsRaffle(text) {
  const s = String(text || '').toLowerCase();
  return /(sorteio|participar.*sorteio|quero.*sorteio|ganhar.*sorteio|\benviar\b.*\b7\b|\bmandar\b.*\b7\b)/i.test(s);
}
function wantsThanks(text) {
  const s = String(text || '').toLowerCase().trim();
  return /(^|\b)(obrigad[oa]|obg|valeu|vlw|thanks|thank you|🙏|❤|❤️|💖|💗|💜|💙|💚|💛|💞|💝)($|\b)/i.test(s);
}

// === Botões de URL (Baileys "templateButtons") ===
const USE_BUTTONS = String(process.env.ASSISTANT_USE_BUTTONS || '1') === '1';

async function sendUrlButtons(sock, jid, headerText, buttons, footer = 'Murilo • Natura') {
  try {
    await sock.sendMessage(jid, {
      text: headerText,
      footer,
      templateButtons: buttons
    });
    return true;
  } catch (e) {
    console.error('[assistant] buttons send error:', e?.message || e);
    return false;
  }
}

// ───────────── Respostas baseadas em regras ─────────────
async function replyCoupons(sock, jid) {
  // tenta pegar até 2 cupons dinâmicos
  let coupons = [];
  try {
    const list = await fetchTopCoupons(2);
    if (Array.isArray(list)) coupons = list.filter(Boolean).slice(0, 2);
  } catch (_) {}

  if (coupons.length >= 2) {
    const txt =
      `Tenho dois cupons agora: *${coupons[0]}* ou *${coupons[1]}* 😉\n` +
      `Obs.: os cupons só funcionam no meu Espaço Natura — na tela de pagamento, procure por "Murilo Cerqueira".`;
    if (USE_BUTTONS) {
      const ok = await sendUrlButtons(sock, jid, txt, [
        { index: 1, urlButton: { displayText: 'Ver promoções', url: LINKS.promosGerais } },
        { index: 2, urlButton: { displayText: 'Mais cupons',    url: LINKS.cuponsSite   } },
      ]);
      if (ok) return true;
    }
    enqueueText(sock, jid, txt);
    enqueueText(sock, jid, `Mais cupons: ${LINKS.cuponsSite}`);
    enqueueText(sock, jid, `Promoções do dia: ${LINKS.promosGerais}`);
    return true;
  }

  if (coupons.length === 1) {
    const txt =
      `Tenho um cupom agora: *${coupons[0]}* 😉\n` +
      `Se quiser conferir outros, veja: ${LINKS.cuponsSite}\n` +
      `Obs.: os cupons só funcionam no meu Espaço Natura — na tela de pagamento, procure por "Murilo Cerqueira".`;
    if (USE_BUTTONS) {
      const ok = await sendUrlButtons(sock, jid, txt, [
        { index: 1, urlButton: { displayText: 'Ver promoções', url: LINKS.promosGerais } },
        { index: 2, urlButton: { displayText: 'Mais cupons',    url: LINKS.cuponsSite   } },
      ]);
      if (ok) return true;
    }
    enqueueText(sock, jid, txt);
    return true;
  }

  // FALLBACK quando não houver cupom dinâmico → NÃO inventa; manda link
  const noCupomTxt =
    `Agora não consegui confirmar cupons ativos. Veja os disponíveis aqui: ${LINKS.cuponsSite} 👈\n` +
    `Obs.: os cupons só funcionam no meu Espaço Natura — na tela de pagamento, procure por "Murilo Cerqueira".`;
  if (USE_BUTTONS) {
    const ok = await sendUrlButtons(sock, jid, noCupomTxt, [
      { index: 1, urlButton: { displayText: 'Mais cupons',    url: LINKS.cuponsSite   } },
      { index: 2, urlButton: { displayText: 'Ver promoções',  url: LINKS.promosGerais } },
    ]);
    if (ok) return true;
  }
  enqueueText(sock, jid, noCupomTxt);
  enqueueText(sock, jid, `Promoções do dia: ${LINKS.promosGerais}`);
  return true;
}

async function replyPromos(sock, jid) {
  const header =
    'Ofertas do dia (consultoria ativa):\n' +
    `• Desconto progressivo ➡️ ${LINKS.promosProgressivo}\n` +
    `• Produtos em promoção ➡️ ${LINKS.promosGerais}\n` +
    `• Monte seu kit ➡️ ${LINKS.monteSeuKit}`;

  if (USE_BUTTONS) {
    const ok = await sendUrlButtons(sock, jid, header, [
      { index: 1, urlButton: { displayText: 'Ver promoções',       url: LINKS.promosGerais      } },
      { index: 2, urlButton: { displayText: 'Desconto progressivo', url: LINKS.promosProgressivo } },
      { index: 3, urlButton: { displayText: 'Monte seu kit',        url: LINKS.monteSeuKit       } },
    ]);
    // regra: SEMPRE mostrar cupons junto das promoções
    await replyCoupons(sock, jid);
    if (ok) return;
  }

  // Fallback texto + cupons
  enqueueText(sock, jid, header);
  await replyCoupons(sock, jid);
}

function replyRaffle(sock, jid) {
  enqueueText(
    sock,
    jid,
    `Para participar do sorteio, envie **7** (apenas o número) em UMA ou MAIS redes:\n` +
      `• WhatsApp: ${LINKS.sorteioWhats}\n` +
      `• Instagram: ${LINKS.sorteioInsta}\n` +
      `• Messenger: ${LINKS.sorteioMsg}\n\n` +
      `Cada rede vale *1 chance extra*. Resultados são divulgados no grupo: ${LINKS.grupoResultados} 🎉`
  );
}

function replyThanks(sock, jid) {
  enqueueText(sock, jid, 'Por nada! ❤️ Conte comigo sempre!');
}

// ───────────── OpenAI (fallback) ─────────────
async function askOpenAI({ prompt, userName, isNewTopic }) {
  const fallback = 'Estou online! Se quiser, posso buscar promoções, cupons ou tirar dúvidas rápidas. 🙂';
  if (!OPENAI_API_KEY) return fallback;

  const rules = [
    SYSTEM_TEXT,
    '',
    'Regras adicionais de execução:',
    `- Nome do cliente: ${userName || '(desconhecido)'}`,
    `- isNewTopic=${isNewTopic ? 'true' : 'false'} → se true, pode se apresentar; se false, evite nova saudação.`,
    '- Nunca formate link como markdown/âncora. Exiba o texto exato do link.',
    '- Quando o cliente pedir “só cupons”, inclua também o link geral de promoções.'
  ].join('\n');

  const messages = [
    { role: 'system', content: rules },
    { role: 'user',   content: String(prompt || '').trim() }
  ];

  try {
    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model: OPENAI_MODEL, temperature: ASSISTANT_TEMP, messages },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 25000 }
    );
    const out = data?.choices?.[0]?.message?.content?.trim();
    return out || fallback;
  } catch (e) {
    console.error('[assistant] openai error:', e?.response?.data || e?.message || e);
    return 'Desculpe, algo deu errado 😅. Pode tentar novamente em instantes?';
  }
}

// ───────────── Utilitários de extração ─────────────
function extractText(msg) {
  try {
    // Desembrulha ephemeralMessage, quando existir
    const m0 = msg?.message || {};
    const m = m0.ephemeralMessage?.message || m0;

    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
    if (m.documentMessage?.caption) return m.documentMessage.caption;
  } catch (_) {}
  return '';
}

function isGroup(jid)  { return String(jid || '').endsWith('@g.us'); }
function isStatus(jid) { return String(jid || '') === 'status@broadcast'; }
function isFromMe(msg) { return !!msg?.key?.fromMe; }

// ───────────── Wire-up ─────────────
function attachAssistant(appInstance) {
  if (!ASSISTANT_ENABLED) {
    console.log('[assistant] disabled (ASSISTANT_ENABLED!=1)');
    return;
  }
  console.log('[assistant] enabled');

  const INTERVAL = 2500;
  let wired = false;

  const getSock = () =>
    (appInstance?.waAdmin?.getSock && appInstance.waAdmin.getSock()) ||
    (appInstance?.whatsappClient?.sock);

  const tick = async () => {
    try {
      if (wired) return;
      const sock = getSock();
      if (!sock || !sock.ev || typeof sock.ev.on !== 'function') return;

      sock.ev.on('messages.upsert', async (ev) => {
        try {
          if (!ev?.messages?.length) return;
          const m = ev.messages[0];
          const jid = m?.key?.remoteJid;
          if (!jid || isFromMe(m) || isGroup(jid) || isStatus(jid)) return; // só 1:1 recebidas

          const text = extractText(m);
          if (!text) return;

          const userName = (m.pushName || '').trim();

          // Coalesce por JID
          pushIncoming(jid, text, async (batch, ctx) => {
            const sockNow = getSock();
            if (!sockNow) return;

            const joined = batch.join(' ').trim();

            // Agradecimento curto não puxa conversa
            if (wantsThanks(joined)) { replyThanks(sockNow, jid); return; }

            // Intents rápidas (não acionam IA)
            if (wantsRaffle(joined)) { replyRaffle(sockNow, jid); return; }
            if (wantsCoupon(joined)) { await replyCoupons(sockNow, jid); return; }
            if (wantsPromos(joined)) { await replyPromos(sockNow, jid); return; }

            // Saudação: só 1x. Se GREET_TEXT existir e for novo tópico, manda fixa e
            // sinaliza para a IA NÃO saudar de novo (isNewTopic=false).
            let isNewTopicForAI = ctx.shouldGreet;
            if (ctx.shouldGreet && GREET_TEXT) {
              enqueueText(sockNow, jid, GREET_TEXT);
              markGreeted(jid);
              isNewTopicForAI = false;
            }

            // Fallback IA (segue suas regras; se isNewTopicForAI=true, pode se apresentar)
            const out = await askOpenAI({
              prompt: joined,
              userName,
              isNewTopic: isNewTopicForAI
            });
            if (out && out.trim()) {
              enqueueText(sockNow, jid, out.trim());
              if (ctx.shouldGreet && !GREET_TEXT) markGreeted(jid);
            }
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
