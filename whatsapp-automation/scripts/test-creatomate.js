// scripts/test-creatomate.js
const path = require('path');
const { pickHeadline } = require('./whatsapp-automation/src/services/headlines');
const { pickBg, pickMusic } = require('./whatsapp-automation/src/services/media-pool');

// este serviço você já adicionou antes:
const { makeCreatomateVideo } = require('./whatsapp-automation/src/services/creatomate');

(async () => {
  try {
    const out = await makeCreatomateVideo({
      templateId: process.env.CREATOMATE_TEMPLATE_ID,   // copie do Creatomate
      headline:   pickHeadline(),                       // aleatório
      premio:     'Perfume Ilía Natura',
      winner:     'Fulana de Tal',
      participants: 248,
      productImageUrl: 'https://files.catbox.moe/fe613.png', // use um link válido do seu produto
      videoBgUrl: pickBg(),                             // aleatório
      musicUrl:   pickMusic(),                          // aleatório
      outDir: path.resolve('./data/media'),
    });
    console.log('✅ Vídeo gerado:', out);
  } catch (e) {
    console.error('❌ Falhou:', e?.response?.data || e);
    process.exit(1);
  }
})();
