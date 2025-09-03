// src/services/media.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const axios = require('axios');

const MEDIA_DIR = process.env.MEDIA_DIR || '/data/media';
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---- helpers ---------------------------------------------------------------

async function downloadToBuffer(url) {
  const { data } = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    // às vezes servidores recusam sem UA:
    headers: { 'User-Agent': 'Mozilla/5.0 poster-bot' },
  });
  return Buffer.from(data);
}

function parseRes(str, defW, defH) {
  const m = String(str || '').match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!m) return { W: defW, H: defH };
  const W = Math.max(100, parseInt(m[1], 10));
  const H = Math.max(100, parseInt(m[2], 10));
  return { W, H };
}

function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- SVGs separados: background e textos ----------------------------------

// Apenas o fundo em gradiente (fica por baixo de tudo)
function svgBackground({ width, height }) {
  const primary = process.env.BRAND_PRIMARY || '#0ea5e9';
  const secondary = process.env.BRAND_SECONDARY || '#111827';
  return Buffer.from(`
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bgG" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${esc(secondary)}"/>
      <stop offset="1" stop-color="${esc(primary)}" stop-opacity="0.35"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bgG)"/>
</svg>`);
}

// Textos/etiquetas por cima (sem cobrir a imagem).
// Se POSTER_SHADOW=1, coloca um leve fundo apenas atrás das linhas de "stats".
function svgOverlayText({ width, height, productName, dateTime, winner, stats }) {
  const WANT_SHADOW = String(process.env.POSTER_SHADOW || '0') === '1';

  const footerY = height - 170;   // posição do primeiro texto de stats
  const bandH   = 90;             // altura da "faixa" opcional (só se WANT_SHADOW)
  const bandX   = 40;
  const bandW   = width - bandX * 2;

  return Buffer.from(`
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <g font-family="Arial, Helvetica, sans-serif">
    <text x="54" y="120" font-size="64" fill="#fff" font-weight="800">🎉 GANHADOR</text>
    <text x="54" y="195" font-size="46" fill="#e2e8f0" font-weight="700">${esc(winner)}</text>
    <text x="54" y="270" font-size="30" fill="#cbd5e1">${esc(productName)}</text>
    <text x="54" y="320" font-size="26" fill="#cbd5e1">${esc(dateTime)}</text>

    ${WANT_SHADOW ? `
      <rect x="${bandX}" y="${footerY - 40}" rx="14"
            width="${bandW}" height="${bandH}"
            fill="#0b1220" opacity="0.35"/>
    ` : ''}

    <text x="64" y="${footerY}" font-size="26" fill="#93c5fd">
      Participantes: ${Number(stats?.participants || 0)}
    </text>
    <text x="64" y="${footerY + 40}" font-size="26" fill="#93c5fd">
      Ganhadores: 1  •  100% Transparência
    </text>
  </g>
</svg>`);
}

// ---- Poster principal ------------------------------------------------------

/**
 * Gera uma imagem PNG (poster) com:
 *  - fundo em gradiente (bg)
 *  - imagem do produto centralizada
 *  - textos por cima (sem sombra/banda cobrindo a imagem)
 *
 * ENV opcionais:
 *  - MEDIA_DIR (onde salvar)
 *  - POSTER_RES (ex: "1080x1350"). Se ausente, usa 1080x1350.
 *  - BRAND_PRIMARY / BRAND_SECONDARY (cores do gradiente)
 *  - POSTER_SHADOW=1 (liga uma leve faixa atrás dos "stats")
 */
async function generatePoster({ productImageUrl, productName, dateTimeStr, winner, participants }) {
  // Resolução do poster (padrão 1080x1350 – o formato vertical que você já usa)
  const { W, H } = parseRes(process.env.POSTER_RES, 1080, 1350);

  // 1) Camada de fundo (gradiente)
  const bgSvg = svgBackground({ width: W, height: H });

  // 2) Imagem do produto (centro, sem fundo sólido pra não “escurecer” nada)
  let productBuf = null;
  try {
    productBuf = await downloadToBuffer(productImageUrl);
  } catch { /* deixa nulo e usamos um placeholder */ }

  // tamanho máximo do produto no canvas
  const MAX_PW = Math.round(W * 0.75); // 75% da largura
  const MAX_PH = Math.round(H * 0.60); // 60% da altura

  const productRendered = productBuf
    ? await sharp(productBuf)
        .resize({ width: MAX_PW, height: MAX_PH, fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
    : await sharp({
        create: { width: MAX_PW, height: MAX_PH, channels: 4, background: '#1f2937' }
      }).png().toBuffer();

  // centraliza o produto horizontalmente; vertical um pouco abaixo do topo
  const prodMeta = await sharp(productRendered).metadata();
  const prodX = Math.round((W - (prodMeta.width || MAX_PW)) / 2);
  const prodY = Math.round(H * 0.28);

  // 3) Textos/etiquetas por cima
  const overlaySvg = svgOverlayText({
    width: W,
    height: H,
    productName,
    dateTime: dateTimeStr,
    winner,
    stats: { participants: participants || 0 },
  });

  // 4) Composição na ordem CORRETA:
  //    - fundo (bg) no bottom
  //    - produto no meio
  //    - textos no topo
  const outPath = path.join(MEDIA_DIR, `poster_${Date.now()}.png`);
  await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .png()
    .composite([
      { input: bgSvg,   top: 0,    left: 0 },
      { input: productRendered, top: prodY, left: prodX },
      { input: overlaySvg, top: 0, left: 0 },
    ])
    .png()
    .toFile(outPath);

  return outPath;
}

module.exports = { generatePoster };
