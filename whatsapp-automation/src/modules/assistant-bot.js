// src/modules/assistant-bot.js
// Liga entrada (mensagens 1:1) -> coalesce/greet ->
// intents (cupons/promos/sorteio/agradecimento/redes/sabonetes/suporte)
// -> OpenAI -> reply-queue

const fs = require('fs');
const axios = require('axios');
const { pushIncoming, markGreeted } = require('../services/inbox-state');
const { enqueueText } = require('../services/reply-queue');
const { fetchTopCoupons } = require('../services/coupons');

const ASSISTANT_ENABLED = String(process.env.ASSISTANT_ENABLED || '0') === '1';
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL      = process.env.OPENAI_MODEL || 'gpt-4o';
const ASSISTANT_TEMP    = Number(process.env.ASSISTANT_TEMPERATURE || 0.6);

// Saudação fixa OPCIONAL (deixe vazia para IA variar)
const GREET_TEXT = (process.env.ASSISTANT_GREET_TEXT || '').trim();

// Links oficiais (sempre com consultoria=clubemac)
const LINKS = {
  promosProgressivo: 'https://www.natura.com.br/c/promocao-da-semana?consultoria=clubemac',
  promosGerais:      'https://www.natura.com.br/c/promocoes?consultoria=clubemac',
  monteSeuKit:       'https://www.natura.com.br/c/monte-seu-kit?consultoria=clubemac',
  sabonetes:         'https://www.natura.com.br/c/corpo-e-banho-sabonete-barra?consultoria=clubemac',
  cuponsSite:        'https://clubemac.com.br/cupons',
  sorteioWhats:      'https://wa.me/5548991021707',
  sorteioInsta:      'https://ig.me/m/murilo_cerqueira_consultoria',
  sorteioMsg:        'http://m.me/murilocerqueiraconsultor',
  grupoResultados:   'https://chat.whatsapp.com/JSBFWPmUdCZ2Ef5saq0kE6',
  insta:             'https://www.instagram.com/murilo_cerqueira_consultoria',
  tiktok:            'https://www.tiktok.com/@murilocerqueiraconsultor',
  whatsMurilo:       'https://wa.me/5548991111707',
  grupoMurilo:       'https://chat.whatsapp.com/E51Xhe0FS0e4Ii54i71NjG'
};

// ====== System instructions (arquivo/ENV; fallback) ======
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
  return 'Você é o atendente virtual do Murilo (Natura). Siga as regras do arquivo assistant-system.txt. Não invente links; use apenas os oficiais com ?consultoria=clubemac.';
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
  return /(^|\b)(obrigad[oa]|obg|valeu|vlw|🙏|❤|❤️)($|\b)/i.test(s);
}
function wantsSocial(text) {
  const s = String(text || '').toLowerCase();
  return /(instagram|insta\b|tiktok|tik[\s-]?tok|whatsapp|zap|grupo)/i.test(s);
}
function wantsSoap(text) {
  const s = String(text || '').toLowerCase();
  return /(sabonete|sabonetes)/i.test(s);
}
function wantsCouponProblem(text) {
  const s = String(text || '').toLowerCase();
  return /(cupom|codigo|código).*(n[aã]o.*(aplic|funcion)|erro)|erro.*(cupom|c[oó]digo)/i.test(s);
}
function wantsOrderSupport(text) {
  const s = String(text || '').toLowerCase();
  return /(pedido|entrega|nota fiscal|pagamento|boleto).*(problema|atras|n[aã]o chegou|erro)/i.test(s);
}

// === Botões de URL (opcional) ===
const USE_BUTTONS = String(process.env.ASSISTANT_USE_BUTTONS || '0') === '1';
async function sendUrlButtons(sock, jid, headerText, buttons, footer = 'Murilo • Natura') {
  try {
    await sock.sendMessage(jid, { text: headerText, footer, templateButtons: buttons });
    return true;
  } catch (e) {
    console.error('[assistant] buttons send error:', e?.message || e);
    return false;
  }
}

