// whatsapp-automation/src/routes/api/hub.js
// API NOVA do Hub (isolada). Não mexe nas rotas antigas.
// Por enquanto é um esqueleto seguro: lista instâncias, status "stub",
// SSE de keepalive e endpoints de connect/disconnect com TODO.

const express = require('express');
const router = express.Router();

const {
  listInstances,
  getInstance,
} = require('../../services/instance-registry');

// Lista instâncias configuradas
router.get('/api/hub/instances', (req, res) => {
  return res.json({ ok: true, instances: listInstances() });
});

// Status "stub" (vamos integrar ao WhatsApp depois)
router.get('/api/hub/status', (req, res) => {
  const inst = String(req.query.inst || '').trim();
  const info = getInstance(inst);
  if (!info) return res.status(404).json({ ok: false, error: 'instance_not_found' });

  // TODO: integrar com o status real do WhatsApp (sock)
  return res.json({
    ok: true,
    inst,
    connected: false,
    connecting: false,
    hasSock: false,
    qrCodeGenerated: false,
  });
});

// SSE de keepalive (a UI fica "ouvindo" e a gente manda pings)
router.get('/api/hub/stream', (req, res) => {
  const inst = String(req.query.inst || '').trim();
  if (!getInstance(inst)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('instance_not_found');
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // hello imediato e pings periódicos
  send('hello', { inst, t: Date.now() });
  const interval = setInterval(() => send('ping', { t: Date.now() }), 25000);

  req.on('close', () => clearInterval(interval));
});

// Conectar (stub) – futuramente dispara o fluxo que gera QR
router.post('/api/hub/connect', (req, res) => {
  const inst = String(req.query.inst || '').trim();
  if (!getInstance(inst)) return res.status(404).json({ ok: false, error: 'instance_not_found' });

  // TODO: acionar connect real
  return res.status(202).json({ ok: true, inst, queued: true });
});

// Desconectar (stub) – futuramente faz logout/clear session
router.post('/api/hub/disconnect', (req, res) => {
  const inst = String(req.query.inst || '').trim();
  if (!getInstance(inst)) return res.status(404).json({ ok: false, error: 'instance_not_found' });

  // TODO: acionar disconnect real
  return res.status(202).json({ ok: true, inst, queued: true });
});

module.exports = router;
