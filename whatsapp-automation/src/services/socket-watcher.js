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
  rewireAssistant: String(process.env.WA_WATCHER_REWIRE_ASSISTANT || '1') === '1',
  logLevel: (process.env.WA_WATCHER_LOG || 'info').toLowerCase(), // 'info' | 'silent' | 'debug'
};

const log = {
  info: (...a) => { if (DEF.logLevel !== 'silent') console.log('[socket-watcher]', ...a); },
  warn: (...a) => { if (DEF.logLevel !== 'silent') console.warn('[socket-watcher]', ...a); },
  debug: (...a) => { if (DEF.logLevel === 'debug') console.log('[socket-watcher:debug]', ...a); },
};

function startSocketWatcher(appInstance) {
  if (!appInstance) {
    log.warn('appInstance ausente – ignorando.');
    return { stop() {} };
  }

  const baseUrl =
    process.env.WA_SELF_BASE_URL ||
    `http://127.0.0.1:${process.env.PORT || 3000}`;

  let lastSock = null;
  let lastReconnectAt = 0;

  const offSafe = (sock, event, handler) => {
    try {
      if (!sock?.ev || !handler) return;
      if (typeof sock.ev.off === 'function') sock.ev.off(event, handler);
      else if (typeof sock.ev.removeListener === 'function') sock.ev.removeListener(event, handler);
    } catch (_) {}
  };

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
      log.info('POST /admin/wa/connect disparado (soft).');
    } catch (e) {
      log.warn('falha ao chamar /admin/wa/connect:', e?.message || e);
    }
  };

  const rewireAssistant = () => {
    if (!DEF.rewireAssistant) return;
    try {
      const mod = require('../modules/assistant-bot');
      if (typeof mod.attachAssistant === 'function') {
        // Chamamos de novo; o módulo tem seu próprio controle interno.
        mod.attachAssistant(appInstance);
        log.info('attachAssistant() chamado novamente (rewire).');
      }
    } catch (_) {
      // se não existir o módulo do atendente, seguimos em frente sem quebrar nada
    }
  };

  const wireSockListeners = (sock) => {
    try {
      if (!sock?.ev || typeof sock.ev.on !== 'function') return;

      // Evita listeners duplicados no MESMO socket
      const FLAG = '__sw_attached';
      if (sock[FLAG]) return;
      sock[FLAG] = true;

      const connHandler = (u) => {
        // Quando cair com erro conhecido, tenta reconectar via admin (com cooldown)
        const err = u?.lastDisconnect?.error;
        const status =
          err?.output?.statusCode ||
          err?.statusCode ||
          err?.reason?.statusCode ||
          err?.data?.status ||
          err?.data?.payload?.status ||
          null;

        if (status) {
          log.info('lastDisconnect status =', status);
          // 401/428/503/515 são os mais comuns em reconexões do WA Web
          if ([401, 428, 503, 515].includes(Number(status))) {
            softAdminReconnect();
          }
        }

        // Se conexão voltou a abrir, podemos rewire opcionalmente
        if (u?.connection === 'open') {
          setTimeout(rewireAssistant, 200);
        }
      };

      // Guarda referência para permitir remoção ao parar
      Object.defineProperty(sock, '__sw_connHandler', {
        value: connHandler,
        enumerable: false,
        configurable: true,
        writable: false,
      });

      sock.ev.on('connection.update', connHandler);
      log.debug('listeners conectados ao socket.');
    } catch (e) {
      log.warn('wireSockListeners erro:', e?.message || e);
    }
  };

  const tick = () => {
    try {
      const s = getSock();
      if (!s) return;

      if (s !== lastSock) {
        // Descadastrar listener antigo (se ainda estiver presente)
        if (lastSock?.__sw_connHandler) {
          offSafe(lastSock, 'connection.update', lastSock.__sw_connHandler);
          try { delete lastSock.__sw_connHandler; } catch (_) {}
        }

        lastSock = s;

        const sid =
          (s?.user && (s.user.id || s.user.jid)) ||
          (s?.authState && s.authState.creds?.me?.id) ||
          'unknown-sock';

        log.info('novo socket detectado – preparando listeners. id =', sid);
        wireSockListeners(s);
        rewireAssistant(); // garante que o atendente escute o NOVO socket

        // Hook opcional para outros módulos (se existir)
        try {
          if (typeof appInstance.onSocketChange === 'function') {
            appInstance.onSocketChange(s);
          }
        } catch (_) {}
      }
    } catch (e) {
      log.warn('loop erro:', e?.message || e);
    }
  };

  const timer = setInterval(tick, DEF.intervalMs);
  // roda uma vez imediatamente para não aguardar o primeiro intervalo
  tick();

  log.info('iniciado (intervalo =', DEF.intervalMs, 'ms).');
  return {
    stop() {
      clearInterval(timer);
      // Limpa listener atual (se existir)
      if (lastSock?.__sw_connHandler) {
        offSafe(lastSock, 'connection.update', lastSock.__sw_connHandler);
        try { delete lastSock.__sw_connHandler; } catch (_) {}
      }
    }
  };
}

module.exports = { startSocketWatcher };
