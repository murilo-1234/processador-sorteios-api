// src/services/intent-helpers.js
// Normaliza texto e centraliza regex tolerantes a erros de digitação.

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // remove acentos
}

// —— Intents
function wantsCoupon(text) {
  const s = normalize(text);
  // cupom/cupons/cupon/cupao/cupons?/cupo
  return /\bcup(o|u|a)?m?s?\b|\bcupon(s)?\b|\bcupo(ns?)?\b/.test(s);
}
function wantsPromos(text) {
  const s = normalize(text);
  return /(promoc(a|ao|oes)|promo\b|oferta|desconto|liquida|sale)/.test(s);
}
function wantsRaffle(text) {
  const s = normalize(text);
  return /(sorteio|participar.*sorteio|quero.*sorteio|ganhar.*sorteio|\benviar\b.*\b7\b|\bmandar\b.*\b7\b|\bso?\b\s*7\b)/.test(s);
}
function wantsThanks(text) {
  const s = normalize(text).trim();
  return /(^|\b)(obrigado|obg|valeu|vlw|thanks|thank you|🙏|❤|❤️|💖|💗|💜|💙|💚|💛|💞|💝)($|\b)/.test(s);
}
function wantsSocial(text) {
  const s = normalize(text);
  return /(instagram|insta\b|tiktok|tik\s*tok|whatsapp|zap|grupo)/.test(s);
}
function wantsSoap(text) {
  const s = normalize(text);
  return /(sabonete|sabonetes)/.test(s);
}
function wantsCouponProblem(text) {
  const s = normalize(text);
  return /((cupom|codigo|codigo).*(nao.*(aplic|funcion)|erro)|erro.*(cupom|codigo))/.test(s);
}
function wantsOrderSupport(text) {
  const s = normalize(text);
  return /(pedido|entrega|nota fiscal|pagamento|boleto|rastreamento).*(problema|atras|nao chegou|erro|demora|reclama)/.test(s);
}

module.exports = {
  normalize,
  wantsCoupon,
  wantsPromos,
  wantsRaffle,
  wantsThanks,
  wantsSocial,
  wantsSoap,
  wantsCouponProblem,
  wantsOrderSupport,
};
