// src/modules/assistant-bot.js
// Liga entrada (mensagens 1:1) -> coalesce/greet ->
// intents (cupons/promos/sorteio/agradecimento/redes/sabonetes/suporte/segurança/marcas)
// -> OpenAI -> reply-queue
//
// Compat: mantém a mesma API (attachAssistant).
// Novidade: rewire automático por referência de socket + watchdog.
// Flags:
//   - ASSISTANT_REWIRE_MODE = "auto" (padrão) | "legacy"
//   - ASSISTANT_REWIRE_INTERVAL_MS = intervalo do watchdog em ms (padrão 15000)

const fs = require('fs');
const axios = require('axios');
const { pushIncoming, markGreeted } = require('../services/inbox-state');
const { enqueueText } = require('../services/reply-queue');
const { fetchTopCoupons } = require('../services/coupons');

// ⚠️ utilitários já existentes no seu repo
const { detectIntent } = require('../services/intent-registry');
const { securityReply } = require('../services/security');

// ⚠️ utilitários novos (opt-in, sem quebrar nada se ausentes)
let transcribeAudioIfAny = null;
try {
  ({ transcribeAudioIfAny } = require('../services/audio-transcriber'));
} catch (_) {
  // módulo pode não existir ainda — tudo continua funcionando sem áudio
}
let nameUtils = null;
try {
  nameUtils = require('../services/name-utils');
} catch (_) {
  // módulo pode não existir ainda — seguimos com o comportamento atual
}
let heuristics = null;
try {
  heuristics = require('../services/heuristics');
} catch (_) {
  // módulo opcional (heurísticas pós-processamento)
}
let linkUtils = null;
try {
  linkUtils = require('../services/link-utils');
} catch (_) {
  // sanitização de links é opcional; se ausente, segue normal
}

const ASSISTANT_ENABLED = String(process.env.ASSISTANT_ENABLED || '0') === '1';
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL      = process.env.OPENAI_MODEL || 'gpt-4o';
const ASSISTANT_TEMP    = Number(process.env.ASSISTANT_TEMPERATURE || 0.6);

// Saudação fixa OPCIONAL (deixe vazia para IA variar)
const GREET_TEXT = (process.env.ASSISTANT_GREET_TEXT || '').trim();

// Saudação por regra (determinística) — NOVO (opt-in)
const RULE_GREETING_ON = String(process.env.ASSISTANT_RULE_GREETING || '0') === '1';

// Rewire/Watchdog
const REWIRE_MODE = String(process.env.ASSISTANT_REWIRE_MODE || 'auto').toLowerCase();
const REWIRE_INTERVAL_MS = Math.max(5000, Number(process.env.ASSISTANT_REWIRE_INTERVAL_MS || 15000) | 0);

// Links oficiais (sempre com consultoria=clubemac)
const LINKS = {
  promosProgressivo: 'https://www.natura.com.br/c/promocao-da-semana?consultoria=clubemac',
  promosGerais:      'https://www.natura.com.br/c/promocoes?consultoria=clubemac',
  monteSeuKit:       'https://www.natura.com.br/c/monte-seu-kit?consultoria=clubemac',
  sabonetes:         'https://www.natura.com.br/c/corpo-e-banho-sabonete-barra?consultoria=clubemac',
  // 🔧 corrigido: link público de "Mais cupons"
  cuponsSite:        'https://bit.ly/cupons-murilo',
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
  return 'Você é o atendente virtual do Murilo Cerqueira (Natura). Siga as regras do arquivo assistant-system.txt. Não invente links; use apenas os oficiais com ?consultoria=clubemac.';
}
const SYSTEM_TEXT = loadSystemText();

// ───────────── helpers de envio seguro ─────────────
function sendSafe(sock, jid, text) {
  let msg = String(text || '');
  try {
    if (linkUtils && typeof linkUtils.normalizeNaturaUrl === 'function') {
      msg = linkUtils.normalizeNaturaUrl(msg);
    }
    if (linkUtils && typeof linkUtils.sanitizeOutgoing === 'function') {
      msg = linkUtils.sanitizeOutgoing(msg);
    }
  } catch (_) {}
  enqueueText(sock, jid, msg);
}

