// src/modules/assistant-bot.js
// Liga entrada (mensagens 1:1) -> coalesce/greet ->
// intents (cupons/promos/sorteio/agradecimento/redes/sabonetes/suporte/segurança/marcas)
// -> OpenAI -> reply-queue

const fs = require('fs');
const axios = require('axios');
const { pushIncoming, markGreeted } = require('../services/inbox-state');
const { enqueueText } = require('../services/reply-queue');
const { fetchTopCoupons } = require('../services/coupons');

// utilitários existentes
const { detectIntent } = require('../services/intent-registry');
const { securityReply } = require('../services/security');

// opt-ins
let transcribeAudioIfAny = null;
try { ({ transcribeAudioIfAny } = require('../services/audio-transcriber')); } catch (_) {}
let nameUtils = null;
try { nameUtils = require('../services/name-utils'); } catch (_) {}
let heuristics = null;
try { heuristics = require('../services/heuristics'); } catch (_) {}

const ASSISTANT_ENABLED = String(process.env.ASSISTANT_ENABLED || '0') === '1';
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL      = process.env.OPENAI_MODEL || 'gpt-4o';
const ASSISTANT_TEMP    = Number(process.env.ASSISTANT_TEMPERATURE || 0.3);  // Reduzido para 0.3 (menos criatividade = menos invenção de links)

// Saudação fixa opcional (se vazia, Playground saúda)
const GREET_TEXT = (process.env.ASSISTANT_GREET_TEXT || '').trim();
const RULE_GREETING_ON = String(process.env.ASSISTANT_RULE_GREETING || '0') === '1';

// Rewire/Watchdog
const REWIRE_MODE = String(process.env.ASSISTANT_REWIRE_MODE || 'auto').toLowerCase();
const REWIRE_INTERVAL_MS = Math.max(5000, Number(process.env.ASSISTANT_REWIRE_INTERVAL_MS || 15000) | 0);

// Links oficiais (mantidos para atalhos de intenção, se usados)
// IMPORTANTE: Estes links devem bater com o arquivo assistant-system.txt
const LINKS = {
  promosProgressivo: 'https://swiy.co/garanto60off-natura',  // CORRIGIDO para bater com assistant-system.txt
  promosGerais:      'https://swiy.co/natura-70ou60off',
  sabonetes:         'https://swiy.co/liquida-sabonetes',
  cuponsSite:        'https://swiy.co/cupons-murilo',
  avonPromos:        'https://swiy.co/loja-avon',
  disneyPromos:      'https://swiy.co/disney-promos',
  sorteioWhats:      'https://wa.me/5548991021707',
  sorteioInsta:      'https://ig.me/m/murilo_cerqueira_consultoria',
  sorteioMsg:        'http://m.me/murilocerqueiraconsultor',
  grupoResultados:   'https://chat.whatsapp.com/JSBFWPmUdCZ2Ef5saq0kE6',
  insta:             'https://www.instagram.com/murilo_cerqueira_consultoria',
  tiktok:            'https://www.tiktok.com/@murilocerqueiraconsultor',
  whatsMurilo:       'https://wa.me/5548991111707',
  grupoMurilo:       'https://chat.whatsapp.com/E51Xhe0FS0e4Ii54i71NjG'
};

// ====== System instructions ======
function loadSystemText() {
  try {
    // Tenta ler da variável de ambiente primeiro
    const file = (process.env.ASSISTANT_SYSTEM_FILE || '').trim();
    if (file) {
      const txt = fs.readFileSync(file, 'utf8');
      if (txt && txt.trim()) {
        console.log('[assistant] Carregado de ASSISTANT_SYSTEM_FILE:', file);
        return txt.trim();
      }
    }
    
    // Se não houver variável, tenta ler do caminho padrão relativo ao módulo
    const path = require('path');
    const defaultPath = path.join(__dirname, '../config/assistant-system.txt');
    const txt = fs.readFileSync(defaultPath, 'utf8');
    if (txt && txt.trim()) {
      console.log('[assistant] Carregado do caminho padrão:', defaultPath);
      return txt.trim();
    }
  } catch (e) {
    console.error('[assistant] ERRO ao carregar system text:', e.message);
    console.error('[assistant] Caminho tentado:', e.path || 'desconhecido');
  }
  
  // Tenta variável de ambiente com texto direto
  const envTxt = (process.env.ASSISTANT_SYSTEM || '').trim();
  if (envTxt) {
    console.log('[assistant] Usando ASSISTANT_SYSTEM da variável de ambiente');
    return envTxt;
  }
  
  // Fallback - nunca deve chegar aqui se o arquivo existir
  console.warn('[assistant] ATENÇÃO: Usando texto padrão de fallback (arquivo não foi carregado!)');
  return 'Você é o atendente virtual do Murilo Cerqueira (Natura e Avon). Siga as regras do arquivo assistant-system.txt. Não invente links; use apenas os oficiais com ?consultoria=clubemac.';
}
const SYSTEM_TEXT = loadSystemText();

