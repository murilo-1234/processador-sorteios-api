// whatsapp-automation/src/services/headlines.js
// Lista de headlines aleatórias para os vídeos de ganhadores.

const HEADLINES = [
  'VEJA AQUI A GANHADORA!',
  'OLHA QUEM GANHOU!',
  'TEMOS A GANHADORA!',
  'VOCÊ GANHOU O PRÊMIO!?',
  'SURPRESA! TEM GANHADORA!',
  'OLHA QUEM GANHOU AQUI!',
  'VEJA SE VOCÊ GANHOU!',
  'PRÊMIO SAIU PRA VOCÊ!?',
  'OLHA QUEM GANHOU HOJE!',
  'PRÊMIO SAIU. FOI VOCÊ!?'
];

function pickHeadline() {
  const i = Math.floor(Math.random() * HEADLINES.length);
  return HEADLINES[i];
}

module.exports = { pickHeadline, HEADLINES };
