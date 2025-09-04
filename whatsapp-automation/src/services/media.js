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

/** Quebra "dd/MM/yyyy às HH:mm[:ss]" -> { date, time } */
function splitDateTime(str = '') {
  const sep = str.includes(' às ') ? ' às ' : (str.includes(' as ') ? ' as ' : null);
  if (!sep) return { date: str, time: '' };
  const [date, time] = str.split(sep);
  return { date, time };
}

/* =========================================================
 * Paleta (customizável por ENV) — BRANCO POR PADRÃO
 * ======================================================= */
const PALETTE = {
  bg1:       color('POSTER_BG_1',       '#ffffff'),
  bg2:       color('POSTER_BG_2',       '#ffffff'),
  card:      color('POSTER_CARD',       '#ffffff'),
  cardLine:  color('POSTER_CARD_LINE',  '#e5e7eb'),
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

const SHAPE = (process.env.POSTER_SHAPE || 'portrait').toLowerCase(); // 'portrait' | 'square'
const BANNER_TITLE = (process.env.POSTER_BANNER_TEXT || 'Ganhador(a) do Sorteio').replace(/🎉|✨|🎊|👑/g, ''); // sem emoji

/* =========================================================
 * SVG — Retrato 1080x1350 (vencedor + meta DENTRO do banner)
 * ======================================================= */
function svgPortrait({
  W, H,
  productB64,
  productName,
  dateStr,
  timeStr,
  winner,
  metaDateTime,   // ex: "Entrou na lista: 03/09/25 17:09:15"
  metaChannel,    // ex: "Acesso via: WhatsApp: (48) **1707"
  pCount
}) {
  const CARD_W = 980;
  const CARD_H = 1140;
  const CARD_X = (W - CARD_W) / 2;
  const CARD_Y = 90;
  const SAFE_BOTTOM = 80;

  const titleSize   = fitFont(44, productName);
  const winnerSize  = fitFont(52, winner, [[20,-4],[28,-8],[36,-12],[44,-16]]);
  const productBoxW = 300, productBoxH = 300;

  const yImageTop   = CARD_Y + 140;
  const yBanner     = CARD_Y + 480;
  const bannerH     = 180; // alto para caber 4 linhas
  const yStatsTop   = CARD_Y + 760;

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
      <feDropShadow dx="0" dy="8" stdDeviation="20" flood-color="#000" flood-opacity="0.08"/>
    </filter>
  </defs>

  <rect width="100%" height="100%" fill="url(#bg)"/>

  <g filter="url(#softShadow)">
    <rect x="${CARD_X}" y="${CARD_Y}" width="${CARD_W}" height="${CARD_H}" rx="24"
          fill="${PALETTE.card}" stroke="${PALETTE.cardLine}"/>
  </g>

  <!-- Título e data/hora (sem emoji) -->
  <text x="${CARD_X + 40}" y="${CARD_Y + 70}" font-size="${titleSize}" font-weight="800"
        fill="${PALETTE.title}" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Arial">
    ${safe(productName)}
  </text>
  <g font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Arial"
     fill="${PALETTE.meta}" font-size="22" font-weight="600">
    <text x="${CARD_X + 40}"  y="${CARD_Y + 110}">${safe(dateStr)}</text>
    <text x="${CARD_X + 200}" y="${CARD_Y + 110}">${safe(timeStr)}</text>
  </g>

  <!-- Imagem do produto -->
  <image href="data:image/png;base64,${productB64}"
         x="${CARD_X + (CARD_W - productBoxW)/2}" y="${yImageTop}"
         width="${productBoxW}" height="${productBoxH}" preserveAspectRatio="xMidYMid meet"/>

  <!-- Banner com 4 linhas -->
  <rect x="${CARD_X + 30}" y="${yBanner}" width="${CARD_W - 60}" height="${bannerH}" rx="16"
        fill="${PALETTE.banner}"/>
  <g font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Arial" fill="${PALETTE.bannerTx}">
    <text x="${CARD_X + CARD_W/2}" y="${yBanner + 34}" text-anchor="middle" font-size="24" font-weight="700">
      ${safe(BANNER_TITLE)}
    </text>
    <text x="${CARD_X + CARD_W/2}" y="${yBanner + 78}" text-anchor="middle" font-size="${winnerSize}" font-weight="800">
      ${safe(winner)}
    </text>
    ${metaDateTime ? `<text x="${CARD_X + CARD_W/2}" y="${yBanner + 112}" text-anchor="middle" font-size="22">${safe(metaDateTime)}</text>` : ''}
    ${metaChannel  ? `<text x="${CARD_X + CARD_W/2}" y="${yBanner + 142}" text-anchor="middle" font-size="22">${safe(metaChannel)}</text>` : ''}
  </g>

  <!-- “Sorteio realizado em …” (sem emoji) -->
  <text x="${CARD_X + CARD_W/2}" y="${CARD_Y + 710}" text-anchor="middle"
        font-size="20" fill="${PALETTE.meta}"
        font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Arial">
    Sorteio realizado em: ${safe(dateStr)}, ${safe(timeStr)}
  </text>

  <!-- Estatísticas -->
  <g>
    <rect x="${CARD_X + 40}"  y="${yStatsTop}" width="280" height="150" rx="20" fill="url(#stat)"/>
    <rect x="${CARD_X + 350}" y="${yStatsTop}" width="280" height="150" rx="20" fill="url(#stat)"/>
    <rect x="${CARD_X + 660}" y="${yStatsTop}" width="280" height="150" rx="20" fill="url(#stat)"/>

    <text x="${CARD_X + 180}" y="${yStatsTop + 65}" text-anchor="middle" font-size="44" font-weight="900" fill="${PALETTE.statTx}">${pCount}</text>
    <text x="${CARD_X + 180}" y="${yStatsTop + 105}" text-anchor="middle" font-size="20" fill="${PALETTE.statTx}">Participantes</text>

    <text x="${CARD_X + 490}" y="${yStatsTop + 65}" text-anchor="middle" font-size="44" font-weight="900" fill="${PALETTE.statTx}">1</text>
    <text x="${CARD_X + 490}" y="${yStatsTop + 105}" text-anchor="middle" font-size="20" fill="${PALETTE.statTx}">Ganhador</text>

    <text x="${CARD_X + 800}" y="${yStatsTop + 65}" text-anchor="middle" font-size="44" font-weight="900" fill="${PALETTE.statTx}">100%</text>
    <text x="${CARD_X + 800}" y="${yStatsTop + 105}" text-anchor="middle" font-size="20" fill="${PALETTE.statTx}">Transparência</text>
  </g>

  <rect x="0" y="${H - SAFE_BOTTOM}" width="${W}" height="${SAFE_BOTTOM}" fill="transparent"/>
</svg>`;
}

/* =========================================================
 * SVG — Quadrado 1080x1080
 * ======================================================= */
function svgSquare({
  W, H,
  productB64,
  productName,
  dateStr,
  timeStr,
  winner,
  metaDateTime,
  metaChannel,
  pCount
}) {
  const PAD = 48;
  const panelX = PAD, panelY = PAD, panelW = W - PAD * 2, panelH = H - PAD * 2;

  const titleSize  = fitFont(54, productName, [[22, -6],[28,-10],[36,-16]]);
  const winnerSize = fitFont(66, winner, [[20,-6],[28,-10],[36,-14],[48,-18]]);

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
  <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="36" fill="${PALETTE.card}" stroke="${PALETTE.cardLine}"/>

  <text x="${W/2}" y="${panelY + 50}" text-anchor="middle"
        font-family="Inter, Segoe UI, Arial" font-size="${titleSize}" font-weight="800" fill="${PALETTE.title}">
    ${safe(productName)}
  </text>

  <text x="${W/2}" y="${panelY + 98}" text-anchor="middle"
        font-family="Inter, Segoe UI, Arial" font-size="28" fill="${PALETTE.meta}">
    ${safe(dateStr)}   ${safe(timeStr)}
  </text>

  <rect x="${imgCardX}" y="${imgCardY}" width="${imgCardW}" height="${imgCardH}" rx="24"
        fill="#ffffff" stroke="#e5e7eb" stroke-width="2"/>
  <image href="data:image/png;base64,${productB64}"
         x="${imgCardX + 20}" y="${imgCardY + 20}"
         width="${imgCardW - 40}" height="${imgCardH - 40}"
         preserveAspectRatio="xMidYMid meet"/>

  <rect x="${panelX + 16}" y="${bannerY}" width="${panelW - 32}" height="230" rx="24"
        fill="${PALETTE.banner}" stroke="#f59e0b" stroke-width="2"/>

  <text x="${W/2}" y="${bannerY + 38}" text-anchor="middle"
        font-family="Inter, Segoe UI, Arial" font-size="28" font-weight="800" fill="${PALETTE.bannerTx}">
    ${safe(BANNER_TITLE)}
  </text>
  <text x="${W/2}" y="${bannerY + 92}" text-anchor="middle"
        font-family="Inter, Segoe UI, Arial" font-size="${winnerSize}" font-weight="800" fill="${PALETTE.winner}">
    ${safe(winner)}
  </text>
  ${metaDateTime ? `<text x="${W/2}" y="${bannerY + 128}" text-anchor="middle"
        font-family="Inter, Segoe UI, Arial" font-size="24" fill="${PALETTE.bannerTx}">${safe(metaDateTime)}</text>` : ''}
  ${metaChannel ? `<text x="${W/2}" y="${bannerY + 160}" text-anchor="middle"
        font-family="Inter, Segoe UI, Arial" font-size="24" fill="${PALETTE.bannerTx}">${safe(metaChannel)}</text>` : ''}

  <text x="${W/2}" y="${statsY - 24}" text-anchor="middle"
        font-family="Inter, Segoe UI, Arial" font-size="22" fill="${PALETTE.meta}">
    Sorteio realizado em: ${safe(dateStr)}, ${safe(timeStr)}
  </text>

  <g>
    <rect x="${c1X}" y="${statsY}" width="${cardW}" height="120" rx="22" fill="url(#stat)"/>
    <rect x="${c2X}" y="${statsY}" width="${cardW}" height="120" rx="22" fill="url(#stat)"/>
    <rect x="${c3X}" y="${statsY}" width="${cardW}" height="120" rx="22" fill="url(#stat)"/>

    <text x="${c1X + cardW/2}" y="${statsY + 54}" text-anchor="middle" font-family="Inter, Segoe UI, Arial" font-size="46" font-weight="900" fill="${PALETTE.statTx}">${pCount}</text>
    <text x="${c1X + cardW/2}" y="${statsY + 92}" text-anchor="middle" font-family="Inter, Segoe UI, Arial" font-size="22" fill="${PALETTE.statTx}">Participantes</text>

    <text x="${c2X + cardW/2}" y="${statsY + 54}" text-anchor="middle" font-family="Inter, Segoe UI, Arial" font-size="46" font-weight="900" fill="${PALETTE.statTx}">1</text>
    <text x="${c2X + cardW/2}" y="${statsY + 92}" text-anchor="middle" font-family="Inter, Segoe UI, Arial" font-size="22" fill="${PALETTE.statTx}">Ganhador</text>

    <text x="${c3X + cardW/2}" y="${statsY + 54}" text-anchor="middle" font-family="Inter, Segoe UI, Arial" font-size="46" font-weight="900" fill="${PALETTE.statTx}">100%</text>
    <text x="${c3X + cardW/2}" y="${statsY + 92}" text-anchor="middle" font-family="Inter, Segoe UI, Arial" font-size="22" fill="${PALETTE.statTx}">Transparência</text>
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
  // NOVOS (opcionais)
  winnerMetaDateTime,
  winnerMetaChannel,
  // retrocompat: se vier winnerMeta (string), tentamos dividir em data/hora + canal
  winnerMeta,
  participants
}) {
  const isSquare = SHAPE === 'square';
  const W = 1080;
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

  const { date, time } = splitDateTime(dateTimeStr || '');
  const pCount = participantsCount(participants);

  // retrocompat do winnerMeta (único)
  let metaDT = winnerMetaDateTime || '';
  let metaCH = winnerMetaChannel  || '';
  if ((!metaDT || !metaCH) && winnerMeta) {
    const m = String(winnerMeta).match(/(20\d{2}-\d{2}-\d{2})\s(\d{2}:\d{2}:\d{2})/);
    if (m) {
      const [yyyy, mm, dd] = m[1].split('-');
      metaDT = `Entrou na lista: ${dd}/${mm}/${String(yyyy).slice(-2)} ${m[2]}`;
    }
    const c = String(winnerMeta).match(/(WhatsApp:[^•]+|Facebook:[^•]+)/i);
    if (c) metaCH = `Acesso via: ${c[1].trim()}`;
  }

  const svg = isSquare
    ? svgSquare({
        W, H, productB64,
        productName: productName || 'Sorteio',
        dateStr: date || '', timeStr: time || '',
        winner: winner || 'Ganhador(a)',
        metaDateTime: metaDT, metaChannel: metaCH,
        pCount
      })
    : svgPortrait({
        W, H, productB64,
        productName: productName || 'Sorteio',
        dateStr: date || '', timeStr: time || '',
        winner: winner || 'Ganhador(a)',
        metaDateTime: metaDT, metaChannel: metaCH,
        pCount
      });

  const outPath = path.join(MEDIA_DIR, `poster_${Date.now()}.png`);
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return outPath;
}

module.exports = { generatePoster };