// ───────────── Intents antigas (mantidas para compat) ─────────────
function wantsCoupon(text) {
  const s = String(text || '').toLowerCase();
  // cobre typos comuns
  return /\b(cupom|cupon|cupum|cupao|coupon|kupon)s?\b/.test(s);
}
function wantsPromos(text) {
  const s = String(text || '').toLowerCase();
  return /(promo(ç|c)[aã]o|promos?\b|oferta|desconto|liquid(a|ã)c?[aã]o|sale)/i.test(s);
}
function wantsRaffle(text) {
  const s = String(text || '').toLowerCase().trim();
  // tolera "7", "7!", "7.", " sete ", "quero participar do sorteio"
  if (/^7[!,.…]*$/.test(s)) return true;
  if (/\bsete\b/.test(s)) return true;
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
  // amplia cobertura sem exigir a palavra "pedido"
  return /(pedido|compra|encomenda|pacote|entrega|nota fiscal|pagamento|boleto).*(problema|atras|n[aã]o chegou|nao recebi|erro|sumiu|cad[eê])|rastre(i|ei)o|codigo de rastreio|transportadora/.test(s);
}

// Heurística leve para saber se a conversa é sobre PRODUTO/CATEGORIA (para anexar promo+cupons no fallback IA)
function wantsProductTopic(text) {
  const s = String(text || '').toLowerCase();
  return /(perfume|perfumaria|hidratante|hidratantes|desodorante|maquiagem|batom|base|rosto|s[ée]rum|sabonete|cabelos?|shampoo|condicionador|mascara|cronograma|barba|infantil|presente|kit|aura|ekos|kaiak|essencial|luna|tododia|mam[aã]e e beb[êe]|una|faces|chronos|lumina|biome|bothanica)/i.test(s);
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
  let list = [];
  try { list = await fetchTopCoupons(2); } catch (_) {}

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
    sendSafe(sock, jid, `${linha}\n${nota}`);
    sendSafe(sock, jid, `Mais cupons: ${LINKS.cuponsSite}`);
    sendSafe(sock, jid, promoLine);
    return true;
  }

  const header = 'No momento não consigo listar um código agora. Veja os cupons atuais aqui:';
  if (USE_BUTTONS) {
    const ok = await sendUrlButtons(sock, jid, `${header}\n${LINKS.cuponsSite}\n${nota}`, [
      { index: 1, urlButton: { displayText: 'Ver cupons',    url: LINKS.cuponsSite   } },
      { index: 2, urlButton: { displayText: 'Ver promoções', url: LINKS.promosGerais } },
    ]);
    if (ok) return true;
  }
  sendSafe(sock, jid, `${header} ${LINKS.cuponsSite}\n${nota}`);
  sendSafe(sock, jid, promoLine);
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
      { index: 1, urlButton: { displayText: 'Ver promoções',        url: LINKS.promosGerais      } },
      { index: 2, urlButton: { displayText: 'Desconto progressivo', url: LINKS.promosProgressivo } },
      { index: 3, urlButton: { displayText: 'Monte seu kit',        url: LINKS.monteSeuKit       } },
    ]);
    await replyCoupons(sock, jid);
    if (ok) return;
  }
  sendSafe(sock, jid, header);
  await replyCoupons(sock, jid);
}

function replySoap(sock, jid) {
  sendSafe(sock, jid, `Sabonetes em promoção ➡️ ${LINKS.sabonetes}`);
  return replyCoupons(sock, jid);
}

function replyRaffle(sock, jid) {
  sendSafe(
    sock,
    jid,
    `Para participar do sorteio, envie **7** (apenas o número) em UMA ou MAIS redes:\n` +
      `• WhatsApp: ${LINKS.sorteioWhats}\n` +
      `• Instagram: ${LINKS.sorteioInsta}\n` +
      `• Messenger: ${LINKS.sorteioMsg}\n\n` +
      `Cada rede vale *1 chance extra*. Resultados são divulgados no grupo: ${LINKS.grupoResultados} 🎉`
  );
}

