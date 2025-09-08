// whatsapp-automation/src/services/coupons.js
const axios = require('axios');
const cheerio = require('cheerio');

function extractCodesFromText(text) {
  const codes = [];
  const seen = new Set();
  const regex = /\b[A-Z0-9]{4,12}\b/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const code = m[0].toUpperCase();
    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }
  return codes;
}

/**
 * Retorna até `limit` cupons (máximo 2) deduplicados, na ordem em que aparecem.
 * Em falha, retorna um array com 1 fallback (DEFAULT_COUPON ou 'CLUBEMAC').
 */
async function fetchTopCoupons(limit = 2) {
  const capped = Math.max(1, Math.min(Number(limit) || 1, 2)); // garante 1..2
  try {
    const { data: html } = await axios.get('https://clubemac.com.br/cupons/', { timeout: 15000 });
    const $ = cheerio.load(html);
    const text = $('body').text().replace(/\s+/g, ' ').toUpperCase();
    const codes = extractCodesFromText(text);
    if (codes.length) {
      return codes.slice(0, capped);
    }
  } catch (_) {}
  const fallback = (process.env.DEFAULT_COUPON || 'CLUBEMAC').toUpperCase();
  return [fallback];
}

/**
 * Compatibilidade com código existente.
 * Continua disponível e agora apenas delega para fetchTopCoupons(1).
 */
async function fetchFirstCoupon() {
  const list = await fetchTopCoupons(1);
  return list[0] || (process.env.DEFAULT_COUPON || 'CLUBEMAC');
}

module.exports = { fetchFirstCoupon, fetchTopCoupons };
