// src/services/wa-sse.js
// Hub SSE super simples (multi-instância) usado pelo /api/whatsapp/stream.
//
// API:
//   addClient(instId, res)  -> registra a resposta SSE e inicia heartbeat
//   broadcast(instId, obj)  -> envia {event: obj.type||'message', data: obj.payload||obj}
//   stats()                 -> retorna contagem por instância
//   closeAll([instId])      -> encerra clientes (opcionalmente só de uma instância)

const clients = new Map();   // instId => Set<res>
const heartbeats = new WeakMap();

function _ensureSet(inst) {
  if (!clients.has(inst)) clients.set(inst, new Set());
  return clients.get(inst);
}

function addClient(inst = 'default', res) {
  const set = _ensureSet(inst);
  set.add(res);

  // pequeno "olá" + heartbeat
  try { res.write(': connected\n\n'); } catch (_) {}

  const iv = setInterval(() => {
    try { res.write('event: ping\ndata: {}\n\n'); } catch (_) {}
  }, Number(process.env.SSE_HEARTBEAT_MS || 25000));

  heartbeats.set(res, iv);

  const cleanup = () => {
    try { clearInterval(heartbeats.get(res)); } catch (_) {}
    heartbeats.delete(res);
    set.delete(res);
    if (!set.size) clients.delete(inst);
  };

  res.on('close', cleanup);
  res.on('finish', cleanup);
  return { inst, clients: set.size };
}

function broadcast(inst, payload) {
  const send = (res, obj) => {
    try {
      const type = obj && obj.type ? String(obj.type) : 'message';
      const data = JSON.stringify(obj && obj.payload !== undefined ? obj.payload : obj);
      res.write(`event: ${type}\ndata: ${data}\n\n`);
    } catch (_) {}
  };

  if (inst === '*' || inst === 'all') {
    for (const set of clients.values()) for (const res of set) send(res, payload);
    return true;
  }

  const set = clients.get(inst);
  if (!set || !set.size) return false;
  for (const res of set) send(res, payload);
  return true;
}

function stats() {
  const out = {};
  for (const [k, set] of clients.entries()) out[k] = set.size;
  return out;
}

function closeAll(inst) {
  if (inst) {
    const set = clients.get(inst);
    if (!set) return;
    for (const res of set) { try { res.end(); } catch (_) {} }
    clients.delete(inst);
    return;
  }
  for (const [k, set] of clients.entries()) {
    for (const res of set) { try { res.end(); } catch (_) {} }
    clients.delete(k);
  }
}

module.exports = { addClient, broadcast, stats, closeAll };
