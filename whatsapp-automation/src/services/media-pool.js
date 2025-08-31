// src/services/media-pool.js
function parsePool(env, fallback) {
  if (!env) return fallback;
  try {
    if (env.trim().startsWith('[')) return JSON.parse(env);
    return env.split('|').map(s => s.trim()).filter(Boolean);
  } catch { return fallback; }
}
// coloque aqui 10 vídeos/músicas (URLs públicas) ou use ENV
const DEFAULT_BG = [
  // 'https://meus-arquivos/bg1.mp4', 'https://.../bg2.mp4', ...
];
const DEFAULT_MUSIC = [
  // 'https://meus-arquivos/music1.mp3', 'https://.../music2.mp3', ...
];

const BG_POOL    = parsePool(process.env.CREATOMATE_BG_POOL, DEFAULT_BG);
const MUSIC_POOL = parsePool(process.env.CREATOMATE_MUSIC_POOL, DEFAULT_MUSIC);

const pick = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null);

module.exports = {
  pickBg:    () => pick(BG_POOL),
  pickMusic: () => pick(MUSIC_POOL),
  BG_POOL,
  MUSIC_POOL,
};
