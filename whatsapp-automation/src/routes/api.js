// src/routes/api.js
const express = require('express');
const router = express.Router();

// Formata número/ID em JID do WhatsApp
function toJid(to) {
  const t = String(to || '').trim();
  if (!t) return null;
  if (t.endsWith('@g.us') || t.endsWith('@s.whatsapp.net')) return t;
  // número -> contato individual
  const num = t.replace(/\D/g, '');
  if (num.length < 10) return null;
  return `${num}@s.whatsapp.net`;
}

// Status rápido do WhatsApp
router.get('/whatsapp/status', (req, res) => {
  const wa = req.app.locals.whatsappClient;
  if (!wa) return res.status(503).json({ error: 'whatsapp client not ready' });
  return res.json(wa.getConnectionStatus?.() || { isConnected: !!wa.isConnected });
});

// Envio de texto (smoke test)
router.post('/messages/send', async (req, res) => {
  try {
    const wa = req.app.locals.whatsappClient;
    if (!wa) {
      return res.status(503).json({ error: 'whatsapp client not ready' });
    }
    if (!wa.isConnected) {
      return res.status(503).json({ error: 'whatsapp not connected' });
    }

    const { to, message } = req.body || {};
    const jid = toJid(to);
    if (!jid) return res.status(400).json({ error: 'parâmetro "to" inválido' });
    if (!message) return res.status(400).json({ error: 'parâmetro "message" obrigatório' });

    const result = await wa.sock.sendMessage(jid, { text: message });
    return res.json({ ok: true, id: result?.key?.id || null });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
