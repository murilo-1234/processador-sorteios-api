// src/services/link-utils.js
const ALLOWED_HOSTS = new Set([
  'swiy.co',
  'wa.me',
  'ig.me',
  'm.me',
  'www.instagram.com',
  'www.tiktok.com',
  'chat.whatsapp.com',
  'bit.ly'
]);

function normalizeLinks(text) {
  let out = String(text || '');
  
  // Normaliza links swiy.co (remove espaços extras)
  out = out.replace(/swiy\s*\.\s*co\//gi, 'swiy.co/');
  
  // Remove vírgulas/pontos/ponto-e-vírgula do final de qualquer link
  out = out.replace(/(https?:\/\/[^\s,.;]+)[,.;]+/g, '$1');
  
  return out;
}

function isAllowedLink(url) {
  try { 
    const u = new URL(url); 
    return ALLOWED_HOSTS.has(u.host); 
  }
  catch (_) { 
    return false; 
  }
}

module.exports = { normalizeLinks, isAllowedLink, ALLOWED_HOSTS };
