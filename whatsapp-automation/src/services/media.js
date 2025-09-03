// src/services/media.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const axios = require('axios');

const MEDIA_DIR = process.env.MEDIA_DIR || '/data/media';
fs.mkdirSync(MEDIA_DIR, { recursive: true });

/* =========================================================
 * Helpers
 * ======================================================= */
async function downloadToBuffer(url) {
  const { data } = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SorteiosBot/1.0)' }
  });
  return Buffer.from(data);
}

function safe(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Ajuste simples de fonte conforme o tamanho do texto. */
function fitFont(base, text, steps = [
  [26, -6],
  [32, -10],
  [40, -14],
]) {
  const len = (text || '').length;
  let delta = 0;
  for (const [limit, dec] of steps) {
    if (len > limit) delta = dec;
  }
  return Math.max(18, base + delta);
}

/** Lê cor de ENV com fallback. */
const color = (key, fallback) => (process.env[key] || fallback);

/** Normaliza participantes: aceita número ou array/objeto. */
function participantsCount(p) {
  if (Array.isArray(p)) return p.length;
  const n = Number(p);
  return Number.isFinite(n) ? n : 0;
}

/** Quebra "dd/MM/yyyy às HH:mm[:ss]" -> { date, time, full } */
function splitDateTime(str = '') {
  const sep = str.includes(' às ') ? ' às ' : (str.includes(' as ') ? ' as ' : null);
  if (!sep) return { date: str, time: '', full: str };
  const [date, time] = str.split(sep);
  return { date, time, full: str };
}

/* =========================================================
 * Paleta (customizável por ENV)
 * ======================================================= */
const PALETTE = {
  bg1:       color('POSTER_BG_1',       '#6a7bd6'),
  bg2:       color('POSTER_BG_2',       '#7c5ed9'),
  card:      color('POSTER_CARD',       '#f8fafc'),
  cardLine:  color('POSTER_CARD_LINE',  '#eef2f7'),
  title:     color('POSTER_TITLE',      '#111827'),
  meta:      color('POSTER_META',       '#374151'),
  banner:    color('POSTER_BANNER',     '#ffd200'),
  bannerTx:  color('POSTER_BANNER_TX',  '#1f2937'),
  winner:    color('POSTER_WINNER',     '#1f2937'),
  sub:       color('POSTER_SUB',        '#374151'),
  statFrom:  color('POSTER_STAT_FROM',  '#7b5fe0'),
  statTo:    color('POSTER_STAT_TO',    '#5678e9'),
  statTx:    color('POSTER_STAT_TX',    '#ffffff'),
};

const BANNER_TEXT = process.env.POSTER_BANNER_TEXT || '🎉  GANHADOR DO SORTEIO!  🎉';
const SHAPE = (process.env.POSTER_SHAPE || 'portrait').toLowerCase(); // 'portrait' | 'square'

/* =========================================================
 * SVG layout — Portrait 1080x1350
 * ======================================================= */
function svgPortrait({ W, H, productB64, productName, dateStr, timeStr, winner, pCount }) {
  const CARD_W = 980;
  const CARD_H = 1120;
  const CARD_X = (W - CARD_W) / 2;
  const CARD_Y = 90;
  const SAFE_BOTTOM = 80;

  const titleSize  = fitFont(44, productName);
  const winnerSize = fitFont(56, winner, [[20, -6],[28, -10],[36,-16],[44,-20]]);
  const productBoxW = 300, productBoxH = 300;

  return `
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="${PALETTE.bg1}"/>
      <stop offset="1" stop-color="${PALETTE.bg2}"/>
    </linearGradient>
    <linearGradient id="stat" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${PALETTE.statFrom}"/>
      <stop offset="1" stop-color="${PALETTE.statTo}"/>
    </linearGradient>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="20" flood-color="#000" flood-opacity="0.15"/>
    </filter>
  </defs>

  <rect width="100%" height="100%" fill="url(#bg)"/>

  <g filter="url(#softShadow)">
    <rect x="${CARD_X}" y="${CARD_Y}" width="${CARD_W}" height="${CARD_H}" rx="24"
          fill="${PALETTE.card}" stroke="${PALETTE.cardLine}"/>
  </g>

  <!-- Título -->
  <text x="${CARD_X + 40}" y="${CARD_Y + 70}" font-size="${titleSize}" font-weight="800"
        fill="${PALETTE.title}" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Arial">
    ${safe(productName)}
  </text>

  <!-- Data/Hora -->
  <g font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Arial"
     fill="${PALETTE.meta}" font-size="22" font-weight="600">
    <text x="${CARD_X + 40}"  y="${CARD_Y + 110}">📅 ${safe(dateStr)}</text>
    <text x="${CARD_X + 200}" y="${CARD_Y + 110}">🕒 ${safe(timeStr)}</text>
  </g>

  <!-- Imagem do produto -->
  <image href="data:image/png;base64,${productB64}"
         x="${CARD_X + (CARD_W - productBoxW)/2}" y="${CARD_Y + 140}"
         width="${productBoxW}" height="${productBoxH}" preserveAspectRatio="xMidYMid meet"/>

  <!-- Banner -->
  <rect x="${CARD_X + 30}" y="${CARD_Y + 480}" width="${CARD_W - 60}" height="80" rx="16"
        fill="${PALETTE.banner}"/>
  <text x="${CARD_X + CARD_W/2}" y="${CARD_Y + 535}" text-anchor="middle"
        font-size="34" font-weight="900" fill="${PALETTE.bannerTx}"
        font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Arial">
    ${safe(BANNER_TEXT)}
  </text>

  <!-- Vencedor -->
  <text x="${CARD_X + CARD_W/2}" y="${CARD_Y + 620}" text-anchor="middle"
        font-size="${winnerSize}" font-weight="800" fill="${PALETTE.winner}"
        font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Arial">
    ${safe(winner)}
  </text>

  <!-- Mensagem -->
  <text x="${CARD_X + CARD_W/2}" y="${CARD_Y + 660}" text-anchor="middle"
        font-size="24" fill="${PALETTE.sub}"
        font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Arial">
    Parabéns! Você ganhou ${safe(productName)}!
  </text>

  <!-- Realizado em -->
  <text x="${CARD_X + CARD_W/2}" y="${CARD_Y + 690}" text-anchor="middle"
        font-size="20" fill="${PALETTE.meta}"
        font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Arial">
    🕒 Sorteio realizado em: ${safe(dateStr)}, ${safe(timeStr)}
  </text>

  <!-- Estatísticas -->
  <g>
    <!-- Participantes -->
    <rect x="${CARD_X + 40}" y="${CARD_Y + 740}" width="280" height="150" rx="20" fill="url(#stat)"/>
    <text x="${CARD_X + 180}" y="${CARD_Y + 805}" text-anchor="middle"
          font-size="44" font-weight="900" fill="${PALETTE.statTx}"
          font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Arial">${pCount}</text>
    <text x="${CARD_X + 180}" y="${CARD_Y + 845}" text-anchor="middle"
          font-size="20" fill="${PALETTE.statTx}"
          font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Arial">Participantes</text>

    <!-- Ganhador -->
    <rect x="${CARD_X + 350}" y="${CARD_Y + 740}" width="280" height="150" rx="20" fill="url(#stat)"/>
    <text x="${CARD_X + 490}" y="${CARD_Y + 805}" text-anchor="middle"
          font-size="44" font-weight="900" fill="${PALETTE.statTx}"
          font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Arial">1</text>
    <text x="${CARD_X + 490}" y="${CARD_Y + 845}" text-anchor="middle"
          font-size="20" fill="${PALETTE.statTx}"
          font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Arial">Ganhador</text>

    <!-- Transparência -->
    <rect x="${CARD_X + 660}" y="${CARD_Y + 740}" width="280" height="150" rx="20" fill="url(#stat)"/>
    <text x="${CARD_X + 800}" y="${CARD_Y + 805}" text-anchor="middle"
          font-size="44" font-weight="900" fill="${PALETTE.statTx}"
          font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Arial">100%</text>
    <text x="${CARD_X + 800}" y="${CARD_Y + 845}" text-anchor="middle"
          font-size="20" fill="${PALETTE.statTx}"
          font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Arial">Transparência</text>
  </g>

  <rect x="0" y="${H - SAFE_BOTTOM}" width="${W}" height="${SAFE_BOTTOM}" fill="transparent"/>
</svg>`;
}

/* =========================================================
 * SVG layout — Square 1080x1080 (opcional via POSTER_SHAPE=square)
 * ======================================================= */
function svgSquare({ W, H, productB64, productName, dateStr, timeStr, winner, pCount }) {
  const PAD = 48;
  const panelX = PAD, panelY = PAD, panelW = W - PAD * 2, panelH = H - PAD * 2;

  const titleSize  = fitFont(54, productName, [[22, -6],[28,-10],[36,-16]]);
  const winnerSize = fitFont(72, winner, [[20, -8],[28,-14],[36,-18],[48,-22]]);

  const imgCardW = 360, imgCardH = 360;
  const imgCardX = Math.round(W / 2 - imgCardW / 2);
  const imgCardY = panelY + 120;
  const bannerY  = imgCardY + imgCardH + 30;
  const statsY   = H - PAD - 150;

  const cardW = Math.floor((panelW - 2 * 24) / 3);
  const c1X = panelX + 0 * (cardW + 24);
  const c2X = panelX + 1 * (cardW + 24);
  const c3X = panelX + 2 * (cardW + 24);

  return `
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${PALETTE.bg1}"/>
      <stop offset="1" stop-color="${PALETTE.bg2}"/>
    </linearGradient>
    <linearGradient id="stat" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${PALETTE.statFrom}"/>
      <stop offset="1" stop-color="${PALETTE.statTo}"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="36" fill="#ffffff"/>

  <text x="${W/2}" y="${panelY + 50}" text-anchor="middle"
        font-family="Inter, Segoe UI, Arial" font-size="${titleSize}" font-weight="800" fill="${PALETTE.title}">
    ${safe(productName)}
  </text>

  <text x="${W/2}" y="${panelY + 98}" text-anchor="middle"
        font-family="Inter, Segoe UI, Arial" font-size="28" fill="${PALETTE.meta}">
    📅 ${safe(dateStr)}   ⏰ ${safe(timeStr)}
  </text>

  <rect x="${imgCardX}" y="${imgCardY}" width="${imgCardW}" height="${imgCardH}" rx="24"
        fill="#ffffff" stroke="#e5e7eb" stroke-width="2"/>
  <image href="data:image/png;base64,${productB64}"
         x="${imgCardX + 20}" y="${imgCardY + 20}"
         width="${imgCardW - 40}" height="${imgCardH - 40}"
         preserveAspectRatio="xMidYMid meet"/>

  <rect x="${panelX + 16}" y="${bannerY}" width="${panelW - 32}" height="210" rx="24"
        fill="${PALETTE.banner}" stroke="#f59e0b" stroke-width="2"/>
  <text x="${W/2}" y="${bannerY + 58}" text-anchor="middle"
        font-family="Inter, Segoe UI, Arial" font-size="42" font-weight="800" fill="${PALETTE.bannerTx}">
    ${safe(BANNER_TEXT)}
  </text>
  <text x="${W/2}" y="${bannerY + 120}" text-anchor="middle"
        font-family="Inter, Segoe UI, Arial" font-size="${winnerSize}" font-weight="800" fill="${PALETTE.winner}">
    ${safe(winner)}
  </text>
  <text x="${W/2}" y="${bannerY + 168}" text-anchor="middle"
        font-family="Inter, Segoe UI, Arial" font-size="26" fill="${PALETTE.sub}" opacity="0.95">
    Parabéns! Você ganhou ${safe(productName)}!
  </text>

  <text x="${W/2}" y="${statsY - 24}" text-anchor="middle"
        font-family="Inter, Segoe UI, Arial" font-size="22" fill="${PALETTE.meta}">
    🕒 Sorteio realizado em: ${safe(dateStr)}, ${safe(timeStr)}
  </text>

  <g>
    <rect x="${c1X}" y="${statsY}" width="${cardW}" height="120" rx="22" fill="url(#stat)"/>
    <rect x="${c2X}" y="${statsY}" width="${cardW}" height="120" rx="22" fill="url(#stat)"/>
    <rect x="${c3X}" y="${statsY}" width="${cardW}" height="120" rx="22" fill="url(#stat)"/>

    <text x="${c1X + cardW/2}" y="${statsY + 54}" text-anchor="middle"
          font-family="Inter, Segoe UI, Arial" font-size="46" font-weight="900" fill="${PALETTE.statTx}">${pCount}</text>
    <text x="${c1X + cardW/2}" y="${statsY + 92}" text-anchor="middle"
          font-family="Inter, Segoe UI, Arial" font-size="22" fill="${PALETTE.statTx}">Participantes</text>

    <text x="${c2X + cardW/2}" y="${statsY + 54}" text-anchor="middle"
          font-family="Inter, Segoe UI, Arial" font-size="46" font-weight="900" fill="${PALETTE.statTx}">1</text>
    <text x="${c2X + cardW/2}" y="${statsY + 92}" text-anchor="middle"
          font-family="Inter, Segoe UI, Arial" font-size="22" fill="${PALETTE.statTx}">Ganhador</text>

    <text x="${c3X + cardW/2}" y="${statsY + 54}" text-anchor="middle"
          font-family="Inter, Segoe UI, Arial" font-size="46" font-weight="900" fill="${PALETTE.statTx}">100%</text>
    <text x="${c3X + cardW/2}" y="${statsY + 92}" text-anchor="middle"
          font-family="Inter, Segoe UI, Arial" font-size="22" fill="${PALETTE.statTx}">Transparência</text>
  </g>
</svg>`;
}

/* =========================================================
 * Public API
 * ======================================================= */
async function generatePoster({
  productImageUrl,
  productName,
  dateTimeStr, // "dd/MM/yyyy às HH:mm[:ss]"
  winner,
  participants
}) {
  const isSquare = SHAPE === 'square';
  const W = isSquare ? 1080 : 1080;
  const H = isSquare ? 1080 : 1350;

  // produto
  let productBuf = null;
  try {
    if (productImageUrl) productBuf = await downloadToBuffer(productImageUrl);
  } catch {}
  if (!productBuf) {
    productBuf = await sharp({ create: { width: 600, height: 600, channels: 4, background: '#eee' }})
      .png().toBuffer();
  }
  const normalized = await sharp(productBuf)
    .resize(600, 600, { fit: 'inside', withoutEnlargement: true, background: '#ffffff' })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
  const productB64 = normalized.toString('base64');

  const { date, time, full } = splitDateTime(dateTimeStr || '');
  const pCount = participantsCount(participants);

  const svg = isSquare
    ? svgSquare({ W, H, productB64, productName: productName || 'Sorteio', dateStr: date || '', timeStr: time || '', winner: winner || 'Ganhador(a)', pCount })
    : svgPortrait({ W, H, productB64, productName: productName || 'Sorteio', dateStr: date || '', timeStr: time || '', winner: winner || 'Ganhador(a)', pCount });

  const outPath = path.join(MEDIA_DIR, `poster_${Date.now()}.png`);
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return outPath;
}

module.exports = { generatePoster };