// ───────── Intents rápidas (compat) ─────────
function wantsCoupon(text) {
  const s = String(text || '').toLowerCase();
  return /\b(cupom|cupon|cupum|cupao|coupon|kupon|coupom|coupoin)s?\b/.test(s);
}
function wantsPromos(text) {
  const s = String(text || '').toLowerCase();
  return /(promo(ç|c)[aã]o|promos?\b|oferta|desconto|liquid(a|ã)c?[aã]o|sale)/i.test(s);
}
function wantsRaffle(text) {
  const s = String(text || '').toLowerCase().trim();
  if (/^[\s7]+$/.test(s)) return true;    // "7", "7 7", "7…"
  if (/\bsete\b/.test(s)) return true;
  return /(sorteio|participar.*sorteio|quero.*sorteio|ganhar.*sorteio|\benviar\b.*\b7\b|\bmandar\b.*\b7\b)/i.test(s);
}
function wantsThanks(text) {
  const s = String(text || '').toLowerCase().trim();
  return /(^|\b)(obrigad[oa]|obg|valeu|vlw|🙏|❤|❤️)($|\b)/i.test(s);
}
function wantsSocial(text) {
  const s = String(text || '').toLowerCase();
  return /(instagram|insta\b|ig\b|tiktok|tik[\s-]?tok|whatsapp|zap|grupo)/i.test(s);
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
  return /(pedido|compra|encomenda|pacote|entrega|nota fiscal|pagamento|boleto).*(problema|atras|n[aã]o chegou|nao recebi|erro|sumiu|cad[eê])|rastre(i|ei)o|codigo de rastreio|transportadora/.test(s);
}

// tópico de produto (tolerante) – mantido para compat, embora não haja mais "append" automático
function wantsProductTopic(text) {
  const s = String(text || '').toLowerCase();
  return /(hidrat\w+|perfum\w+|desodorant\w+|sabonete\w*|cabel\w+|maquiag\w+|barb\w+|infantil\w*|present\w*|kit\w*|aura\b|ekos\b|kaiak\b|essencial\b|luna\b|tododia\b|mam[aã]e.*beb[eê]\b|una\b|faces\b|chronos\b|lumina\b|biome\b|bothanica\b)/i.test(s);
}

// Botões (opcional)
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

// ==== CUPOM: substituição de marcador {{CUPOM}} vindo do Playground ====
async function replaceCouponMarkers(text) {
  try {
    if (!text || !/\{\{\s*CUPOM\s*\}\}/i.test(text)) return text;
    const list = await fetchTopCoupons(2);
    const cup = Array.isArray(list) && list.length
      ? (list.length > 1 ? `${list[0]} ou ${list[1]}` : list[0])
      : 'CLUBEMAC';
    return text.replace(/\{\{\s*CUPOM\s*\}\}/gi, cup);
  } catch (_) {
    return text;
  }
}

