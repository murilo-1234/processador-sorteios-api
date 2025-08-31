// whatsapp-automation/src/services/creatomate.js
// Gera um MP4 via Creatomate e baixa para /data/media.

const fs = require('fs');
const path = require('path');
const https = require('https');

const API_HOST = 'api.creatomate.com';

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function httpJson({ method, path: urlPath, apiKey, body }) {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;

  const opts = {
    method,
    hostname: API_HOST,
    path: urlPath,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };
  if (data) opts.headers['Content-Length'] = data.length;

  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (buf += chunk));
      res.on('end', () => {
        try {
          const json = buf ? JSON.parse(buf) : {};
          resolve({ status: res.statusCode, json });
        } catch (e) {
          resolve({ status: res.statusCode, json: { raw: buf } });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function httpDownload({ path: urlPath, apiKey, outPath }) {
  return new Promise((resolve, reject) => {
    const opts = {
      method: 'GET',
      hostname: API_HOST,
      path: urlPath,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    };
    const req = https.request(opts, res => {
      if (res.statusCode !== 200) {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', c => (buf += c));
        res.on('end', () =>
          reject(new Error(`Download falhou ${res.statusCode}: ${buf}`))
        );
        return;
      }
      const ws = fs.createWriteStream(outPath);
      res.pipe(ws);
      ws.on('finish', () => resolve(outPath));
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Cria um vídeo a partir do template do Creatomate.
 * Retorna o caminho do MP4 salvo.
 */
async function makeCreatomateVideo({
  templateId,
  headline,
  premio,
  winner,
  productImageUrl,
  videoBgUrl,   // opcional
  musicUrl,     // opcional
  modificationsExtra = {},
  outDir = '/data/media',
  apiKey = process.env.CREATOMATE_API_KEY,
}) {
  if (!apiKey) throw new Error('CREATOMATE_API_KEY não configurada');
  if (!templateId) templateId = process.env.CREATOMATE_TEMPLATE_ID;
  if (!templateId) throw new Error('templateId não informado');

  // Mapeia campos do seu template
  const modifications = {
    'HEADLINE.text':      headline || '',
    'PREMIO_TOP.text':    premio || '',
    'WINNER.text':        winner || '',
    'produto.image_url':  productImageUrl || '',
    // opcionais
    ...(videoBgUrl ? { 'video_bg.video_url': videoBgUrl } : {}),
    ...(musicUrl   ? { 'musica.audio_url': musicUrl }   : {}),
    ...modificationsExtra,
  };

  // 1) cria render
  const { status, json } = await httpJson({
    method: 'POST',
    path: '/v2/renders',
    apiKey,
    body: { template_id: templateId, modifications },
  });
  if (status >= 400) {
    throw new Error(`Creatomate POST /renders falhou: ${status} ${JSON.stringify(json)}`);
  }
  const renderId = json?.id || json?.render_id || json?.data?.id;
  if (!renderId) throw new Error(`Não consegui obter renderId: ${JSON.stringify(json)}`);

  // 2) poll até terminar
  let info = null;
  for (;;) {
    const r = await httpJson({ method: 'GET', path: `/v2/renders/${renderId}`, apiKey });
    info = r.json;
    const st = info?.status || info?.state;
    if (st === 'succeeded' || st === 'failed' || st === 'cancelled') break;
    await sleep(2000);
  }
  if ((info?.status || info?.state) !== 'succeeded') {
    throw new Error(`Render não sucedeu: ${JSON.stringify(info)}`);
  }

  // 3) baixa
  ensureDir(outDir);
  const outPath = path.join(outDir, `creatomate_${renderId}.mp4`);
  await httpDownload({ path: `/v2/renders/${renderId}/download`, apiKey, outPath });
  return outPath;
}

module.exports = { makeCreatomateVideo };
