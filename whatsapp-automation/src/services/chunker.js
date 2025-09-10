// src/services/chunker.js
// Split em blocos respeitando frases, URLs e notações tipo "50%".
// Evita blocos de 1–2 palavras (anti-órfão).

const DEFAULT_TARGET = Number(process.env.MAX_CHUNK_CHARS || 680);
const MAX_BLOCKS = Number(process.env.SPLIT_MAX_BLOCKS || 4);

const URL_RE = /(https?:\/\/[^\s]+)/i;

function normalizeNaturaLinks(t) {
  let out = String(t || '');
  out = out.replace(/https:\/\/www\.natura\.com[,\s]*br\//gi, 'https://www.natura.com.br/');
  out = out.replace(/(https?:\/\/[^\s,.;]+)[,.;]+/g, '$1');
  return out;
}

function splitText(txt) {
  const norm = normalizeNaturaLinks(txt);
  const t = String(norm || '').trim();
  if (!t) return [];
  if (URL_RE.test(t)) return [t]; // nunca cortar link

  // divide por frases
  const sent = t.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]|[^.!?]+$/g) || [t];

  const out = [];
  let buf = '';

  for (const s of sent) {
    const piece = s.trim();
    const cand = buf ? buf + ' ' + piece : piece;

    if (cand.length <= DEFAULT_TARGET || !buf) {
      buf = cand;
    } else {
      // evita bloco "órfão" muito curto
      if (piece.length < 20 && buf.length < DEFAULT_TARGET * 0.8) {
        buf = cand;
      } else {
        out.push(buf.trim());
        buf = piece;
        if (out.length >= MAX_BLOCKS - 1) break;
      }
    }
  }
  if (buf) out.push(buf.trim());
  return out.slice(0, MAX_BLOCKS);
}

module.exports = { splitText };
