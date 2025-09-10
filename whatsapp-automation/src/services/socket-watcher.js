// src/services/socket-watcher.js
//
// Vigia o socket do Baileys e, quando detectar troca de socket,
// reanexa listeners (chama novamente o attachAssistant) e tenta
// reconectar o admin se notar quedas recorrentes.
// É isolado e não interfere nos demais módulos.

const DEF = {
  intervalMs: Number(process.env.WA_WATCHER_INTERVAL_MS || 2500),
  adminReconnect: String(process.env.WA_WATCHER_ADMIN_RECONNECT || '1') === '1',
  reconnectCooldownMs: Number(process.env.WA_WATCHER_RECONNECT_COOLDOWN_MS || 30000),
};

function startSocketWatcher(appInstance) {
  if (!appInstance) {
    console.warn('[socket-watcher] appInstance ausente – ignorando.');
    return { stop() {} };
  }

  const baseUrl =
    process.env.WA_SELF_BASE_URL ||
    `http://127.0.0.1:${process.env.PORT || 3000}`;

  let lastSock = null;
  let lastReconnectAt = 0;

  const getSock = () => {
    try {
      // Prioriza admin
      if (appInstance.waAdmin?.getSock) {
        const s = appInstance.waAdmin.getSock();
        if (s) return s;
      }
      // Fallback (cliente interno)
      if (appInstance.whatsappClient?.sock) {
        return appInstance.whatsappClient.sock;
      }
    } catch (_) {}
    return null;
  };

  const softAdminReconnect = async () => {
    if (!DEF.adminReconnect) return;
    const now = Date.now();
    if (now - lastReconnectAt < DEF.reconnectCooldownMs) return; // cooldown
    lastReconnectAt = now;
    try {
      await fetch(`${baseUrl}/admin/wa/connect`, { method: 'POST' });
      console.log('[socket-watcher] POST /admin/wa/connect disparado (soft).');
    } catch (e) {
      console.warn('[socket-watcher] falha ao chamar /admin/wa/connect:', e?.message || e);
    }
  };

  const wireSockListeners = (sock) => {
    try {
      if (!sock?.ev || typeof sock.ev.on !== 'function') return;

      // Evita listeners duplicados no MESMO socket
      const FLAG = '__sw_attached';
      if (sock[FLAG]) return;
      sock[FLAG] = true;

      sock.ev.on('connection.update', (u) => {
        // Quando cair com erro conhecido, tenta reconectar via admin (com cooldown)
        const err = u?.lastDisconnect?.error;
        const status =
          err?.output?.statusCode ||
          err?.statusCode ||
          err?.reason?.statusCode ||
          err?.data?.status ||
          null;

        if (status) {
          console.log('[socket-watcher] lastDisconnect status =', status);
          // 401/428/503/515 são os mais comuns em reconexões do WA Web
          if ([401, 428, 503, 515].includes(Number(status))) {
            softAdminReconnect();
          }
        }
      });
    } catch (e) {
      console.warn('[socket-watcher] wireSockListeners erro:', e?.message || e);
    }
  };

  const rewireAssistant = () => {
    try {
      const mod = require('../modules/assistant-bot');
      if (typeof mod.attachAssistant === 'function') {
        // Chamamos de novo; o módulo tem seu próprio controle interno.
        mod.attachAssistant(appInstance);
        console.log('[socket-watcher] attachAssistant() chamado novamente (rewire).');
      }
    } catch (_) {
      // se não existir o módulo do atendente, seguimos em frente sem quebrar nada
    }
  };

  const timer = setInterval(() => {
    try {
      const s = getSock();
      if (!s) return;

      if (s !== lastSock) {
        lastSock = s;
        console.log('[socket-watcher] novo socket detectado – preparando listeners.');
        wireSockListeners(s);
        rewireAssistant(); // garante que o atendente escute o NOVO socket
      }
    } catch (e) {
      console.warn('[socket-watcher] loop erro:', e?.message || e);
    }
  }, DEF.intervalMs);

  console.log('[socket-watcher] iniciado (intervalo =', DEF.intervalMs, 'ms).');
  return { stop() { clearInterval(timer); } };
}

module.exports = { startSocketWatcher };
