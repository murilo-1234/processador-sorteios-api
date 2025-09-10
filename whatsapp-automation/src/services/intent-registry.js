// src/services/intent-registry.js
// Centraliza detecção de intents (tolerante a acentos/typos) e marcas Natura.

const { normalize, hasWord, removeDiacritics } = require('./text-normalizer');
const { fuzzyIncludes } = require('./fuzzy');
const brandsDb = require('../data/natura-brands.json');

let typosDb = null;
try {
  typosDb = require('../data/typos-dictionary.json'); // opcional
} catch (_) { typosDb = null; }

const BRAND_LIST = brandsDb?.brands || [];

function detectBrand(norm) {
  // procura sinônimos exatos ou fuzzy a 1 edição
  for (const b of BRAND_LIST) {
    const key = removeDiacritics(b.name).toLowerCase();
    if (norm.includes(` ${key} `)) return { name: b.name };
    if (Array.isArray(b.syn)) {
      const best = fuzzyIncludes(norm, b.syn.map(s => ` ${s} `), 1);
      if (best) return { name: b.name };
      for (const s of b.syn) {
        const k = ` ${removeDiacritics(s).toLowerCase()} `;
        if (norm.includes(k)) return { name: b.name };
      }
    }
  }
  return null;
}

function anyWord(norm, list=[]) {
  for (const w of list) {
    const k = ` ${removeDiacritics(String(w)).toLowerCase()} `;
    if (norm.includes(k)) return true;
  }
  return false;
}

function detectIntent(rawText = '') {
  const raw = String(rawText || '');
  const norm = ` ${normalize(raw)} `;

  // 1) sorteio com "7" sozinho / "sete" / frases equivalentes
  const rawTrim = removeDiacritics(raw).trim().toLowerCase();
  if (/^7[!,.…]*$/.test(rawTrim) || rawTrim === 'sete' || /\bquero (participar|entrar).*\bsorteio\b/.test(rawTrim)) {
    return { type: 'raffle' };
  }

  // 2) agradecimento (usa raw pra emojis)
  if (/(\bobrigad[oa]\b|\bobg\b|\bvlw\b|\bvaleu\b|🙏|❤|❤️)/i.test(raw)) {
    return { type: 'thanks' };
  }

  // 3) segurança/golpe
  const { hasSecurityRisk } = require('./security');
  if (hasSecurityRisk(raw)) return { type: 'security' };

  // dicionário opcional
  const d = typosDb || {};
  const words = (k, fallback=[]) => Array.isArray(d[k]) && d[k].length ? d[k] : fallback;

  // 4) problemas com cupom
  if (/(cupom|codigo|c[oó]digo).*(nao.*(aplic|funcion)|erro)|erro.*(cupom|codigo)/i.test(norm)) {
    return { type: 'coupon_problem' };
  }

  // 5) suporte a pedido/entrega/pagamento (mesmo sem "pedido")
  const pedidoTokens = words('order_support', [
    'pedido','compra','encomenda','pacote','entrega','nota fiscal','pagamento','boleto','rastreio','codigo de rastreio','transportadora','nao recebi','atrasou','cade meu'
  ]);
  if (anyWord(norm, pedidoTokens)) {
    // reforço: combina com termos de atraso/erro
    if (/(problema|atras|nao chegou|nao recebi|erro|sumiu|cade)/.test(norm)) {
      return { type: 'order_support' };
    }
    // ou presença explícita de rastreio/transportadora
    if (/(rastre(i|ei)o|transportadora)/.test(norm)) {
      return { type: 'order_support' };
    }
  }

  // 6) promoções (promocao/promocoes/promo/oferta/desconto/liquidacao/sale)
  const promoTokens = words('promos', ['promocao','promocoes','promo','oferta','ofertas','desconto','descontos','liquidacao','sale']);
  if (anyWord(norm, promoTokens) || /(promo(ç|c)[aã]o|promos?\b|oferta|desconto|liquida|sale)/i.test(norm)) {
    return { type: 'promos' };
  }

  // 7) cupom/cupon/cupao/kupon (fuzzy leve) — sem confundir "cpom" (CPOM)
  if (!/\bcpom\b/i.test(norm)) {
    const couponTokens = words('coupon', ['cupom','cupons','cupon','cupao','cupum','coupon','kupon','cumpom','copom','coupom','coupoin']);
    if (anyWord(norm, couponTokens) || fuzzyIncludes(norm.trim(), couponTokens, 2)) {
      return { type: 'coupon' };
    }
  }

  // 8) sabonete(s) — aceita typos comuns
  const soapTokens = words('soap', ['sabonete','sabonetes']);
  if (anyWord(norm, soapTokens) || fuzzyIncludes(norm.trim(), ['sabonte','sabontes','sabones','sabone','sabonets'], 2)) {
    return { type: 'soap' };
  }

  // 9) redes sociais
  const socialTokens = words('social', ['instagram','insta','tiktok','tik tok','whatsapp','zap','grupo']);
  if (anyWord(norm, socialTokens)) {
    return { type: 'social' };
  }

  // 10) marca/linha Natura
  const brand = detectBrand(norm);
  if (brand) return { type: 'brand', data: brand };

  return { type: 'none' };
}

module.exports = { detectIntent };
