const { renderCreatomate } = require('../src/services/creatomate');

(async () => {
  try {
    const path = await renderCreatomate({
      apiKey: process.env.CREATOMATE_API_KEY,
      templateId: process.env.CREATOMATE_TEMPLATE_ID,
      modifications: {
        'HEADLINE.text': 'Teste automático',
        'PREMIO_TOP.text': 'Perfume Humor',
        'WINNER.text': 'Fulana Teste',
        // troque por URLs do Catbox
        'produto.image_url': process.env.TEST_PRODUCT_IMG || 'https://files.catbox.moe/xxxxx.png',
        'video_bg.video_url': process.env.CREATOMATE_BG_URL,
        'musica.audio_url': process.env.CREATOMATE_AUDIO_URL,
        'musica.audio_fade_out': 1
      },
      basename: 'creatomate-test'
    });
    console.log('Arquivo gerado em:', path);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
