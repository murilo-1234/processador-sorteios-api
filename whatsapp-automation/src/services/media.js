// src/services/media.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const axios = require('axios');

const MEDIA_DIR = process.env.MEDIA_DIR || '/data/media';
fs.mkdirSync(MEDIA_DIR, { recursive: true });

async function downloadToBuffer(url) {
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
  return Buffer.from(data);
}

function svgText({ width, height, productName, dateTime, winner, stats }) {
  // ✅ agora "safe" é uma FUNÇÃO (antes era uma string)
  const safe = (s = '') =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  return `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${process.env.BRAND_SECONDARY || '#111827'}"/>
      <stop offset="1" stop-color="${process.env.BRAND_PRIMARY || '#0ea5e9'}" stop-opacity="0.35"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <text x="54" y="120" font-size="64" fill="#fff" font-weight="800">🎉 GANHADOR</text>
  <text x="54" y="195" font-size="46" fill="#e2e8f0" font-weight="700">${safe(winner)}</text>
  <text x="54" y="270" font-size="30" fill="#cbd5e1">${safe(productName)}</text>
  <text x="54" y="320" font-size="26" fill="#cbd5e1">${safe(dateTime)}</text>

  <rect x="54" y="${height - 230}" rx="14" width="${width - 108}" height="140" fill="#0b1220" opacity="0.6"/>
  <text x="84" y="${height - 170}" font-size="26" fill="#93c5fd">Participantes: ${stats.participants || 0}</text>
  <text x="84" y="${height - 130}" font-size="26" fill="#93c5fd">Ganhadores: 1  •  100% Transparência</text>
</svg>`;
}

async function generatePoster({ productImageUrl, productName, dateTimeStr, winner, participants }) {
  const W = 1080, H = 1350;

  const bg = Buffer.from(
    await sharp({ create: { width: W, height: H, channels: 4, background: '#0b1220' } })
      .png().toBuffer()
  );

  // imagem do produto
  let productBuf = null;
  try { productBuf = await downloadToBuffer(productImageUrl); } catch {}
  const product = productBuf
    ? await sharp(productBuf).resize(900, 900, { fit: 'inside', background: '#0b1220' }).png().toBuffer()
    : await sharp({ create: { width: 800, height: 800, channels: 4, background: '#1f2937' } }).png().toBuffer();

  const productX = Math.round((W - 900) / 2);
  const productY = 380;

  const svg = Buffer.from(svgText({
    width: W, height: H,
    productName, dateTime: dateTimeStr, winner,
    stats: { participants: participants || 0 }
  }));

  const outPath = path.join(MEDIA_DIR, `poster_${Date.now()}.png`);
  await sharp(bg)
    .composite([
      { input: product, top: productY, left: Math.max(90, productX) },
      { input: svg, top: 0, left: 0 }
    ])
    .png()
    .toFile(outPath);

  return outPath;
}

module.exports = { generatePoster };
