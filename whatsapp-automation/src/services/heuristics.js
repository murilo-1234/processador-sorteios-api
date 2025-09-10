// src/services/heuristics.js
// Regras simples de “vendedor”: quando anexar promoções + cupons.

function decideAppendPromoAndCoupons({ userText = '', hadMedia = false } = {}) {
  const s = String(userText || '').toLowerCase();

  // mídia sempre vira oportunidade de venda
  if (hadMedia) return true;

  // temas de produto/categoria
  const productish = /(perfume|perfumaria|hidratante|desodorante|maquiagem|batom|base|rosto|s[ée]rum|sabonete|cabelo|cabelos?|shampoo|condicionador|mascara|cronograma|barba|infantil|presente|kit|aura|ekos|kaiak|essencial|luna|tododia|mam[aã]e e beb[êe]|una|faces|chronos|lumina|biome|bothanica)/i;
  if (productish.test(s)) return true;

  // perguntas de preço/opção (ambíguas)
  if (/(pre[çc]o|quanto custa|tem .*? dispo|qual voc[eê] indica|ideia de presente)/.test(s)) return true;

  return false;
}

module.exports = { decideAppendPromoAndCoupons };
