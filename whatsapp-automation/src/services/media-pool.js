// whatsapp-automation/src/services/media-pool.js
// Pool de músicas e vídeos de fundo. Sempre escolhemos 1 aleatório.

const MUSICS = [
  'https://files.catbox.moe/kz05mm.mp3',
  'https://files.catbox.moe/b8juzn.mp3',
  'https://files.catbox.moe/pyxx13.mp3',
  'https://files.catbox.moe/v2z08j.mp3',
  'https://files.catbox.moe/ujvd5v.mp3',
  'https://files.catbox.moe/bh9obd.mp3',
  'https://files.catbox.moe/q5mnku.mp3',
  'https://files.catbox.moe/8mbuhe.mp3',
  'https://files.catbox.moe/obw2km.mp3',
  'https://files.catbox.moe/kjerii.mp3',
];

const BGS = [
  'https://files.catbox.moe/1sxzyo.mp4',
  'https://files.catbox.moe/y128k0.mp4',
  'https://files.catbox.moe/awqmet.mp4',
  'https://files.catbox.moe/z2q9zg.mp4',
  'https://files.catbox.moe/ciwj3v.mp4',
  'https://files.catbox.moe/k2rizo.mp4',
  'https://files.catbox.moe/ofnmlk.mp4',
  'https://files.catbox.moe/j9fx5g.mp4',
  'https://files.catbox.moe/v22zl6.mp4',
  'https://files.catbox.moe/vuggub.mp4',
];

function pick(arr) {
  const i = Math.floor(Math.random() * arr.length);
  return arr[i];
}

function pickMusic() {
  return pick(MUSICS);
}

function pickBg() {
  return pick(BGS);
}

module.exports = { pickMusic, pickBg, MUSICS, BGS };
