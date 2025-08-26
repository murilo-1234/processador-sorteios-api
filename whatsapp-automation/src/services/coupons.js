const axios = require('axios');
const cheerio = require('cheerio');

async function fetchFirstCoupon() {
  try {
    const { data: html } = await axios.get('https://clubemac.com.br/cupons/', { timeout: 15000 });
    const $ = cheerio.load(html);
    const text = $('body').text().replace(/\s+/g, ' ');
    const m = text.match(/\b[A-Z0-9]{4,12}\b/);
    if (m) return m[0];
  } catch (_) {}
  return process.env.DEFAULT_COUPON || 'CLUBEMAC';
}

module.exports = { fetchFirstCoupon };
