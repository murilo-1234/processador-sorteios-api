// src/services/name-utils.js
// Higienização de nome e saudação por regra (opcional)

function cleanFirstName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  // mantém a primeira palavra (preserva hífen)
  let first = s.split(/\s+/)[0] || '';
  // remove emojis/símbolos incomuns
  first = first.replace(/[\p{Extended_Pictographic}\p{S}\p{P}]/gu, '');
  // se ficar muito curto, invalida
  if (first.length < 2) return '';
  return first;
}

function pickDisplayName(raw) {
  return cleanFirstName(raw) || '';
}

function buildRuleGreeting(firstName) {
  const has = String(firstName || '').trim();
  const who = 'Murilo Cerqueira (Natura)';
  if (has) {
    return `Olá, ${firstName}! Sou o atendente virtual do ${who}. Como posso te ajudar hoje? 🙂`;
  }
  return `Olá! Sou o atendente virtual do ${who}. Como posso te ajudar hoje? 🙂`;
}

// alias para compatibilidade com o assistant-bot.js
function buildGreeting(name) {
  return buildRuleGreeting(name);
}

module.exports = { cleanFirstName, buildRuleGreeting, buildGreeting, pickDisplayName };
