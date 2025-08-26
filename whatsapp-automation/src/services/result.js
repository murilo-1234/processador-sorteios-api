const axios = require('axios');
const cheerio = require('cheerio');

async function fetchResultInfo(id) {
  const url = `https://sorteios-info.murilo1234.workers.dev/resultado/${id}`;
  const { data: html } = await axios.get(url, { timeout: 15000 });
  const $ = cheerio.load(html);

  let winner =
    $('[data-winner]').text().trim() ||
    $('.winner,.ganhador,.resultado .nome').first().text().trim();

  if (!winner) {
    const body = $('body').text();
    const m = body.match(/Ganhador[a:]?\s*([^\n]+)/i);
    if (m) winner = m[1].trim();
  }

  let participants = 0;
  const text = $('body').text();
  const mm = text.match(/(\d+)\s+participantes?/i);
  if (mm) participants = parseInt(mm[1], 10);

  return { url, winner: winner || 'Ganhador(a)', participants };
}

module.exports = { fetchResultInfo };
