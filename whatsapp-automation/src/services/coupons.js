const axios = require('axios');
const cheerio = require('cheerio');

// Palavras comuns que NÃO são cupom
const BLACKLIST = new Set([
  'VEJA', 'MEUS', 'CUPOM', 'CUPONS', 'SORTEIO', 'ENTRE', 'ATENDIMENTO',
  'ENVIE', 'HOJE', 'VALIDO', 'VÁLIDO', 'PROCURE', 'AJUDA', 'PROBLEMAS',
  'LINK', 'SITE', 'NATURA', 'MURILO'
]);

// Config (com defaults seguros)
const SOURCE_URL = process.env.COUPONS_SOURCE_URL || 'https://clubemac.com.br/cupons/';
const DEFAULT_COUPON = String(process.env.DEFAULT_COUPON || 'CLUBEMAC').toUpperCase();
const CACHE_TTL = Math.max(30, Number(process.env.COUPONS_CACHE_TTL_SECONDS || 600) | 0) * 1000; // ms
const RETRIES = Math.max(0, Number(process.env.COUPONS_RETRY_ATTEMPTS || 2) | 0);

// Cache simples em memória
let _cache = { ts: 0, list: [] };
function _now() { return Date.now(); }

async function _downloadHtml() {
  const { data } = await axios.get(SOURCE_URL, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SorteiosBot/1.0)',
      'Accept': 'text/html'
    }
  });
  return String(data || '');
}

async function _fetchWithRetry() {
  let lastErr = null;
  for (let i = 0; i <= RETRIES; i++) {
    try { return await _downloadHtml(); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('fetch coupons failed');
}

/**
 * Extrai até `max` cupons a partir do HTML do Clubemac.
 * Prioriza padrões "PEGA*" e faz fallback para códigos em caixa alta 4..12 chars filtrando blacklist.
 */
async function fetchCoupons(max = 2) {
  // cache
  const now = _now();
  if (_cache.ts && now - _cache.ts < CACHE_TTL && Array.isArray(_cache.list)) {
    return _cache.list.slice(0, Math.max(1, max));
  }

  try {
    const html = await _fetchWithRetry();
    const $ = cheerio.load(html);

    // 1) Tenta capturar a partir de atributos/comuns de "copiar cupom"
    const ordered = [];
    const seen = new Set();
    const pushOrdered = (code) => {
      const c = String(code || '').toUpperCase().trim();
      if (!c) return;
      if (BLACKLIST.has(c)) return;
      if (!/^[A-Z0-9]{4,12}$/.test(c)) return;
      if (!seen.has(c)) { seen.add(c); ordered.push(c); }
    };

    $('[data-clipboard-text], [data-copy], [data-coupon-code], .coupon-code, code').each((_i, el) => {
      const v =
        $(el).attr('data-clipboard-text') ||
        $(el).attr('data-copy') ||
        $(el).attr('data-coupon-code') ||
        $(el).text();
      const s = String(v || '').trim().toUpperCase();
      if (s && s.length >= 4 && s.length <= 12) pushOrdered(s);
    });

    // 2) Varredura por padrão "PEGA*" (ex.: PEGAP, PEGAQ…), mantendo ordem de aparição
    const text = $('body').text().toUpperCase();
    const pegaMatches = [...text.matchAll(/\bPEGA[A-Z0-9]{1,8}\b/g)].map(m => m[0]);
    for (const c of pegaMatches) pushOrdered(c);

    if (ordered.length < max) {
      // 3) Fallback genérico (qualquer "palavra" 4..12 caracteres em caixa alta),
      // filtrando blacklist e evitando números "soltos".
      const generic = [...text.matchAll(/\b[A-Z0-9]{4,12}\b/g)].map(m => m[0]);
      for (const c of generic) pushOrdered(c);
    }

    const list = ordered.slice(0, Math.max(1, max));
    if (list.length) {
      _cache = { ts: now, list: ordered };
      return list;
    }
  } catch (_) {
    // ignora e cai no fallback
  }

  // Fallback final: cupom padrão (também atualiza cache para evitar bater no site a cada chamada)
  _cache = { ts: now, list: [DEFAULT_COUPON] };
  return [DEFAULT_COUPON].slice(0, Math.max(1, max));
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
  fetchTopCoupons: fetchCoupons // alias p/ compat com post-winner.js e assistant-bot.js
};
