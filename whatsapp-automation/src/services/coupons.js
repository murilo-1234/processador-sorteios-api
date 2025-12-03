const axios = require('axios');

// ============================================
// CONFIGURAÇÃO - AGORA USA API JSON
// ============================================

// Nova API de cupons (muito mais rápida e confiável que scraping)
const API_URL = process.env.COUPONS_API_URL || 'https://natura-client-automation-1.onrender.com/api/cupons';
const DEFAULT_COUPON = String(process.env.DEFAULT_COUPON || 'CLUBEMAC').toUpperCase();
const CACHE_TTL = Math.max(30, Number(process.env.COUPONS_CACHE_TTL_SECONDS || 300) | 0) * 1000; // 5 min default

// Cache simples em memória
let _cache = { ts: 0, list: [], destaque: null, segundo: null };
function _now() { return Date.now(); }

/**
 * Busca cupons da API JSON
 * Retorna: { cupons_ativos, destaque, segundo, total_cupons, ... }
 */
async function _fetchFromAPI() {
  const { data } = await axios.get(API_URL, {
    timeout: 10000,
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'WhatsAppAutomation/1.0'
    }
  });
  return data;
}

/**
 * Busca cupons com retry
 */
async function _fetchWithRetry(retries = 2) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try { 
      return await _fetchFromAPI(); 
    }
    catch (e) { 
      lastErr = e;
      console.log(`[COUPONS] Tentativa ${i + 1} falhou: ${e.message}`);
    }
  }
  throw lastErr || new Error('fetch coupons API failed');
}

/**
 * Busca até `max` cupons da API
 * Prioriza: destaque, segundo, depois os demais
 */
async function fetchCoupons(max = 2) {
  const now = _now();
  
  // Verifica cache
  if (_cache.ts && now - _cache.ts < CACHE_TTL && Array.isArray(_cache.list) && _cache.list.length > 0) {
    console.log(`[COUPONS] Cache hit - ${_cache.list.length} cupons`);
    return _cache.list.slice(0, Math.max(1, max));
  }

  try {
    console.log(`[COUPONS] Buscando da API: ${API_URL}`);
    const apiData = await _fetchWithRetry();
    
    // Extrair cupons da resposta
    const cuponsAtivos = apiData.cupons_ativos || [];
    const destaque = apiData.destaque;
    const segundo = apiData.segundo;
    
    // Montar lista ordenada (destaque primeiro, depois segundo, depois os demais)
    const ordered = [];
    const seen = new Set();
    
    const addCoupon = (code) => {
      if (!code) return;
      const c = String(code).toUpperCase().trim();
      if (!seen.has(c)) {
        seen.add(c);
        ordered.push(c);
      }
    };
    
    // Prioridade: destaque > segundo > demais
    if (destaque) addCoupon(destaque);
    if (segundo) addCoupon(segundo);
    
    // Adiciona os demais cupons
    for (const cupom of cuponsAtivos) {
      addCoupon(cupom.codigo);
    }
    
    if (ordered.length > 0) {
      _cache = { 
        ts: now, 
        list: ordered,
        destaque: destaque,
        segundo: segundo
      };
      console.log(`[COUPONS] Encontrados ${ordered.length} cupons: ${ordered.slice(0, 3).join(', ')}...`);
      return ordered.slice(0, Math.max(1, max));
    }
    
  } catch (err) {
    console.error(`[COUPONS] Erro ao buscar API: ${err.message}`);
  }

  // Fallback: retorna cupom padrão
  console.log(`[COUPONS] Usando fallback: ${DEFAULT_COUPON}`);
  _cache = { ts: now, list: [DEFAULT_COUPON], destaque: DEFAULT_COUPON, segundo: null };
  return [DEFAULT_COUPON].slice(0, Math.max(1, max));
}

/**
 * Retorna cupons em texto amigável
 * Ex.: "CASAA" ou "CASAA ou CASAB"
 */
async function fetchCouponsText(max = 2, sep = ' ou ') {
  const list = await fetchCoupons(max);
  return list.length > 1 ? `${list[0]}${sep}${list[1]}` : list[0];
}

/**
 * Retorna apenas o primeiro cupom (destaque)
 */
async function fetchFirstCoupon() {
  const list = await fetchCoupons(1);
  return list[0];
}

/**
 * Retorna dados completos da API (para uso avançado)
 */
async function fetchCouponsData() {
  try {
    return await _fetchWithRetry();
  } catch (err) {
    return {
      cupons_ativos: [{ codigo: DEFAULT_COUPON, desconto: 15, disponivel: 50 }],
      destaque: DEFAULT_COUPON,
      segundo: null,
      total_cupons: 1
    };
  }
}

/**
 * Limpa o cache (força nova busca)
 */
function clearCache() {
  _cache = { ts: 0, list: [], destaque: null, segundo: null };
  console.log('[COUPONS] Cache limpo');
}

module.exports = {
  fetchCoupons,
  fetchCouponsText,
  fetchFirstCoupon,
  fetchCouponsData,
  clearCache,
  // Aliases para compatibilidade
  fetchTopCoupons: fetchCoupons
};
