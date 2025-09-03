// src/services/video.js
const fs = require('fs');
const path = require('path');
const https = require('https');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

const MEDIA_DIR = process.env.MEDIA_DIR || '/data/media';
fs.mkdirSync(MEDIA_DIR, { recursive: true });

function pickOneCSV(listStr) {
  if (!listStr) return null;
  const arr = String(listStr)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function ensureLocalBgPath() {
  // 1) tenta lista de env
  const fromEnv = pickOneCSV(process.env.VIDEO_BG_URLS);
  if (fromEnv) return { type: 'remote', value: fromEnv };

  // 2) tenta arquivo local opcional
  const local = path.join(__dirname, '../../public/assets/confetti.mp4');
  if (fs.existsSync(local)) return { type: 'local', value: local };

  throw new Error('Nenhum vídeo de fundo disponível. Preencha VIDEO_BG_URLS ou suba public/assets/confetti.mp4');
}

function downloadToTmp(url) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(MEDIA_DIR, `bg_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
    const file = fs.createWriteStream(tmp);
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        return reject(new Error(`Falha ao baixar BG ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(tmp)));
    }).on('error', (e) => {
      try { fs.unlinkSync(tmp); } catch {}
      reject(e);
    });
  });
}

/**
 * Gera um MP4 curto com poster sobre vídeo de fundo.
 * @param {object} cfg
 * @param {string} cfg.posterPath  - caminho do PNG gerado (obrigatório)
 * @param {number} [cfg.duration]  - segundos (padrão 7)
 * @param {string} [cfg.res]       - ex: '720x1280' (padrão env VIDEO_RES ou '1080x1350')
 * @param {string} [cfg.bitrate]   - ex: '1000k' (padrão env VIDEO_BITRATE ou '2000k')
 * @returns {Promise<string>} caminho do mp4
 */
async function makeOverlayVideo({ posterPath, duration, res, bitrate }) {
  if (!posterPath || !fs.existsSync(posterPath)) {
    throw new Error('posterPath inválido');
  }

  const DURATION = Number(duration || process.env.VIDEO_DURATION || 7);
  const RES = (res || process.env.VIDEO_RES || '1080x1350').replace('×', 'x');
  const BITRATE = (bitrate || process.env.VIDEO_BITRATE || '2000k');

  const outPath = path.join(MEDIA_DIR, `winner_${Date.now()}.mp4`);

  // Escolhe/baixa BG
  const bgSel = ensureLocalBgPath();
  let bgPath = bgSel.value;
  let cleanup = null;

  if (bgSel.type === 'remote') {
    bgPath = await downloadToTmp(bgSel.value);
    cleanup = () => { try { fs.unlinkSync(bgPath); } catch {} };
  }

  // Filtro: scale + trim no BG, scale do poster, overlay central, yuv420p
  const filter = [
    `[0:v]scale=${RES}:force_original_aspect_ratio=cover,setsar=1,fps=25,trim=0:${DURATION},setpts=PTS-STARTPTS[v0];` +
    `[1:v]scale=${RES}:force_original_aspect_ratio=contain,setsar=1[ov];` +
    `[v0][ov]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p`
  ];

  // Execução “econômica”
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(bgPath)
      .input(posterPath)
      .complexFilter(filter)
      .videoCodec('libx264')
      .videoBitrate(BITRATE)
      .outputOptions([
        '-preset', 'veryfast',
        '-movflags', '+faststart',
        '-pix_fmt', 'yuv420p',
        '-r', '25',
        '-threads', '1',
        '-shortest'
      ])
      .noAudio()
      .duration(DURATION)
      .on('end', () => {
        if (cleanup) cleanup();
        resolve(outPath);
      })
      .on('error', (err) => {
        if (cleanup) cleanup();
        reject(err);
      })
      .save(outPath);
  });
}

module.exports = { makeOverlayVideo };
