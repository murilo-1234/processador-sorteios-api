// whatsapp-automation/src/services/creatomate.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { MEDIA_DIR } = require('./media'); // já existe no seu projeto

const API = 'https://api.creatomate.com/v2';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Renderiza no Creatomate e baixa o MP4 localmente.
 * @returns {Promise<string>} caminho local do mp4
 */
async function renderCreatomate({ apiKey, templateId, modifications, basename = 'creatomate' }) {
  if (!apiKey) throw new Error('Missing Creatomate API key');
  if (!templateId) throw new Error('Missing Creatomate template id');

  // 1) cria o render
  const { data: render } = await axios.post(`${API}/renders`,
    { template_id: templateId, modifications },
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, timeout: 60000 }
  );

  const id = render.id || render.render_id || render.uid;
  if (!id) throw new Error('Unable to get render id from Creatomate');

  // 2) faz polling até terminar
  let url, status = render.status;
  for (let i = 0; i < 120; i++) {
    const { data } = await axios.get(`${API}/renders/${id}`, {
      headers: { Authorization: `Bearer ${apiKey}` }, timeout: 30000
    });
    status = (data.status || data.state || '').toLowerCase();
    url = data.url || url;
    if (['finished', 'succeeded', 'completed'].includes(status) && url) break;
    if (status.includes('error') || status.includes('failed')) throw new Error(`Creatomate render failed: ${status}`);
    await wait(2000);
  }
  if (!url) throw new Error(`Creatomate render not ready, status=${status}`);

  // 3) baixa o arquivo
  const out = path.join(MEDIA_DIR, `${basename}-${Date.now()}.mp4`);
  const response = await axios.get(url, { responseType: 'stream' });
  await new Promise((resolve, reject) => {
    response.data.pipe(fs.createWriteStream(out)).on('finish', resolve).on('error', reject);
  });
  return out;
}

module.exports = { renderCreatomate };
