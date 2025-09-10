// src/services/link-utils.js
// Utilitários para normalizar e validar links antes do envio.

const ALLOWED_HOSTS = new Set([
  'www.natura.com.br',
  'wa.me',
  'ig.me',
  'm.me',
  'www.instagram.com',
  'www.tiktok.com',
  'chat.whatsapp.com',
  'bit.ly'
]);

function normalizeNaturaUrl(text) {
  let out = String(text || '');

  // https://www.natura.com, \n br/  -> https://www.natura.com.br/
  out = out.replace(/https:\/\/www\.natura\.com[,\s]*br\//gi, 'https://www.natura.com.br/');

  // wwwnatura.com.br / wwwnatura -> www.natura.com.br
  out = out.replace(/https?:\/\/wwwnatura\.com\.br/gi, 'https://www.natura.com.br');
  out = out.replace(/https?:\/\/wwwnatura\.com\.br/gi, 'https://www.natura.com.br');

  // forçar www.
  out = out.replace(/https?:\/\/(natura\.com\.br)/gi, 'https://www.$1');

  // limpar espaços no domínio: www. natura . com . br
  out = out.replace(/https?:\/\/www\.\s*natura\.\s*com\s*\.\s*br/gi, 'https://www.natura.com.br');

  // retirar pontuação colada ao fim do link
  out = out.replace(/(https?:\/\/[^\s,.;]+)[,.;]+/g, '$1');

  return out;
}

function isAllowedLink(url) {
  try {
    const u = new URL(url);
    return ALLOWED_HOSTS.has(u.host);
  } catch (_) {
    return false;
  }
}

function ensureConsultoriaParam(url) {
  try {
    const u = new URL(url);
    if (u.host === 'www.natura.com.br') {
      const p = u.searchParams;
      if (!p.has('consultoria')) {
        p.set('consultoria', 'clubemac');
        u.search = p.toString();
      }
    }
    return u.toString();
  } catch (_) {
    return url;
  }
}

module.exports = { normalizeNaturaUrl, isAllowedLink, ensureConsultoriaParam, ALLOWED_HOSTS };