// ───────────── Respostas baseadas em regras ─────────────
async function replyCoupons(sock, jid) {
  // 1) tenta pegar cupons dinâmicos
  let list = [];
  try { list = await fetchTopCoupons(2); } catch (_) {}

  // 2) sempre avisar regra do Espaço Natura + link de promoções junto
  const nota = 'Obs.: os cupons só funcionam no meu Espaço Natura — na tela de pagamento, procure por "Murilo Cerqueira".';
  const promoLine = `Promoções do dia: ${LINKS.promosGerais}`;

  if (Array.isArray(list) && list.length) {
    const c1 = list[0], c2 = list[1];
    const linha = c2 ? `Tenho dois cupons agora: *${c1}* ou *${c2}* 😉` : `Tenho um cupom agora: *${c1}* 😉`;

    if (USE_BUTTONS) {
      const ok = await sendUrlButtons(sock, jid, `${linha}\n${nota}`, [
        { index: 1, urlButton: { displayText: 'Ver promoções', url: LINKS.promosGerais } },
        { index: 2, urlButton: { displayText: 'Mais cupons',    url: LINKS.cuponsSite   } },
      ]);
      if (ok) return true;
    }

    enqueueText(sock, jid, `${linha}\n${nota}`);
    enqueueText(sock, jid, `Mais cupons: ${LINKS.cuponsSite}`);
    enqueueText(sock, jid, promoLine);
    return true;
  }

  // 3) sem cupons: NÃO inventa. Manda só o link de cupons + promoções.
  const header = 'No momento não consigo listar um código agora. Veja os cupons atuais aqui:';
  if (USE_BUTTONS) {
    const ok = await sendUrlButtons(sock, jid, `${header}\n${LINKS.cuponsSite}\n${nota}`, [
      { index: 1, urlButton: { displayText: 'Ver cupons',    url: LINKS.cuponsSite   } },
      { index: 2, urlButton: { displayText: 'Ver promoções', url: LINKS.promosGerais } },
    ]);
    if (ok) return true;
  }
  enqueueText(sock, jid, `${header} ${LINKS.cuponsSite}\n${nota}`);
  enqueueText(sock, jid, promoLine);
  return true;
}

async function replyPromos(sock, jid) {
  const header =
    'Ofertas do dia (consultoria ativa):\n' +
    `• Desconto progressivo ➡️ ${LINKS.promosProgressivo}\n` +
    `  Observação: o desconto máximo (pode chegar a 50%) costuma exigir 3 a 4 produtos dentre 328 disponíveis e há frete grátis aplicando cupom.\n` +
    `• Produtos em promoção ➡️ ${LINKS.promosGerais}\n` +
    `  Observação: 723 itens com até 70% OFF e frete grátis aplicando cupom.\n` +
    `• Monte seu kit ➡️ ${LINKS.monteSeuKit}\n` +
    `  Observação: comprando 4 itens (dentre 182), ganha 40% OFF e frete grátis.`;

  if (USE_BUTTONS) {
    const ok = await sendUrlButtons(sock, jid, header, [
      { index: 1, urlButton: { displayText: 'Ver promoções',       url: LINKS.promosGerais      } },
      { index: 2, urlButton: { displayText: 'Desconto progressivo', url: LINKS.promosProgressivo } },
      { index: 3, urlButton: { displayText: 'Monte seu kit',        url: LINKS.monteSeuKit       } },
    ]);
    // regra: sempre mostrar cupons junto
    await replyCoupons(sock, jid);
    if (ok) return;
  }

  enqueueText(sock, jid, header);
  await replyCoupons(sock, jid);
}

