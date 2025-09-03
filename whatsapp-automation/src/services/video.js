// src/services/video.js
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

const MEDIA_DIR = process.env.MEDIA_DIR || '/data/media';
fs.mkdirSync(MEDIA_DIR, { recursive: true });

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobePath) ffmpeg.setFfprobePath(ffprobePath);

// util: escolhe 1 item aleatório de uma CSV env
function pickOneCSV(listStr) {
  if (!listStr) return null;
  const arr = String(listStr)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
}

/**
 * Gera um MP4 sobrepondo o poster PNG em um vídeo de fundo (URL ou arquivo).
 * Pode opcionalmente adicionar uma trilha de música (URL ou arquivo).
 *
 * @param {object} params
 * @param {string} params.posterPath  Caminho do PNG do poster (obrigatório)
 * @param {number} [params.duration=7]
 * @param {string} [params.res='1080x1350']
 * @param {string} [params.bitrate='2000k']
 * @param {string} [params.bg]        URL/caminho do vídeo de fundo (opcional; se não vier, usa VIDEO_BG_URLS)
 * @param {string} [params.music]     URL/caminho da música (opcional; se não vier, nada de áudio)
 * @returns {Promise<string>} caminho do MP4 gerado
 */
async function makeOverlayVideo({
  posterPath,
  duration = 7,
  res = '1080x1350',
  bitrate = '2000k',
  bg,
  music,
}) {
  if (!posterPath || !fs.existsSync(posterPath)) {
    throw new Error(`Poster inexistente: ${posterPath}`);
  }

  // Escolhe bg se não veio por parâmetro
  const bgInput = bg || pickOneCSV(process.env.VIDEO_BG_URLS);
  if (!bgInput) throw new Error('Nenhum vídeo de fundo informado (param "bg" ou env VIDEO_BG_URLS).');

  const outPath = path.join(MEDIA_DIR, `winner_${Date.now()}.mp4`);

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(bgInput)      // 0:v
      .input(posterPath);  // 1:v

    if (music) {
      cmd.input(music);   // 2:a (opcional; pode ser URL)
    }

    // Produz [vout] como vídeo final
    const vf =
      `[0:v]scale=${res},setsar=1,trim=0:${duration},setpts=PTS-STARTPTS[v0];` +
      `[1:v]scale=${res},setsar=1[ov];` +
      `[v0][ov]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2:shortest=1,format=yuv420p[vout]`;

    cmd
      .complexFilter([vf])
      .videoBitrate(bitrate)
      .outputOptions([
        '-map', '[vout]',
        ...(music ? ['-map', '2:a?','-c:a','aac'] : ['-an']),
        '-c:v', 'libx264',
        '-movflags', '+faststart',
        '-shortest',
      ])
      .duration(duration)
      .save(outPath)
      .on('end', () => resolve(outPath))
      .on('error', reject);
  });
}

module.exports = { makeOverlayVideo };
