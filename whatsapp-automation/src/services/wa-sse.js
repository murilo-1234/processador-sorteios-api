// src/services/wa-sse.js
// Hub simples de Server-Sent Events para empurrar status/qr/log para o front.
// É opcional: se ninguém consumir, nada quebra.

const clients = new Map(); // inst -> Set(res)

function addClient(inst, res) {
  const key = String(inst || 'default');
  if (!clients.has(key)) clients.set(key, new Set());
  clients.get(key).add(res);
  res.on('close', () => {
    try { clients.get(key)?.delete(res); } catch {}
  });
}

// evento: { type: 'status'|'qr'|'log', payload: any }
function broadcast(inst, event) {
  const key = String(inst || 'default');
  const set = clients.get(key);
  if (!set || set.size === 0) return;
  const msg = `event: ${event.type}\ndata: ${JSON.stringify(event.payload || {})}\n\n`;
  for (const res of set) {
    try { res.write(msg); } catch {}
  }
}

// keep-alive para proxies
function keepAlive() {
  for (const set of clients.values()) {
    for (const res of set) {
      try { res.write(': keepalive\n\n'); } catch {}
    }
  }
  setTimeout(keepAlive, 15000);
}
setTimeout(keepAlive, 15000);

module.exports = { addClient, broadcast };