// Respostas baseadas em regra (mantidas p/ compat se usuário digitar diretamente)
async function replyCoupons(sock, jid) {
  let list = [];
  try { list = await fetchTopCoupons(2); } catch (_) {}

  const nota = 'Obs.: os cupons só funcionam no meu Espaço Natura — na tela de pagamento, procure por "Murilo Cerqueira".';
  const promoLine = `Promoções do dia: ${LINKS.promosGerais}`;

  if (Array.isArray(list) && list.length) {
    const [c1, c2] = list;
    const linha = c2 ? `Tenho dois cupons agora: *${c1}* ou *${c2}* 😉`
                     : `Tenho um cupom agora: *${c1}* 😉`;
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
    `🔥 Desconto progressivo Natura ➡️ ${LINKS.promosProgressivo}\n` +
    `  O desconto máximo (pode chegar a 60% + Frete Grátis com cupom) acima de 3 a 4 produtos dentre 328 disponíveis.\n` +
    `🔥 Produtos em promoção ➡️ ${LINKS.promosGerais}\n` +
    `  723 itens com até 70% OFF e frete grátis aplicando cupom.\n` +
    `🔥 Sabonetes Natura em promoção ➡️ ${LINKS.sabonetes}\n` +
    `🔥 Promoções AVON ➡️ ${LINKS.avonPromos}\n` +
    `  127 itens com 60% a 70%Off com cupom\n` +
    `🔥 Promoções Disney ➡️ ${LINKS.disneyPromos}\n` +
    `  De 40% a 70%Off em Stitch, Mickey, Homem-aranha, Avengers e mais.`;
  if (USE_BUTTONS) {
    const ok = await sendUrlButtons(sock, jid, header, [
      { index: 1, urlButton: { displayText: 'Ver promoções Natura', url: LINKS.promosGerais      } },
      { index: 2, urlButton: { displayText: 'Desconto progressivo', url: LINKS.promosProgressivo } },
      { index: 3, urlButton: { displayText: 'Ver promoções AVON',   url: LINKS.avonPromos        } },
    ]);
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
    sock, jid,
    `Para participar do sorteio, envie **7** (apenas o número) em UMA ou MAIS redes:\n` +
    `• WhatsApp: ${LINKS.sorteioWhats}\n` +
    `• Instagram: ${LINKS.sorteioInsta}\n` +
    `• Messenger: ${LINKS.sorteioMsg}\n\n` +
    `Cada rede vale *1 chance extra*. Resultados são divulgados no grupo: ${LINKS.grupoResultados} 🎉`
  );
}

function replyThanks(sock, jid) { enqueueText(sock, jid, 'Por nada! ❤️ Conte comigo sempre!'); }

function replySocial(sock, jid, text) {
  const s = (text || '').toLowerCase();
  if (/instagram|insta\b|^ig$/.test(s)) return enqueueText(sock, jid, `Instagram ➡️ ${LINKS.insta}`);
  if (/tiktok|tik[\s-]?tok/.test(s))    return enqueueText(sock, jid, `Tiktok ➡️ ${LINKS.tiktok}`);
  if (/grupo/.test(s))                  return enqueueText(sock, jid, `Grupo de Whatsapp ➡️ ${LINKS.grupoMurilo}`);
  if (/whatsapp|zap/.test(s))           return enqueueText(sock, jid, `Whatsapp ➡️ ${LINKS.whatsMurilo}`);
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
    sock, jid,
    `O cupom só funciona no meu Espaço Natura. Na tela de pagamento, procure por *Murilo Cerqueira* ou, em "Minha Conta", escolha seu consultor.\n` +
    `Tente outro cupom e veja mais em: ${LINKS.cuponsSite}\n` +
    `Se puder, feche e abra o app/navegador ou troque entre app e navegador.\n` +
    `Acesse promoções com a consultoria correta: ${LINKS.promosGerais}`
  );
}

function replyOrderSupport(sock, jid) {
  enqueueText(
    sock, jid,
    `Pagamentos, nota fiscal, pedido e entrega são tratados pelo suporte oficial da Natura:\n` +
    `https://swiy.co/jyOY\n` +
    `Dica: no chat, digite 4x "Falar com atendente" para acelerar o atendimento humano.\n` +
    `Visualizar seus pedidos: https://swiy.co/jyO-`
  );
}

async function replyBrand(sock, jid, brandName) {
  enqueueText(
    sock, jid,
    `Posso te ajudar com a linha *${brandName}* 😊\n` +
    `Você pode conferir os itens em promoção aqui: ${LINKS.promosGerais}\n` +
    `Se quiser, me diga qual produto da linha que você procura.`
  );
  await replyCoupons(sock, jid);
}

