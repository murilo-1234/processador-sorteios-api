const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

const MEDIA_DIR = process.env.MEDIA_DIR || '/data/media';
fs.mkdirSync(MEDIA_DIR, { recursive: true });

ffmpeg.setFfmpegPath(ffmpegPath);

function ensureConfettiPath() {
  const local = path.join(__dirname, '../../public/assets/confetti.mp4');
  if (fs.existsSync(local)) return local;
  throw new Error('confetti.mp4 não encontrado em public/assets/. Suba esse arquivo.');
}

async function makeOverlayVideo({ posterPath, duration = 7, res = '1080x1350', bitrate = '2000k' }) {
  const outPath = path.join(MEDIA_DIR, `winner_${Date.now()}.mp4`);
  const confetti = ensureConfettiPath();

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(confetti)
      .input(posterPath)
      .complexFilter([
        `[0:v]scale=${res},setsar=1,trim=0:${duration},setpts=PTS-STARTPTS[v0];` +
        `[1:v]scale=${res},setsar=1[ov];` +
        `[v0][ov]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2:shortest=1,format=yuv420p`
      ])
      .videoBitrate(bitrate)
      .noAudio()
      .outputOptions(['-movflags +faststart'])
      .duration(duration)
      .save(outPath)
      .on('end', () => resolve(outPath))
      .on('error', reject);
  });
}

module.exports = { makeOverlayVideo };
