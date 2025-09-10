// src/services/security.js
// Detector simples de "golpe/fraude" + resposta padrão.

const { normalize } = require('./text-normalizer');

function hasSecurityRisk(rawText = '') {
  const n = ` ${normalize(rawText)} `;
  const hit = [
    // palavras diretas
    'golpe', 'fraude', 'scam', 'phishing', 'link suspeito', 'link duvidoso',
    // pix/dinheiro/cobrança estranha
    'pix errado', 'pix indevido', 'cobranca estranha', 'cobranca indevida',
    'deposito', 'deposito em conta', 'dinheiro', 'premio', 'premios',
    // contato que NÃO fazemos
    'ligacao', 'chamada', 'telefone', 'live', 'ao vivo'
  ];

  for (const k of hit) {
    if (n.includes(` ${k} `)) return true;
  }

  // padrões combinados
  const hasPix = n.includes(' pix ');
  const hasErr = /errad|estranh|suspeit|duvidos|nao reconhec/.test(n);
  const hasCob = n.includes(' cobranca ');
  if ((hasPix && hasErr) || (hasCob && hasErr)) return true;

  return false;
}

function securityReply() {
  return [
    '⚠️ *Atenção com golpes*',
    '— Eu sou o atendente virtual do *Murilo Cerqueira (Natura)*. 🙂',
    '— *Não fazemos ligações* pedindo códigos, PIX ou dados sensíveis.',
    '— Desconfie de links encurtados ou que não sejam do site oficial.',
    '— Se recebeu cobrança estranha/PIX errado, *não pague* e fale com o suporte oficial:',
    'https://www.natura.com.br/ajuda-e-contato ✨'
  ].join('\n');
}

module.exports = { hasSecurityRisk, securityReply };
