const axios = require('axios');
const cheerio = require('cheerio');

// Palavras comuns que NÃO são cupom
const BLACKLIST = new Set([
  'VEJA', 'MEUS', 'CUPOM', 'CUPONS', 'SORTEIO', 'ENTRE', 'ATENDIMENTO',
  'ENVIE', 'HOJE', 'VALIDO', 'VÁLIDO', 'PROCURE', 'AJUDA', 'PROBLEMAS',
  'LINK', 'SITE', 'NATURA', 'MURILO'
]);

/**
 * Extrai até `max` cupons a partir do HTML do Clubemac.
 * Prioriza padrões "PEGA*" e faz fallback para códigos em caixa alta 4..12 chars filtrando blacklist.
 */
async function fetchCoupons(max = 2) {
  try {
    const { data: html } = await axios.get('https://clubemac.com.br/cupons/', {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SorteiosBot/1.0)',
        'Accept': 'text/html'
      }
    });

    const $ = cheerio.load(html);

    // 1) Tenta capturar a partir de atributos/comuns de "copiar cupom"
    const attrCandidates = new Set();
    $('[data-clipboard-text], [data-copy], [data-coupon-code], .coupon-code, code').each((_i, el) => {
      const v =
        $(el).attr('data-clipboard-text') ||
        $(el).attr('data-copy') ||
        $(el).attr('data-coupon-code') ||
        $(el).text();
      const s = String(v || '').trim().toUpperCase();
      if (s && s.length >= 4 && s.length <= 12) attrCandidates.add(s);
    });

    // 2) Varredura por padrão "PEGA*" (ex.: PEGAP, PEGAQ…), mantendo ordem de aparição
    const text = $('body').text().toUpperCase();
    const pegaMatches = [...text.matchAll(/\bPEGA[A-Z0-9]{1,8}\b/g)].map(m => m[0]);

    const ordered = [];
    const pushOrdered = (code) => {
      const c = String(code || '').toUpperCase().trim();
      if (!c) return;
      if (BLACKLIST.has(c)) return;
      if (!/^[A-Z0-9]{4,12}$/.test(c)) return;
      if (!ordered.includes(c)) ordered.push(c);
    };

    // prioridade: atributos -> PEGA* -> fallback genérico
    for (const c of attrCandidates) pushOrdered(c);
    for (const c of pegaMatches) pushOrdered(c);

    if (ordered.length < max) {
      // 3) Fallback genérico (qualquer "palavra" 4..12 caracteres em caixa alta),
      // filtrando blacklist e evitando números "soltos".
      const generic = [...text.matchAll(/\b[A-Z0-9]{4,12}\b/g)].map(m => m[0]);
      for (const c of generic) pushOrdered(c);
    }

    const out = ordered.slice(0, Math.max(1, max));
    if (out.length) return out;
  } catch (_) {
    // ignora e cai no fallback
  }

  // Fallback final: cupom padrão
  const def = String(process.env.DEFAULT_COUPON || 'CLUBEMAC').toUpperCase();
  return [def].slice(0, Math.max(1, max));
}

/** Retorna os cupons em texto amigável, ex.: "PEGAP" ou "PEGAP ou PEGAQ" */
async function fetchCouponsText(max = 2, sep = ' ou ') {
  const list = await fetchCoupons(max);
  return list.length > 1 ? `${list[0]}${sep}${list[1]}` : list[0];
}

/** Retrocompat: devolve só o 1º cupom (mantém quem já usa) */
async function fetchFirstCoupon() {
  const list = await fetchCoupons(1);
  return list[0];
}

module.exports = {
  fetchCoupons,
  fetchCouponsText,
  fetchFirstCoupon,
  fetchTopCoupons: fetchCoupons // alias p/ compat com post-winner.js
};
