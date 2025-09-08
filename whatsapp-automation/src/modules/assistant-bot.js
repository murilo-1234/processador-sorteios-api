// src/modules/assistant-bot.js
// Liga entrada (mensagens 1:1) -> coalesce/greet -> intents (cupons/promos/sorteio) -> OpenAI -> reply-queue

const axios = require('axios');
const { pushIncoming, markGreeted } = require('../services/inbox-state');
const { enqueueText } = require('../services/reply-queue');
const { fetchTopCoupons } = require('../services/coupons');

const ASSISTANT_ENABLED = String(process.env.ASSISTANT_ENABLED || '0') === '1';
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL      = process.env.OPENAI_MODEL || 'gpt-4o';

// Saudação curta e humana (pode personalizar via ENV)
const GREET_TEXT = process.env.ASSISTANT_GREET_TEXT ||
  'Oi! 👋 Sou o Murilo Cerqueira, consultor de beleza Natura (atendimento virtual). Como posso te ajudar hoje? 😊';

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

// Prompt de sistema (resumo fiel das suas regras)
const SYSTEM_RULES = `
Você é Murilo, consultor on-line da Natura (atendimento virtual). Regras obrigatórias:
- Tom leve, humano, claro e objetivo; no máximo 3 emojis por resposta.
- Apresente-se no primeiro contato do assunto: "Sou o Murilo Cerqueira, consultor de beleza Natura".
- Foque em produtos Natura e vendas; se desviar, traga gentilmente de volta.
- NUNCA invente, encurte, formate ou altere links. Não use colchetes/âncoras/markdown em links e não diga "clique aqui".
- Use APENAS estes links (texto puro) com "?consultoria=clubemac":

Promoções:
1) Desconto progressivo ➡️ ${LINKS.promosProgressivo}
2) Produtos em promoção ➡️ ${LINKS.promosGerais}
3) Monte seu kit ➡️ ${LINKS.monteSeuKit}

Cupons:
- Diga PEGAP e PEGAQ por padrão e também: ${LINKS.cuponsSite}
- Explique que só funcionam no Espaço Natura e deve procurar "Murilo Cerqueira" na tela de pagamento.

Sorteios:
- Para participar, enviar "7" (só o número) em:
  • WhatsApp: ${LINKS.sorteioWhats}
  • Instagram: ${LINKS.sorteioInsta}
  • Messenger: ${LINKS.sorteioMsg}
- Cada rede = 1 chance extra; resultados no grupo: ${LINKS.grupoResultados}

Erros: responda curto e humano ("Desculpe, algo deu errado 😅. Pode tentar novamente?").
Evite textões; se necessário, quebre em blocos curtos. Nunca repita a pergunta do cliente sem agregar algo novo.
`;

// ───────────── Intents ─────────────
// Cupom: apenas quando a pessoa fala explicitamente cupom/cupons
function wantsCoupon(text) {
  const s = String(text || '').toLowerCase();
  return /\bcupom\b|\bcupons\b/.test(s);
}
// Promoções / ofertas / descontos
function wantsPromos(text) {
  const s = String(text || '').toLowerCase();
  return /(promo(ç|c)[aã]o|promo\b|oferta|desconto|liquid(a|ã)o|sale)/i.test(s);
}
// Sorteio / participar / enviar "7"
function wantsRaffle(text) {
  const s = String(text || '').toLowerCase();
  return /(sorteio|participar.*sorteio|quero.*sorteio|ganhar.*sorteio|\benviar\b.*\b7\b|\bmandar\b.*\b7\b)/i.test(s);
}

// ───────────── Respostas baseadas em regras ─────────────
async function replyCoupons(sock, jid) {
  try {
    const list = await fetchTopCoupons(2); // tenta pegar do site
    let c1 = 'PEGAP', c2 = 'PEGAQ';
    if (Array.isArray(list) && list.length) {
      c1 = list[0] || c1;
      c2 = list[1] || c2;
    }
    enqueueText(sock, jid, `Tenho dois cupons agora: *${c1}* ou *${c2}* 😉`);
    enqueueText(sock, jid, `Se precisar de mais, veja: ${LINKS.cuponsSite}\nObs.: os cupons funcionam no meu Espaço Natura. Na tela de pagamento, procure por "Murilo Cerqueira".`);
    return true;
  } catch (_) {
    enqueueText(sock, jid, `Tenta *PEGAP* ou *PEGAQ* 😉\nMais cupons: ${LINKS.cuponsSite}`);
    return true;
  }
}

async function replyPromos(sock, jid) {
  enqueueText(
    sock,
    jid,
    `Ofertas do dia (consultoria ativa):\n` +
      `• Desconto progressivo ➡️ ${LINKS.promosProgressivo}\n` +
      `• Produtos em promoção ➡️ ${LINKS.promosGerais}\n` +
      `• Monte seu kit ➡️ ${LINKS.monteSeuKit}`
  );
  // Regra: ao falar de promoções, sempre mostrar cupons também
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

// ───────────── OpenAI (fallback) ─────────────
async function askOpenAI(prompt) {
  const fallback = 'Estou online! Se quiser, posso buscar promoções, cupons ou tirar dúvidas rápidas. 🙂';
  if (!OPENAI_API_KEY) return fallback;

  const messages = [
    { role: 'system', content: SYSTEM_RULES.trim() },
    { role: 'user',   content: String(prompt || '').trim() }
  ];
  try {
    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model: OPENAI_MODEL, temperature: 0.4, messages },
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

    // Baileys: message.conversation | extendedTextMessage.text | etc.
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

          // Coalesce por JID (decidimos pelo último texto do lote)
          pushIncoming(jid, text, async (batch, ctx) => {
            const sockNow = getSock();
            if (!sockNow) return;

            const last = (batch[batch.length - 1] || '').trim();

            // Saudação (1x dentro do TTL do inbox-state)
            if (ctx.shouldGreet) {
              enqueueText(sockNow, jid, GREET_TEXT);
              markGreeted(jid);
            }

            // Intents em ordem (sorteio -> cupom -> promo -> fallback)
            if (wantsRaffle(last)) { replyRaffle(sockNow, jid); return; }
            if (wantsCoupon(last)) { await replyCoupons(sockNow, jid); return; }
            if (wantsPromos(last)) { await replyPromos(sockNow, jid); return; }

            // Fallback: OpenAI com regras completas
            const out = await askOpenAI(last);
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
