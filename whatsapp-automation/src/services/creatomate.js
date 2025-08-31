// src/services/creatomate.js
// Render de vídeo via Creatomate usando fetch nativo do Node 18/20
const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.creatomate.com/v2';

function pickOne(listStr) {
  if (!listStr) return null;
  const arr = String(listStr)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

async function httpJson(method, url, key, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
  }
  return res.json();
}

async function pollUntilDone(id, key, timeoutMs = 120000) {
  const started = Date.now();
  while (true) {
    const data = await httpJson('GET', `${API_BASE}/renders/${id}`, key);
    const status = (data.status || '').toLowerCase();
    if (status === 'succeeded' || status === 'success' || status === 'completed') {
      // vários nomes possíveis, usamos os mais comuns
      const u = data.download_url || data.url || data.result_url;
      if (!u) throw new Error('Render ok mas sem download_url');
      return u;
    }
    if (status === 'failed' || status === 'error') {
      throw new Error(`Render ${id} falhou: ${data.error || data.message || 'desconhecido'}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timeout aguardando render ${id}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function downloadToFile(fileUrl, outPath) {
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`GET ${fileUrl} -> ${res.status}`);
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

  const file = fs.createWriteStream(outPath);
  await new Promise((resolve, reject) => {
    res.body.pipe(file);
    res.body.on('error', reject);
    file.on('finish', resolve);
  });
  return outPath;
}

/**
 * Gera vídeo pelo Creatomate.
 * Espera que o template tenha elementos:
 *  - HEADLINE, PREMIO, WINNER, PREMIO_TOP (text)
 *  - produto (image), video_bg (video), musica (audio)
 */
async function makeCreatomateVideo({
  templateId,
  headline,
  premio,
  winner,
  participants,             // número
  productImageUrl,          // imagem do produto
  videoBgUrl,               // vídeo de fundo
  musicUrl,                 // trilha
  outDir = process.env.MEDIA_DIR || path.join(__dirname, '../../data/media'),
  filename = `creatomate_${Date.now()}.mp4`,
}) {
  const key = process.env.CREATOMATE_API_KEY;
  if (!key) throw new Error('CREATOMATE_API_KEY não configurada');
  if (!templateId) throw new Error('Template ID não informado');

  // pega random se não vier explícito
  const bg = videoBgUrl || pickOne(process.env.VIDEO_BG_URLS);
  const au = musicUrl  || pickOne(process.env.AUDIO_URLS);

  // monta as modificações
  const modifications = {};

  if (headline)  modifications['HEADLINE.text']  = String(headline);
  if (premio)    modifications['PREMIO.text']    = String(premio);
  if (winner)    modifications['WINNER.text']    = String(winner);
  if (participants != null) {
    modifications['PREMIO_TOP.text'] = `Foram ${participants} participantes`;
  }

  if (productImageUrl) modifications['produto.source'] = String(productImageUrl);
  if (bg)              modifications['video_bg.source'] = String(bg);
  if (au)              modifications['musica.source'] = String(au);

  // um ajuste útil comum no áudio
  modifications['musica.audio_fade_out'] = 1;

  // 1) cria o render
  const create = await httpJson('POST', `${API_BASE}/renders`, key, {
    template_id: templateId,
    modifications,
  });

  // a API pode retornar { id, ... } ou { renders: [ { id } ] }
  const renderId =
    create?.id ||
    create?.render_id ||
    (Array.isArray(create?.renders) && create.renders[0]?.id);
  if (!renderId) throw new Error(`Resposta inesperada: ${JSON.stringify(create)}`);

  // 2) aguarda conclusão
  const url = await pollUntilDone(renderId, key,
    Number(process.env.CREATOMATE_TIMEOUT_SECONDS || 180) * 1000
  );

  // 3) baixa o arquivo
  const outPath = path.join(outDir, filename);
  await downloadToFile(url, outPath);
  return outPath;
}

module.exports = { makeCreatomateVideo };
