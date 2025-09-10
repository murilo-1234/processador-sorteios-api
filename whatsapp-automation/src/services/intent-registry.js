// src/services/intent-registry.js
// Centraliza detecção de intents (tolerante a acentos/typos) e marcas Natura.

const { normalize, hasWord, removeDiacritics } = require('./text-normalizer');
const { fuzzyIncludes } = require('./fuzzy');
const brandsDb = require('../data/natura-brands.json');

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

function detectIntent(rawText = '') {
  const raw = String(rawText || '');
  const norm = ` ${normalize(raw)} `;

  // 1) sorteio com "7" sozinho
  const rawTrim = removeDiacritics(raw).trim().toLowerCase();
  if (rawTrim === '7' || /\benviar\b.*\b7\b/.test(rawTrim)) {
    return { type: 'raffle' };
  }

  // 2) agradecimento (usa raw pra emojis)
  if (/(\bobrigad[oa]\b|\bobg\b|\bvlw\b|\bvaleu\b|🙏|❤|❤️)/i.test(raw)) {
    return { type: 'thanks' };
  }

  // 3) segurança/golpe
  const { hasSecurityRisk } = require('./security');
  if (hasSecurityRisk(raw)) return { type: 'security' };

  // 4) problemas com cupom
  if (/(cupom|codigo|c[oó]digo).*(nao.*(aplic|funcion)|erro)|erro.*(cupom|codigo)/i.test(norm)) {
    return { type: 'coupon_problem' };
  }

  // 5) suporte a pedido/entrega/pagamento
  if (/(pedido|entrega|nota fiscal|pagamento|boleto).*(problema|atras|nao chegou|erro)/i.test(norm)) {
    return { type: 'order_support' };
  }

  // 6) promoções (promocao/promocoes/promo/oferta/desconto/liquidacao/sale)
  if (/(promoc|promo\b|oferta|desconto|liquida|sale)/i.test(norm)) {
    return { type: 'promos' };
  }

  // 7) cupom/cupon/cupao/kupon (fuzzy leve)
  if (/(cupom|cupon|cupao|kupon|coupon)s?/i.test(norm) ||
      fuzzyIncludes(norm.trim(), ['cupom', 'cupons', 'cupao', 'cupon', 'coupon'], 2)) {
    return { type: 'coupon' };
  }

  // 8) sabonete(s)
  if (/(sabonete|sabonetes)/i.test(norm)) {
    return { type: 'soap' };
  }

  // 9) redes sociais
  if (/(instagram|insta\b|tiktok|tik[\s-]?tok|whatsapp|zap|grupo)/i.test(norm)) {
    return { type: 'social' };
  }

  // 10) marca/linha Natura
  const brand = detectBrand(norm);
  if (brand) return { type: 'brand', data: brand };

  return { type: 'none' };
}

module.exports = { detectIntent };
