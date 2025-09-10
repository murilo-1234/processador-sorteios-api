// src/services/audio-transcriber.js
// Transcreve áudios do WhatsApp usando OpenAI Whisper (opt-in).
// Requer: ASSISTANT_AUDIO_TRANSCRIBE=1 e OPENAI_API_KEY
// Não obrigatório: 'form-data' (se ausente, retorna null graciosamente)

const axios = require('axios')

let FormData = null
try { FormData = require('form-data') } catch (_) { /* opcional */ }

const ON = String(process.env.ASSISTANT_AUDIO_TRANSCRIBE || '0') === '1'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''

// util: baixa mídia do Baileys (buffer)
async function _downloadAudioBuffer(sock, msg) {
  try {
    const m = msg?.message || {}
    const inner = m.ephemeralMessage?.message || m
    const media = inner.audioMessage || inner.pttMessage || null
    if (!media || !sock?.downloadMediaMessage) return null
    const buff = await sock.downloadMediaMessage(msg)
    if (!buff || !buff.length) return null
    return Buffer.isBuffer(buff) ? buff : Buffer.from(buff)
  } catch (_) { return null }
}

async function tryTranscribe({ msg, sock }) {
  if (!ON || !OPENAI_API_KEY) return null
  if (!FormData) return null

  const audio = await _downloadAudioBuffer(sock, msg)
  if (!audio) return null

  const form = new FormData()
  form.append('model', 'whisper-1')
  form.append('response_format', 'json')
  form.append('file', audio, { filename: 'audio.ogg', contentType: 'audio/ogg' })

  try {
    const { data } = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() },
      timeout: 60000
    })
    const text = (data?.text || '').trim()
    if (text) return { text }
  } catch (e) {
    console.warn('[audio] transcribe fail:', e?.response?.data || e?.message || e)
  }
  return null
}

module.exports = { tryTranscribe }
