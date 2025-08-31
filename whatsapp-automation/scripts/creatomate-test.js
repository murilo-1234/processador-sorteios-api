// scripts/test-creatomate.js
require('dotenv').config?.(); // se você usar .env local

const path = require('path');
const { makeCreatomateVideo } = require('../src/services/creatomate');

(async () => {
  try {
    const out = await makeCreatomateVideo({
      templateId: process.env.CREATOMATE_TEMPLATE_ID,
      headline: 'VEJA AQUI A GANHADORA!',
      premio: 'Humor Própria 75ml',
      winner: 'Fulana da Silva',
      participants: 257,
      productImageUrl: 'https://catbox.moe/...png', // use um URL de imagem real
      videoBgUrl: process.env.TEST_BG || null,      // opcional
      musicUrl: process.env.TEST_MUSIC || null,     // opcional
      outDir: path.join(__dirname, '../data/media'),
    });
    console.log('OK! Arquivo salvo em:', out);
  } catch (e) {
    console.error('Falhou:', e);
    process.exit(1);
  }
})();
