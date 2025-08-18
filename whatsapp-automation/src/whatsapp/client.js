import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';
import { log, err } from '../logger.js';
import { upsertGroup } from '../db/sqlite.js';

let sock = null;
let stateCtrl = null;
let lastQR = null; // string do QR
let lastQRImage = null; // dataURL (SVG) pronto pra exibir
let lastPairingCode = null; // string numérica
let isConnected = false;

export const waState = () => ({ isConnected, lastQR, lastPairingCode });

export async function startWhatsApp() {
  const { sessionPath, clearSession, forceNew, phoneNumber, forceQR, debug } = CONFIG.whatsapp;
  
  if (clearSession) {
    try { 
      fs.rmSync(sessionPath, { recursive: true, force: true }); 
    } catch {}
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  stateCtrl = saveCreds;

  const { version } = await fetchLatestBaileysVersion();
  log('Using WA version', version);

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['WhatsApp Automation', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    logger: undefined
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, qr, lastDisconnect } = u;
    
    if (qr) {
      lastQR = qr;
      lastQRImage = await qrcode.toString(qr, { type: 'svg' });
      log('QR Code generated');
    }

    if (connection === 'open') {
      isConnected = true;
      lastQR = null; 
      lastQRImage = null; 
      lastPairingCode = null;
      log('WA connected');
    }

    if (connection === 'close') {
      isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode || 
                   lastDisconnect?.error?.status || '';
      log('WA closed', code);
      
      // Reconectar após 4 segundos
      setTimeout(() => startWhatsApp().catch(err), 4000);
    }
  });

  // Se há phoneNumber e NÃO estamos forçando QR -> pairing code
  if (phoneNumber && !forceQR) {
    try {
      lastPairingCode = await sock.requestPairingCode(phoneNumber);
      log('Pairing code generated:', lastPairingCode);
    } catch (e) {
      err('Error generating pairing code', e?.message);
    }
  }

  return sock;
}

export function getQRHtml() {
  if (lastQRImage) {
    return `<!doctype html><meta charset="utf-8"><title>QR Code</title>
    <style>body{display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}</style>
    <div>${lastQRImage}</div>`;
  }
  return `<!doctype html><meta charset="utf-8"><title>QR Code</title>
  <style>body{font-family:Arial;text-align:center;margin:50px}</style>
  <h2>QR Code não disponível</h2>
  <p>WhatsApp pode já estar conectado ou aguardando conexão</p>`;
}

export const getPairingCode = () => {
  if (lastPairingCode) return { code: lastPairingCode };
  return { 
    error: 'Pairing code não disponível', 
    message: 'WhatsApp pode já estar conectado ou aguardando geração do código' 
  };
};

export async function fetchAndStoreGroups() {
  if (!sock) throw new Error('WA não iniciado');
  if (!isConnected) throw new Error('WA desconectado');

  // Buscar grupos
  const groups = await sock.groupFetchAllParticipating();
  const arr = Object.values(groups);
  const now = new Date().toISOString();

  for (const g of arr) {
    await upsertGroup({
      jid: g.id,
      name: g.subject || g.name || g.id,
      is_group: 1,
      participants_count: (g.participants || []).length,
      last_synced_at: now
    });
  }

  log('Groups synced:', arr.length);
  return arr.map(g => ({ jid: g.id, name: g.subject || g.name }));
}

export const whatsappStatus = () => ({ 
  isConnected,
  qrCodeGenerated: !!lastQR,
  currentRetry: 0,
  maxRetries: 3,
  circuitBreakerState: isConnected ? 'CLOSED' : 'OPEN',
  failureCount: 0,
  queueLength: 0,
  user: sock?.user || null
});

export const sendMessage = async (jid, message) => {
  if (!sock || !isConnected) {
    throw new Error('WhatsApp não está conectado');
  }
  
  await sock.sendMessage(jid, { text: message });
  return true;
};