// ───────── OpenAI (Playground) ─────────
async function askOpenAI({ prompt, userName, isNewTopic }) {
  const fallback = 'Estou online! Se quiser, posso buscar promoções, cupons ou tirar dúvidas rápidas. 🙂✨';
  if (!OPENAI_API_KEY) return fallback;

  const rules = [
    SYSTEM_TEXT,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '📋 CONTEXTO DESTA CONVERSA (APENAS PARA SEU USO INTERNO):',
    `Cliente: ${userName || 'nome não informado'}`,
    `Início de conversa: ${isNewTopic ? 'SIM (pode se apresentar)' : 'NÃO (continuação, não se apresente novamente)'}`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '⚠️⚠️⚠️ REGRAS CRÍTICAS - NUNCA VIOLAR ⚠️⚠️⚠️',
    '',
    '🚫 NUNCA INCLUA NA SUA RESPOSTA:',
    '  - Variáveis técnicas (isNewTopic, userName, etc)',
    '  - Informações de debug ou contexto interno',
    '  - Apenas responda naturalmente ao cliente',
    '',
    '🚨🚨🚨 LINKS - PROIBIÇÕES ABSOLUTAS 🚨🚨🚨',
    '',
    '❌ NUNCA FAÇA ISTO:',
    '  - Inventar links como "swiy.co/avon-comprar" (NÃO EXISTE)',
    '  - Usar "www.avon.com.br" ou "www.natura.com.br"',
    '  - Criar links "parecidos" ou "lógicos"',
    '  - Misturar swiy.co com parâmetros ?consultoria',
    '',
    '✅ SEMPRE FAÇA ISTO:',
    '  - Use SOMENTE links das seções 3, 4.1, 4.2, 5, 6, 8',
    '  - Copie o link EXATO do arquivo',
    '  - Para Avon sem link específico: use https://swiy.co/jyYe',
    '  - Para Natura sem link específico: use https://swiy.co/natura-70ou60off',
    '',
    '📋 LINKS AVON PERMITIDOS (COMPLETO):',
    '  jyYe=loja, jyYl=promos, jyYY=desconto, jyYh=relampago,',
    '  jyYV=cupons, jyYW=frete, jyYg=lancamentos, jyYf=presentes,',
    '  jyYX=perfumes, jyYm=cabelos, jyYn=cuidados, jyYo=maquiagem,',
    '  jyYp=rosto, jyYs=casa, jyYq=infantil, jyYr=disney,',
    '  color-trend, power-stay, renew1, Avon-Care, Clearskin,',
    '  Advance-Techniques, Far-Away, Segno, Avon-Encanto, loja-avon, disney-promos',
    '',
    '⚡ EXEMPLO CORRETO:',
    '  Cliente: "quero comprar avon"',
    '  Você: "Acesse a loja: https://swiy.co/jyYe 😊"',
    '',
    '❌ EXEMPLO ERRADO (NUNCA FAZER):',
    '  Cliente: "quero comprar avon"',
    '  Você: "Acesse: https://swiy.co/avon-comprar" ← ERRADO!',
    '  Você: "Vá em www.avon.com.br/?consultoria=clubemac" ← ERRADO!',
    '',
    '📝 FORMATAÇÃO:',
    '- Nunca use markdown [texto](url) ou HTML',
    '- Para cupons use {{CUPOM}} (será substituído automaticamente)',
    '',
    '💬 SUA RESPOSTA DEVE SER:',
    '  - Natural e conversacional',
    '  - SEM variáveis técnicas',
    '  - SEM informações de debug',
    '  - Apenas a mensagem para o cliente'
  ].join('\n');

  try {
    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model: OPENAI_MODEL, temperature: ASSISTANT_TEMP, messages: [
        { role: 'system', content: rules },
        { role: 'user',   content: String(prompt || '').trim() }
      ] },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 25000 }
    );
    const out = data?.choices?.[0]?.message?.content?.trim();
    return out || fallback;
  } catch (e) {
    console.error('[assistant] openai error:', e?.response?.data || e?.message || e);
    return 'Desculpe, algo deu errado 😅. Pode tentar novamente em instantes?';
  }
}

// ───────── Utilitários de extração ─────────
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

