// src/services/media.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const axios = require('axios');

const MEDIA_DIR = process.env.MEDIA_DIR || '/data/media';
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------- helpers ----------
async function downloadToBuffer(url) {
  const { data } = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    // user-agent evita alguns CDNs bloquearem
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SorteiosBot/1.0)' }
  });
  return Buffer.from(data);
}

// escapa texto para SVG
function safe(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// reduz Fonte se o texto ficar muito grande
function fitFont(base, text, maxCharsSteps = [
  [26, -6],  // se passar de 26 chars, reduz 6px
  [32, -10], // >32 reduz +10px no total
  [40, -14], // >40 reduz +14px
]) {
  const len = (text || '').length;
  let delta = 0;
  for (const [limit, dec] of maxCharsSteps) {
    if (len > limit) delta = dec;
  }
  return Math.max(18, base + delta);
}

// cores (você pode ajustar via ENV se quiser)
const COLORS = {
  bg1: '#6a7bd6',   // gradiente externo
  bg2: '#7c5ed9',
  card: '#f8fafc',
  cardBorder: '#eef2f7',
  title: '#111827',
  meta: '#374151',
  banner: '#ffd200',
  bannerText: '#1f2937',
  winner: '#1f2937',
  sub: '#374151',
  chip: '#111827',
  statFrom: '#7b5fe0',
  statTo: '#5678e9',
  statText: '#ffffff'
};

// monta todo o SVG já com a imagem do produto embutida
function buildResultSVG({
  W, H,
  productB64,
  productName,
  dateStr,
  timeStr,
  winner,
  participants
}) {
  // dimensões do “cartão” (a área branca central)
  const CARD_W = 980;
  const CARD_H = 1120;
  const CARD_X = (W - CARD_W) / 2;   // centraliza
  const CARD_Y = 90;                 // deixa respiro em cima
  const SAFE_BOTTOM = 80;            // respiro inferior (evita overlay do WA)

  // tipografia com ajuste
  const titleSize   = fitFont(44, productName);
  const winnerSize  = fitFont(56, winner, [[20, -6],[28, -10],[36,-16],[44,-20]]);

  const productBoxW = 300;
  const productBoxH = 300;

  return `
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="${COLORS.bg1}"/>
      <stop offset="1" stop-color="${COLORS.bg2}"/>
    </linearGradient>
    <linearGradient id="stat" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${COLORS.statFrom}"/>
      <stop offset="1" stop-color="${COLORS.statTo}"/>
    </linearGradient>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="20" flood-color="#000" flood-opacity="0.15"/>
    </filter>
  </defs>

  <!-- Fundo -->
  <rect width="100%" height="100%" fill="url(#bg)"/>

  <!-- Cartão branco central -->
  <g filter="url(#softShadow)">
    <rect x="${CARD_X}" y="${CARD_Y}" width="${CARD_W}" height="${CARD_H}" rx="24" fill="${COLORS.card}" stroke="${COLORS.cardBorder}"/>
  </g>

  <!-- Título -->
  <text x="${CARD_X + 40}" y="${CARD_Y + 70}" font-size="${titleSize}" font-weight="800" fill="${COLORS.title}" font-family="system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial">
    ${safe(productName)}
  </text>

  <!-- Data e hora -->
  <g font-family="system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial" fill="${COLORS.meta}" font-size="22" font-weight="600">
    <text x="${CARD_X + 40}" y="${CARD_Y + 110}">📅 ${safe(dateStr)}</text>
    <text x="${CARD_X + 200}" y="${CARD_Y + 110}">🕒 ${safe(timeStr)}</text>
  </g>

  <!-- Imagem do produto (quadrado no centro) -->
  <image
    href="data:image/png;base64,${productB64}"
    x="${CARD_X + (CARD_W - productBoxW)/2}"
    y="${CARD_Y + 140}"
    width="${productBoxW}" height="${productBoxH}"
    preserveAspectRatio="xMidYMid meet"
  />

  <!-- Banner de GANHADOR -->
  <rect x="${CARD_X + 30}" y="${CARD_Y + 480}" width="${CARD_W - 60}" height="80" rx="16" fill="${COLORS.banner}"/>
  <text x="${CARD_X + CARD_W/2}" y="${CARD_Y + 535}" text-anchor="middle"
        font-size="34" font-weight="900" fill="${COLORS.bannerText}"
        font-family="system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial">
    🎉  GANHADOR DO SORTEIO!  🎉
  </text>

  <!-- Nome do(a) vencedor(a) -->
  <text x="${CARD_X + CARD_W/2}" y="${CARD_Y + 620}" text-anchor="middle"
        font-size="${winnerSize}" font-weight="800" fill="${COLORS.winner}"
        font-family="system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial">
    ${safe(winner)}
  </text>

  <!-- Mensagem -->
  <text x="${CARD_X + CARD_W/2}" y="${CARD_Y + 660}" text-anchor="middle"
        font-size="24" fill="${COLORS.sub}"
        font-family="system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial">
    Parabéns! Você ganhou ${safe(productName)}!
  </text>

  <!-- “Sorteio realizado em …” -->
  <g font-family="system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial" fill="${COLORS.meta}" font-size="20">
    <text x="${CARD_X + CARD_W/2}" y="${CARD_Y + 690}" text-anchor="middle">🟡 Sorteio realizado em: ${safe(dateStr)}, ${safe(timeStr)}</text>
  </g>

  <!-- Estatísticas (3 cards) -->
  <g>
    <!-- Participantes -->
    <rect x="${CARD_X + 40}" y="${CARD_Y + 740}" width="280" height="150" rx="20" fill="url(#stat)"/>
    <text x="${CARD_X + 180}" y="${CARD_Y + 805}" text-anchor="middle" font-size="44" font-weight="900" fill="${COLORS.statText}" font-family="system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial">${Number(participants||0)}</text>
    <text x="${CARD_X + 180}" y="${CARD_Y + 845}" text-anchor="middle" font-size="20" fill="${COLORS.statText}" font-family="system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial">Participantes</text>

    <!-- Ganhador -->
    <rect x="${CARD_X + 350}" y="${CARD_Y + 740}" width="280" height="150" rx="20" fill="url(#stat)"/>
    <text x="${CARD_X + 490}" y="${CARD_Y + 805}" text-anchor="middle" font-size="44" font-weight="900" fill="${COLORS.statText}" font-family="system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial">1</text>
    <text x="${CARD_X + 490}" y="${CARD_Y + 845}" text-anchor="middle" font-size="20" fill="${COLORS.statText}" font-family="system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial">Ganhador</text>

    <!-- Transparência -->
    <rect x="${CARD_X + 660}" y="${CARD_Y + 740}" width="280" height="150" rx="20" fill="url(#stat)"/>
    <text x="${CARD_X + 800}" y="${CARD_Y + 805}" text-anchor="middle" font-size="44" font-weight="900" fill="${COLORS.statText}" font-family="system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial">100%</text>
    <text x="${CARD_X + 800}" y="${CARD_Y + 845}" text-anchor="middle" font-size="20" fill="${COLORS.statText}" font-family="system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial">Transparência</text>
  </g>

  <!-- Respiro inferior (área “inútil”) -->
  <rect x="0" y="${H - SAFE_BOTTOM}" width="${W}" height="${SAFE_BOTTOM}" fill="transparent"/>
</svg>
`;
}

async function generatePoster({
  productImageUrl,
  productName,
  dateTimeStr,   // "dd/MM/yyyy às HH:mm"
  winner,
  participants
}) {
  // dimensões retrato do WhatsApp/Facebook
  const W = 1080, H = 1350;

  // baixa/normaliza imagem do produto (ou gera placeholder)
  let productBuf = null;
  try {
    if (productImageUrl) productBuf = await downloadToBuffer(productImageUrl);
  } catch {}
  if (!productBuf) {
    productBuf = await sharp({
      create: { width: 600, height: 600, channels: 4, background: '#eee' }
    }).png().toBuffer();
  }
  // converte para PNG com fundo branco (evita png com transparência “sumir”)
  const normalized = await sharp(productBuf)
    .resize(600, 600, { fit: 'inside', withoutEnlargement: true, background: '#ffffff' })
    .flatten({ background: '#ffffff' }) // remove alpha
    .png()
    .toBuffer();

  const productB64 = normalized.toString('base64');

  // quebra “dd/MM/yyyy às HH:mm” em data/hora para exibir igual à página
  let dateStr = dateTimeStr || '';
  let timeStr = '';
  if (dateStr.includes(' às ')) {
    const [d, t] = dateStr.split(' às ');
    dateStr = d;
    timeStr = t;
  }

  const svg = buildResultSVG({
    W, H,
    productB64,
    productName: productName || 'Sorteio',
    dateStr: dateStr || '',
    timeStr: timeStr || '',
    winner: winner || 'Ganhador(a)',
    participants: Number(participants || 0)
  });

  const outPath = path.join(MEDIA_DIR, `poster_${Date.now()}.png`);
  await sharp(Buffer.from(svg))
    .png()
    .toFile(outPath);

  return outPath;
}

module.exports = { generatePoster };
