const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

const MEDIA_DIR = process.env.MEDIA_DIR || '/data/media';
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// aponta os binários estáticos (funciona no Render)
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobePath) ffmpeg.setFfprobePath(ffprobePath);

/**
 * Garante um vídeo de fundo local (confetti).
 * Coloque o arquivo em: public/assets/confetti.mp4
 */
function ensureConfettiPath() {
  const local = path.join(__dirname, '../../public/assets/confetti.mp4');
  if (fs.existsSync(local)) return local;
  throw new Error('confetti.mp4 não encontrado em public/assets/. Suba esse arquivo.');
}

/**
 * Gera um MP4 com overlay do poster por cima do vídeo de fundo.
 * @param {object} params
 * @param {string} params.posterPath - caminho do PNG do poster (1080x1350 recomendado)
 * @param {number} [params.duration=7] - duração do vídeo (s)
 * @param {string} [params.res='1080x1350'] - resolução final
 * @param {string} [params.bitrate='2000k'] - bitrate do vídeo
 * @returns {Promise<string>} caminho do MP4 gerado
 */
async function makeOverlayVideo({
  posterPath,
  duration = 7,
  res = '1080x1350',
  bitrate = '2000k',
}) {
  if (!posterPath || !fs.existsSync(posterPath)) {
    throw new Error(`Poster inexistente: ${posterPath}`);
  }

  const outPath = path.join(MEDIA_DIR, `winner_${Date.now()}.mp4`);
  const bgPath = ensureConfettiPath();

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(bgPath)         // [0:v] fundo
      .input(posterPath)     // [1:v] poster
      .complexFilter([
        // fundo ajustado e “cortado” na duração final
        `[0:v]scale=${res},setsar=1,trim=0:${duration},setpts=PTS-STARTPTS[v0];` +
        // poster ajustado à mesma resolução
        `[1:v]scale=${res},setsar=1[ov];` +
        // overlay central + formato compatível
        `[v0][ov]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2:shortest=1,format=yuv420p`
      ])
      .videoBitrate(bitrate)
      .noAudio() // se quiser música depois dá para ligar um .input('music.mp3')
      .outputOptions(['-movflags +faststart']) // melhor para upload/play
      .duration(duration)
      .save(outPath)
      .on('end', () => resolve(outPath))
      .on('error', reject);
  });
}

module.exports = { makeOverlayVideo };