// ───────── Core handler ─────────
function buildUpsertHandler(getSock) {
  return async (ev) => {
    try {
      if (!ev?.messages?.length) return;
      const m = ev.messages[0];
      const jid = m?.key?.remoteJid;
      if (!jid || isFromMe(m) || isGroup(jid) || isStatus(jid)) return;

      let text = extractText(m);

      if ((!text || !text.trim()) && typeof transcribeAudioIfAny === 'function') {
        try { const sockNow0 = getSock(); text = await transcribeAudioIfAny(sockNow0, m); } catch (_) {}
      }
      if (!text || !text.trim()) return;

      const rawName = (m.pushName || '').trim();
      const hadMedia = hasMedia(m);

      pushIncoming(jid, text, async (batch, ctx) => {
        const sockNow = getSock();
        if (!sockNow) return;

        const joined = batch.join(' ').trim();

        const intent = detectIntent ? detectIntent(joined) : { type: null, data: null };

        // 0) segurança
        if (intent.type === 'security') { enqueueText(sockNow, jid, securityReply()); return; }

        // 1) atalhos essenciais (mantidos por serem críticos/rápidos)
        if (intent.type === 'thanks' || wantsThanks(joined))                 { replyThanks(sockNow, jid); return; }
        if (intent.type === 'coupon_problem' || wantsCouponProblem(joined))  { replyCouponProblem(sockNow, jid); return; }
        if (intent.type === 'order_support'  || wantsOrderSupport(joined))   { replyOrderSupport(sockNow, jid); return; }
        if (intent.type === 'raffle'         || wantsRaffle(joined))         { replyRaffle(sockNow, jid); return; }
        if (intent.type === 'social'         || wantsSocial(joined))         { replySocial(sockNow, jid, joined); return; }
        
        // 2) Promoções: descomentado para mostrar lista com 🔥
        if (intent.type === 'promos'         || wantsPromos(joined))         { await replyPromos(sockNow, jid); return; }
        
        // 3) COMENTADO: Cupons, sabonetes e marcas agora passam pelo OpenAI
        //    para usar o arquivo assistant-system.txt completo (com 2 links de cupom)
        // if (intent.type === 'coupon'         || wantsCoupon(joined))         { await replyCoupons(sockNow, jid); return; }
        // if (intent.type === 'soap'           || wantsSoap(joined))           { await replySoap(sockNow, jid); return; }
        // if (intent.type === 'brand')                                           { await replyBrand(sockNow, jid, intent.data.name); return; }

        // Saudação por regra (opcional). Se desligada, Playground saúda.
        let isNewTopicForAI = ctx.shouldGreet;
        if (ctx.shouldGreet && RULE_GREETING_ON && nameUtils && typeof nameUtils.buildRuleGreeting === 'function') {
          const first = (nameUtils.pickDisplayName && nameUtils.pickDisplayName(rawName)) || '';
          const greetMsg = nameUtils.buildRuleGreeting(first);
          markGreeted(jid);
          enqueueText(sockNow, jid, greetMsg);
          isNewTopicForAI = false;
        } else if (ctx.shouldGreet && GREET_TEXT) {
          markGreeted(jid);
          enqueueText(sockNow, jid, GREET_TEXT);
          isNewTopicForAI = false;
        }

        // Playground
        const rawOut = await askOpenAI({
          prompt: joined,
          userName: (nameUtils && nameUtils.pickDisplayName ? nameUtils.pickDisplayName(rawName) : rawName),
          isNewTopic: isNewTopicForAI
        });

        // Substituição de {{CUPOM}} — sem anexos extras
        const out = await replaceCouponMarkers(rawOut);

        if (out && out.trim()) {
          enqueueText(sockNow, jid, out.trim());
          if (ctx.shouldGreet && !GREET_TEXT && !(RULE_GREETING_ON && nameUtils)) markGreeted(jid);
        }

        // Sem "failsafe append" e sem menu extra — Playground controla todo o conteúdo
        void hadMedia; void heuristics; void wantsProductTopic; // silencioso
      });
    } catch (e) {
      console.error('[assistant] upsert error', e?.message || e);
    }
  };
}

// ───────── Wire-up ─────────
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
