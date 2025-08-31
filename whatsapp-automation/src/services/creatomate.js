// whatsapp-automation/src/services/creatomate.js
// Gera um MP4 via Creatomate e baixa para /data/media.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

// Permite sobrescrever via env se um dia precisar, mas mantém o padrão correto.
const API_HOST = process.env.CREATOMATE_HOST || 'api.creatomate.com';

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpJson({ method, path: urlPath, apiKey, body }) {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;

  const opts = {
    method,
    hostname: API_HOST,
    path: urlPath,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };
  if (data) opts.headers['Content-Length'] = data.length;

  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (buf += chunk));
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

// Suporta 302 (redirect) para URL assinada
function httpDownload({ path: urlPath, apiKey, outPath, _redirects = 0 }) {
  return new Promise((resolve, reject) => {
    const opts = {
      method: 'GET',
      hostname: API_HOST,
      path: urlPath,
      headers: { Authorization: `Bearer ${apiKey}` },
    };

    const handleStreamToFile = (res) => {
      const ws = fs.createWriteStream(outPath);
      res.pipe(ws);
      ws.on('finish', () => resolve(outPath));
      ws.on('error', reject);
    };

    const req = https.request(opts, (res) => {
      // Segue redirects do endpoint /download, se ocorrerem
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location &&
        _redirects < 5
      ) {
        const loc = res.headers.location;

        // URL absoluta (ex.: S3 presigned)
        if (/^https?:\/\//i.test(loc)) {
          try {
            const u = new URL(loc);
            https
              .get(u, (r2) => {
                if (r2.statusCode !== 200) {
                  let b = '';
                  r2.setEncoding('utf8');
                  r2.on('data', (c) => (b += c));
                  r2.on('end', () =>
                    reject(
                      new Error(`Download redirect falhou ${r2.statusCode}: ${b}`)
                    )
                  );
                  return;
                }
                handleStreamToFile(r2);
              })
              .on('error', reject);
          } catch (e) {
            reject(e);
          }
          return;
        }

        // Redirect relativo
        return httpDownload({
          path: loc,
          apiKey,
          outPath,
          _redirects: _redirects + 1,
        })
          .then(resolve)
          .catch(reject);
      }

      if (res.statusCode !== 200) {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () =>
          reject(new Error(`Download falhou ${res.statusCode}: ${buf}`))
        );
        return;
      }

      handleStreamToFile(res);
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
  videoBgUrl, // opcional
  musicUrl, // opcional
  modificationsExtra = {},
  outDir = '/data/media',
  apiKey = process.env.CREATOMATE_API_KEY,
}) {
  if (!apiKey) throw new Error('CREATOMATE_API_KEY não configurada');
  if (!templateId) templateId = process.env.CREATOMATE_TEMPLATE_ID;
  if (!templateId) throw new Error('templateId não informado');

  // Campos do template
  const modifications = {
    'HEADLINE.text': headline || '',
    'PREMIO_TOP.text': premio || '',
    'WINNER.text': winner || '',
    'produto.image_url': productImageUrl || '',
    ...(videoBgUrl ? { 'video_bg.video_url': videoBgUrl } : {}),
    ...(musicUrl ? { 'musica.audio_url': musicUrl } : {}),
    ...modificationsExtra,
  };

  // 1) Cria render
  const { status, json } = await httpJson({
    method: 'POST',
    path: '/v2/renders',
    apiKey,
    body: { template_id: templateId, modifications },
  });
  if (status >= 400) {
    throw new Error(
      `Creatomate POST /v2/renders falhou: ${status} ${JSON.stringify(json)}`
    );
  }

  // Algumas respostas vêm em array
  let renderId =
    json?.id || json?.render_id || json?.data?.id || null;
  if (!renderId && Array.isArray(json) && json[0]) {
    renderId =
      json[0]?.id || json[0]?.render_id || json[0]?.data?.id || null;
  }
  if (!renderId) {
    throw new Error(`Não consegui obter renderId: ${JSON.stringify(json)}`);
  }

  // 2) Poll até terminar (timeout ~5min)
  let info = null;
  const maxTries = 150; // 150 * 2s = 300s
  for (let i = 0; i < maxTries; i++) {
    const r = await httpJson({
      method: 'GET',
      path: `/v2/renders/${renderId}`,
      apiKey,
    });
    info = r.json;

    const raw = String(info?.status || info?.state || '').toLowerCase();
    if (
      raw.includes('succeed') ||
      raw === 'success' ||
      raw === 'finished' ||
      raw === 'done'
    ) {
      break;
    }
    if (
      raw.includes('fail') ||
      raw === 'error' ||
      raw === 'cancelled' ||
      raw === 'canceled'
    ) {
      throw new Error(`Render falhou: ${JSON.stringify(info)}`);
    }
    await sleep(2000);
  }

  const final = String(info?.status || info?.state || '').toLowerCase();
  if (
    !(
      final.includes('succeed') ||
      final === 'success' ||
      final === 'finished' ||
      final === 'done'
    )
  ) {
    throw new Error(`Render não concluiu com sucesso: ${JSON.stringify(info)}`);
  }

  // 3) Baixa
  ensureDir(outDir);
  const outPath = path.join(outDir, `creatomate_${renderId}.mp4`);
  await httpDownload({
    path: `/v2/renders/${renderId}/download`,
    apiKey,
    outPath,
  });
  return outPath;
}

module.exports = { makeCreatomateVideo };