function replyThanks(sock, jid) { sendSafe(sock, jid, 'Por nada! ❤️ Conte comigo sempre!'); }

function replySocial(sock, jid, text) {
  const s = (text || '').toLowerCase();
  if (/instagram|insta\b/.test(s)) return sendSafe(sock, jid, `Instagram ➡️ ${LINKS.insta}`);
  if (/tiktok|tik[\s-]?tok/.test(s)) return sendSafe(sock, jid, `Tiktok ➡️ ${LINKS.tiktok}`);
  if (/grupo/.test(s))               return sendSafe(sock, jid, `Grupo de Whatsapp ➡️ ${LINKS.grupoMurilo}`);
  if (/whatsapp|zap/.test(s))        return sendSafe(sock, jid, `Whatsapp ➡️ ${LINKS.whatsMurilo}`);
  sendSafe(sock, jid,
    `Minhas redes:\n` +
    `Instagram ➡️ ${LINKS.insta}\n` +
    `Tiktok ➡️ ${LINKS.tiktok}\n` +
    `Whatsapp ➡️ ${LINKS.whatsMurilo}\n` +
    `Grupo de Whatsapp ➡️ ${LINKS.grupoMurilo}`
  );
}

function replyCouponProblem(sock, jid) {
  sendSafe(
    sock,
    jid,
    `O cupom só funciona no meu Espaço Natura. Na tela de pagamento, procure por *Murilo Cerqueira* ou, em "Minha Conta", escolha seu consultor.\n` +
    `Tente outro cupom e veja mais em: ${LINKS.cuponsSite}\n` +
    `Se puder, feche e abra o app/navegador ou troque entre app e navegador.\n` +
    `Acesse promoções com a consultoria correta: ${LINKS.promosGerais}`
  );
}

function replyOrderSupport(sock, jid) {
  sendSafe(
    sock,
    jid,
    `Pagamentos, nota fiscal, pedido e entrega são tratados pelo suporte oficial da Natura:\n` +
    `https://www.natura.com.br/ajuda-e-contato\n` +
    `Dica: no chat, digite 4x “Falar com atendente” para acelerar o atendimento humano.\n` +
    `Visualizar seus pedidos: https://www.natura.com.br/meus-dados/pedidos?consultoria=clubemac`
  );
}

async function replyBrand(sock, jid, brandName) {
  sendSafe(
    sock,
    jid,
    `Posso te ajudar com a linha *${brandName}* 😊\n` +
    `Você pode conferir os itens em promoção aqui: ${LINKS.promosGerais}\n` +
    `Se quiser, me diga qual produto da linha que você procura.`
  );
  // 🔧 garante venda: sempre anexar cupons depois de marca
  await replyCoupons(sock, jid);
}

// 🔧 MENU padrão quando não entender
function replyHelpMenu(sock, jid) {
  const txt =
    'Posso te ajudar com:\n' +
    `• Suporte oficial (pedidos/entrega): https://www.natura.com.br/ajuda-e-contato\n` +
    `• Promoções do dia: ${LINKS.promosGerais}\n` +
    `• Cupons atuais: ${LINKS.cuponsSite}\n` +
    `• Sorteio: envie o número 7 🙂`;
  sendSafe(sock, jid, txt);
}

