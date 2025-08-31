// whatsapp-automation/scripts/test-creatomate.js
const fs = require('fs');
const path = require('path');

function pickOneCsv(csv) {
  if (!csv) return null;
  const items = String(csv)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!items.length) return null;
  return items[Math.floor(Math.random() * items.length)];
}

// ---- picks com fallback às envs ----
let pickHeadline = () => pickOneCsv(process.env.HEADLINES) || 'VEJA AQUI A GANHADORA!';
let pickBg = () => pickOneCsv(process.env.VIDEO_BG_URLS) || null;
let pickMusic = () => pickOneCsv(process.env.AUDIO_URLS) || null;

// se os serviços existirem, usamos eles; senão, seguimos com os fallbacks
try { ({ pickHeadline } = require('../src/services/headlines')); } catch {}
try {
  const pool = require('../src/services/media-pool');
  if (typeof pool.pickBg === 'function') pickBg = pool.pickBg;
  if (typeof pool.pickMusic === 'function') pickMusic = pool.pickMusic;
} catch {}

// serviço do Creatomate (o mesmo usado pelo post-winner)
const { makeCreatomateVideo } = require('../src/services/creatomate');

async function main() {
  const templateId = process.env.CREATOMATE_TEMPLATE_ID;
  const apiKey = process.env.CREATOMATE_API_KEY;

  if (!templateId || !apiKey) {
    console.error('Faltam variáveis: CREATOMATE_API_KEY e/ou CREATOMATE_TEMPLATE_ID.');
    process.exit(1);
  }

  // valores de teste (troque se quiser)
  const headline = pickHeadline();
  const premio   = process.env.TEST_PREMIO  || 'Perfume de Teste';
  const winner   = process.env.TEST_WINNER  || 'Ganhador(a)';
  const productImageUrl = process.env.TEST_IMAGE ||
    'https://files.catbox.moe/1e0eag.png'; // qualquer imagem pública pra testar

  const videoBgUrl = pickBg();
  const musicUrl   = pickMusic();

  const outDir = path.join(__dirname, '..', 'data', 'media');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('⏳ Enviando render pro Creatomate...');
  console.log({ headline, premio, winner, productImageUrl, videoBgUrl, musicUrl });

  const outPath = await makeCreatomateVideo({
    templateId,
    headline,
    premio,
    winner,
    participants: [],
    productImageUrl,
    videoBgUrl,
    musicUrl,
    outDir,                // opcional; se o seu serviço já define, pode omitir
    apiKey,                // opcional; caso seu serviço já leia de process.env
  });

  console.log('✅ Vídeo gerado:', outPath);
}

main().catch((e) => {
  console.error('Erro no teste:', e);
  process.exit(1);
});
