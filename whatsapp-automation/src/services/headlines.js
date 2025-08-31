// src/services/headlines.js
function parsePool(env, fallback) {
  if (!env) return fallback;
  try {
    if (env.trim().startsWith('[')) return JSON.parse(env);
    return env.split('|').map(s => s.trim()).filter(Boolean);
  } catch { return fallback; }
}

const DEFAULT_HEADLINES = [
  'VEJA AQUI A GANHADORA!', 'Saiu o resultado! 🎉', 'Tem ganhadora!',
  'Resultado do sorteio 👇', 'Acabou de sair!', 'Confira quem levou 🥳',
  'Encerrado! Veja quem ganhou', 'Atenção: resultado no ar', 'Hora da verdade!',
  'O prêmio tem dona!'
];

const HEADLINES = parsePool(process.env.CREATOMATE_HEADLINES, DEFAULT_HEADLINES);
const pickHeadline = () => HEADLINES[Math.floor(Math.random() * HEADLINES.length)] || DEFAULT_HEADLINES[0];

module.exports = { pickHeadline, HEADLINES };
