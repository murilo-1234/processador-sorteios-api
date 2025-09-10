// src/services/audio.js
// Transcreve audioMessage do Baileys e devolve texto (OpenAI Whisper por padrão).

const path = require('path');
const fs = require('fs/promises');

async function downloadAudioBuffer(msg, sock) {
  try {
    const m0 = msg?.message || {};
    const m = m0.ephemeralMessage?.message || m0;
    const au = m?.audioMessage;
    if (!au) return null;

    // Baileys: stream via downloadContentFromMessage
    const { downloadContentFromMessage } = require('@adiwajshing/baileys');
    const stream = await downloadContentFromMessage(au, 'audio');
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
  } catch (e) {
    console.error('[audio] download error:', e?.message || e);
    return null;
  }
}

async function transcribeWithOpenAI(buf) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  if (!OPENAI_API_KEY) return null;

  const fetch = global.fetch || (await import('node-fetch')).default;
  const form = new (require('form-data'))();
  const tmp = path.join(process.cwd(), 'data', `wa-audio-${Date.now()}.ogg`);
  await fs.mkdir(path.dirname(tmp), { recursive: true });
  await fs.writeFile(tmp, buf);

  form.append('file', require('fs').createReadStream(tmp));
  form.append('model', 'whisper-1'); // Whisper API
  form.append('response_format', 'text');

  try {
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form
    });
    const text = await r.text();
    try { await fs.unlink(tmp); } catch {}
    return text && text.trim() ? text.trim() : null;
  } catch (e) {
    try { await fs.unlink(tmp); } catch {}
    console.error('[audio] openai error:', e?.message || e);
    return null;
  }
}

async function transcribeMessageAudio(msg, sock) {
  const mode = (process.env.AUDIO_TRANSCRIBER || 'openai').toLowerCase();
  const buf = await downloadAudioBuffer(msg, sock);
  if (!buf) return null;

  if (mode === 'openai') return await transcribeWithOpenAI(buf);

  // placeholder para modo local (no futuro)
  return null;
}

module.exports = { transcribeMessageAudio };
