// src/services/fuzzy.js
// Distância de Levenshtein simples para "promacoes", "cupun", etc.

function levenshtein(a = '', b = '') {
  a = String(a); b = String(b);
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      m[i][j] = Math.min(
        m[i - 1][j] + 1,
        m[i][j - 1] + 1,
        m[i - 1][j - 1] + cost
      );
    }
  }
  return m[a.length][b.length];
}

function fuzzyIncludes(needle, list = [], max = 1) {
  const n = String(needle || '').toLowerCase();
  let best = null;
  for (const cand of list) {
    const d = levenshtein(n, String(cand).toLowerCase());
    if (d <= max && (best === null || d < best.dist)) best = { value: cand, dist: d };
  }
  return best;
}

module.exports = { levenshtein, fuzzyIncludes };