// ───────────── OpenAI (fallback) ─────────────
async function askOpenAI({ prompt, userName, isNewTopic }) {
  const fallback = 'Estou online! Se quiser, posso buscar promoções, cupons ou tirar dúvidas rápidas. 🙂✨';
  if (!OPENAI_API_KEY) return fallback;

  const rules = [
    SYSTEM_TEXT,
    '',
    'Regras de execução:',
    `- Nome do cliente: ${userName || '(desconhecido)'}`,
    `- isNewTopic=${isNewTopic ? 'true' : 'false'} (se true, pode se apresentar; se false, evite nova saudação)`,
    '- Use SOMENTE os links listados nas seções 3/4/5/6/8, sempre com ?consultoria=clubemac. Se não houver link específico, não forneça link.',
    '- Nunca formate link como markdown/âncora. Exiba o texto exato do link.',
    '- Inclua 2–3 emojis por resposta (sem exagero).',
    '- Se a pergunta for ambígua ou envolver produto/foto, SEMPRE finalize com o bloco de promoções + cupons.'
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
function hasMedia(msg) {
  try {
    const m0 = msg?.message || {};
    const m = m0.ephemeralMessage?.message || m0;
    return !!(m.imageMessage || m.videoMessage || m.documentMessage || m.audioMessage || m.stickerMessage);
  } catch (_) { return false; }
}
function isGroup(jid)  { return String(jid || '').endsWith('@g.us'); }
function isStatus(jid) { return String(jid || '') === 'status@broadcast'; }
function isFromMe(msg) { return !!msg?.key?.fromMe; }

// ───────────── Core handler (messages.upsert) ─────────────
function buildUpsertHandler(getSock) {
  return async (ev) => {
    try {
      if (!ev?.messages?.length) return;
      const m = ev.messages[0];
      const jid = m?.key?.remoteJid;
      if (!jid || isFromMe(m) || isGroup(jid) || isStatus(jid)) return;

      // texto de entrada (ou transcrição se áudio)
      let text = extractText(m);

      // NOVO: transcrição de áudio (opt-in)
      if ((!text || !text.trim()) && typeof transcribeAudioIfAny === 'function') {
        try {
          const sockNow0 = getSock();
          text = await transcribeAudioIfAny(sockNow0, m);
        } catch (_) { /* ignora falha de transcrição */ }
      }

      if (!text || !text.trim()) return;

      const rawName = (m.pushName || '').trim();
      const hadMedia = hasMedia(m);

      pushIncoming(jid, text, async (batch, ctx) => {
        const sockNow = getSock();
        if (!sockNow) return;

        const joined = batch.join(' ').trim();

        // ===== Nova detecção centralizada =====
        const intent = detectIntent ? detectIntent(joined) : { type: null, data: null };

        // 0) segurança primeiro
        if (intent.type === 'security') { sendSafe(sockNow, jid, securityReply()); return; }

        // 1) Intents rápidas já existentes
        if (intent.type === 'thanks' || wantsThanks(joined))                 { replyThanks(sockNow, jid); return; }
        if (intent.type === 'coupon_problem' || wantsCouponProblem(joined))  { replyCouponProblem(sockNow, jid); return; }
        if (intent.type === 'order_support'  || wantsOrderSupport(joined))   { replyOrderSupport(sockNow, jid); return; }
        if (intent.type === 'raffle'         || wantsRaffle(joined))         { replyRaffle(sockNow, jid); return; }
        if (intent.type === 'coupon'         || wantsCoupon(joined))         { await replyCoupons(sockNow, jid); return; }
        if (intent.type === 'promos'         || wantsPromos(joined))         { await replyPromos(sockNow, jid); return; }
        if (intent.type === 'social'         || wantsSocial(joined))         { replySocial(sockNow, jid, joined); return; }
        if (intent.type === 'soap'           || wantsSoap(joined))           { await replySoap(sockNow, jid); return; }
        if (intent.type === 'brand')                                           { await replyBrand(sockNow, jid, intent.data.name); return; }

        // Saudação (opcional)
        let isNewTopicForAI = ctx.shouldGreet;

        // NOVO: saudação determinística por regra (opt-in)
        if (ctx.shouldGreet && RULE_GREETING_ON && nameUtils && typeof nameUtils.buildGreeting === 'function') {
          const safeName = (nameUtils.pickDisplayName && nameUtils.pickDisplayName(rawName)) || rawName || '';
          const greetMsg = nameUtils.buildGreeting(safeName);
          markGreeted(jid);
          sendSafe(sockNow, jid, greetMsg);
          isNewTopicForAI = false; // evita a IA saudar de novo
        } else if (ctx.shouldGreet && GREET_TEXT) {
          // Saudação fixa (já existente)
          markGreeted(jid);
          sendSafe(sockNow, jid, GREET_TEXT);
          isNewTopicForAI = false;
        }

        // Fallback IA
        const out = await askOpenAI({ prompt: joined, userName: rawName, isNewTopic: isNewTopicForAI });
        if (out && out.trim()) {
          sendSafe(sockNow, jid, out.trim());
          if (ctx.shouldGreet && !GREET_TEXT && !(RULE_GREETING_ON && nameUtils)) {
            // se a saudação ficou a cargo da IA, ainda marcamos
            markGreeted(jid);
          }

          // 🔧 Heurística "nunca sair seco": se é conversa de produto/ambígua ou veio mídia, anexar promo+cupons
          let shouldAppend = hadMedia || wantsProductTopic(joined);
          if (!shouldAppend && heuristics && typeof heuristics.decideAppendPromoAndCoupons === 'function') {
            try { shouldAppend = heuristics.decideAppendPromoAndCoupons({ userText: joined, hadMedia }); } catch (_) {}
          }
          if (shouldAppend) {
            await replyPromos(sockNow, jid); // replyPromos já chama replyCoupons no final
          }
        } else {
          // Se a IA não respondeu (ou vazio), não deixa o cliente sem saída
          replyHelpMenu(sockNow, jid);
        }
      });
    } catch (e) {
      console.error('[assistant] upsert error', e?.message || e);
    }
  };
}

// ───────────── Wire-up (com rewire por referência) ─────────────
function attachAssistant(appInstance) {
  if (!ASSISTANT_ENABLED) { console.log('[assistant] disabled (ASSISTANT_ENABLED!=1)'); return; }
  console.log('[assistant] enabled (rewire:', REWIRE_MODE, ', interval:', REWIRE_INTERVAL_MS, ')');

  const getSock = () =>
    (appInstance?.waAdmin?.getSock && appInstance.waAdmin.getSock()) ||
    (appInstance?.whatsappClient?.sock);

  let currentSocketRef = null;
  let upsertHandler = null;
  let connHandler = null;

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

    if (currentSocketRef) {
      offSafe(currentSocketRef, 'messages.upsert', upsertHandler);
      offSafe(currentSocketRef, 'connection.update', connHandler);
    }

    upsertHandler = buildUpsertHandler(getSock);
    connHandler = (ev) => { if (ev?.connection === 'open') setTimeout(() => ensureWired(), 200); };

    sock.ev.on('messages.upsert', upsertHandler);
    if (typeof sock.ev.on === 'function') { sock.ev.on('connection.update', connHandler); }

    currentSocketRef = sock;

    const sid =
      (sock?.user && (sock.user.id || sock.user.jid)) ||
      (sock?.authState && sock.authState.creds?.me?.id) ||
      'unknown-sock';
    console.log('[assistant] wired to sock', sid);

    return true;
  };

  const ensureWired = () => {
    const sock = getSock();
    if (!sock) return false;
    if (sock !== currentSocketRef) return wireToSock(sock);
    try {
      const hasOn = !!sock?.ev && typeof sock.ev.on === 'function';
      const needRewire = !hasOn || !upsertHandler;
      if (needRewire) return wireToSock(sock);
    } catch (_) {}
    return true;
  };

  if (REWIRE_MODE === 'auto') {
    ensureWired();
    setInterval(() => { try { ensureWired(); } catch (_) {} }, REWIRE_INTERVAL_MS);
  } else {
    const tryOnce = () => { const sock = getSock(); if (sock) wireToSock(sock); };
    tryOnce(); setTimeout(tryOnce, 2000);
  }
}

module.exports = { attachAssistant };
