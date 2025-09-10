// src/services/text-normalizer.js
// Normaliza texto para classificação: minúsculas, sem acentos, sem ruído.
// Também oferece util pra higienizar nomes.

function removeDiacritics(s = '') {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalize(text = '') {
  // mantém dígitos e letras; troca pontuação por espaço; colapsa espaços
  let s = String(text || '');
  // preserva emojis para "obrigado" com 🙏/❤️ (detecção ocorre no raw)
  s = s.toLowerCase();
  s = removeDiacritics(s);
  s = s.replace(/[_*~`"'“”‘’()[\]{}<>=+^%$#@|\\]/g, ' ');
  s = s.replace(/[.,;:!?]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  // correções pontuais comuns em PT-BR/WhatsApp
  const repl = [
    [' qdo ', ' quando '],
    [' qnd ', ' quando '],
    [' qd ', ' quando '],
    [' pq ', ' porque '],
    [' tb ', ' tambem '],
    [' rsto ', ' rosto '],  // pedido seu
    [' inves ', ' em vez '],
    [' ligacao ', ' ligacao '], // já normalizado sem acento
  ];
  s = ` ${s} `;
  for (const [a, b] of repl) s = s.replaceAll(a, b);
  s = s.trim();
  return s;
}

function hasWord(normText, word) {
  const w = removeDiacritics(String(word || '').toLowerCase());
  const re = new RegExp(`(^|\\s)${w}(\\s|$)`);
  return re.test(normText);
}

// Higieniza o primeiro nome do usuário para saudação
function sanitizeFirstName(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return null;
  // remove emojis/símbolos
  let t = s.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');
  t = t.replace(/[^\p{L}\p{M}\-'\s]/gu, '').trim(); // só letras/acentos/apóstrofo/hífen
  if (!t) return null;
  const first = t.split(/\s+/)[0]; // primeira palavra (preserva hífen)
  if (!first || first.length < 2) return null;
  // capitaliza primeira letra
  return first.charAt(0).toUpperCase() + first.slice(1);
}

module.exports = { normalize, removeDiacritics, hasWord, sanitizeFirstName };