function replySoap(sock, jid) {
  enqueueText(sock, jid, `Sabonetes em promoção ➡️ ${LINKS.sabonetes}`);
  return replyCoupons(sock, jid);
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

function replySocial(sock, jid, text) {
  const s = (text || '').toLowerCase();
  if (/instagram|insta\b/.test(s)) return enqueueText(sock, jid, `Instagram ➡️ ${LINKS.insta}`);
  if (/tiktok|tik[\s-]?tok/.test(s)) return enqueueText(sock, jid, `Tiktok ➡️ ${LINKS.tiktok}`);
  if (/grupo/.test(s))               return enqueueText(sock, jid, `Grupo de Whatsapp ➡️ ${LINKS.grupoMurilo}`);
  if (/whatsapp|zap/.test(s))        return enqueueText(sock, jid, `Whatsapp ➡️ ${LINKS.whatsMurilo}`);
  // genérico: manda todos
  enqueueText(sock, jid,
    `Minhas redes:\n` +
    `Instagram ➡️ ${LINKS.insta}\n` +
    `Tiktok ➡️ ${LINKS.tiktok}\n` +
    `Whatsapp ➡️ ${LINKS.whatsMurilo}\n` +
    `Grupo de Whatsapp ➡️ ${LINKS.grupoMurilo}`
  );
}

function replyCouponProblem(sock, jid) {
  enqueueText(
    sock,
    jid,
    `O cupom só funciona no meu Espaço Natura. Na tela de pagamento, procure por *Murilo Cerqueira* ou, em "Minha Conta", escolha seu consultor.\n` +
    `Tente outro cupom e veja mais em: ${LINKS.cuponsSite}\n` +
    `Se puder, feche e abra o app/navegador ou troque entre app e navegador.\n` +
    `Acesse promoções com a consultoria correta: ${LINKS.promosGerais}`
  );
}

function replyOrderSupport(sock, jid) {
  enqueueText(
    sock,
    jid,
    `Pagamentos, nota fiscal, pedido e entrega são tratados pelo suporte oficial da Natura:\n` +
    `https://www.natura.com.br/ajuda-e-contato\n` +
    `Dica: no chat, digite 4x “Falar com atendente” para acelerar o atendimento humano.\n` +
    `Visualizar seus pedidos: https://www.natura.com.br/meus-dados/pedidos?consultoria=clubemac`
  );
}

// ───────────── OpenAI (fallback) ─────────────
async function askOpenAI({ prompt, userName, isNewTopic }) {
  const fallback = 'Estou online! Se quiser, posso buscar promoções, cupons ou tirar dúvidas rápidas. 🙂';
  if (!OPENAI_API_KEY) return fallback;

  const rules = [
    SYSTEM_TEXT,
    '',
    'Regras de execução:',
    `- Nome do cliente: ${userName || '(desconhecido)'}`,
    `- isNewTopic=${isNewTopic ? 'true' : 'false'} (se true, pode se apresentar; se false, evite nova saudação)`,
    '- Use SOMENTE os links listados nas seções 3/4/5/6/8, sempre com ?consultoria=clubemac. Se não houver link específico, não forneça link.',
    '- Nunca formate link como markdown/âncora. Exiba o texto exato do link.'
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
  if (!ASSISTANT_ENABLED) { console.log('[assistant] disabled (ASSISTANT_ENABLED!=1)'); return; }
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
          if (!jid || isFromMe(m) || isGroup(jid) || isStatus(jid)) return;

          const text = extractText(m);
          if (!text) return;

          const userName = (m.pushName || '').trim();

          pushIncoming(jid, text, async (batch, ctx) => {
            const sockNow = getSock();
            if (!sockNow) return;

            const joined = batch.join(' ').trim();

            // Intents rápidas
            if (wantsThanks(joined))        { replyThanks(sockNow, jid); return; }
            if (wantsCouponProblem(joined)) { replyCouponProblem(sockNow, jid); return; }
            if (wantsOrderSupport(joined))  { replyOrderSupport(sockNow, jid); return; }
            if (wantsRaffle(joined))        { replyRaffle(sockNow, jid); return; }
            if (wantsCoupon(joined))        { await replyCoupons(sockNow, jid); return; }
            if (wantsPromos(joined))        { await replyPromos(sockNow, jid); return; }
            if (wantsSocial(joined))        { replySocial(sockNow, jid, joined); return; }
            if (wantsSoap(joined))          { await replySoap(sockNow, jid); return; }

            // Saudação (opcional)
            let isNewTopicForAI = ctx.shouldGreet;
            if (ctx.shouldGreet && GREET_TEXT) {
              // envia saudação fixa apenas se configurada
              markGreeted(jid); // marca antes para evitar repetição
              enqueueText(sockNow, jid, GREET_TEXT);
              isNewTopicForAI = false; // IA não precisa saudar de novo
            }

            // Fallback IA
            const out = await askOpenAI({ prompt: joined, userName, isNewTopic: isNewTopicForAI });
            if (out && out.trim()) {
              enqueueText(sockNow, jid, out.trim());
              if (ctx.shouldGreet && !GREET_TEXT) markGreeted(jid); // se só IA saudou, ainda assim marcar
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
