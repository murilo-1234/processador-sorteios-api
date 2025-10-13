// src/jobs/post-groups-safe.js
const settings = require('../services/settings')
const crypto = require('crypto')

// env helpers
const asInt = (v, d) => {
  const n = Number(v); return Number.isFinite(n) ? n : d
}
const COOLDOWN_MIN = asInt(process.env.PER_GROUP_COOLDOWN_MIN, 10)
const JIT_MIN = asInt(process.env.JITTER_MIN_SEC, 30)
const JIT_MAX = asInt(process.env.JITTER_MAX_SEC, 120)
const MAX_HOURLY = asInt(process.env.MAX_GROUPS_PER_HOUR, 12)
const DAILY_CAP  = asInt(process.env.DAILY_POSTS_CAP, 100)
const ROTATE_SEQ = String(process.env.ROTATE_TEXTS_MODE || 'sequential').toLowerCase() === 'sequential'

let TEXTS = []
try {
  TEXTS = require('../config/texts.json')
  if (!Array.isArray(TEXTS)) TEXTS = []
} catch (_) {
  TEXTS = []
}

function randInt(min, max){ return Math.floor(Math.random()*(max-min+1))+min }
function shuffleInPlace(arr){
  for (let i = arr.length -1; i>0; i--) { const j = randInt(0,i); [arr[i],arr[j]]=[arr[j],arr[i]] }
  return arr
}

function spintax(s){
  return s.replace(/\{([^}]+)\}/g, (_,m)=>{
    const parts = m.split('|').map(x=>x.trim()).filter(Boolean)
    return parts.length ? parts[randInt(0, parts.length-1)] : ''
  })
}

function varyText(base, groupName){
  // 1) spintax
  let out = spintax(String(base||'').trim())

  // 2) embaralhar linhas preservando a primeira
  const lines = out.split('\n').map(s=>s.trim()).filter(Boolean)
  if (lines.length > 2){
    const head = lines.shift()
    shuffleInPlace(lines)
    lines.unshift(head)
  }
  out = lines.join('\n')

  // 3) inserir nome do grupo se existir placeholder
  out = out.replace(/\{\{grupo\}\}/g, groupName || '')

  // 4) UTM aleatória leve (mantém ?consultoria=clubemac)
  out = out.replace(/https?:\/\/\S+/g, (url) => {
    try {
      const u = new URL(url)
      if (!u.searchParams.has('utm_v')) {
        u.searchParams.set('utm_v', crypto.randomBytes(3).toString('hex'))
      }
      return u.toString()
    } catch { return url }
  })

  // 5) CTA leve alternado
  const ctas = ['Fale comigo', 'Chame no Whats', 'Responda "7"', 'Me escreva aqui']
  out += `\n\n${ctas[randInt(0, ctas.length-1)]}`
  return out
}

function getTargetsFromSettings(st){
  const list = Array.isArray(st.postGroupJids) && st.postGroupJids.length
    ? st.postGroupJids
    : (st.resultGroupJid ? [st.resultGroupJid] : [])
  const groupsMeta = Array.isArray(st.groups) ? st.groups : []
  const metaByJid = new Map(groupsMeta.map(g => [g.jid, g]))
  return list.map(jid => ({ jid, name: metaByJid.get(jid)?.name || '' }))
}

async function sendTextViaApp(app, jid, text){
  // prefere admin sock
  try {
    const sock = await app.getConnectedSock()
    if (!sock) throw new Error('no socket')
    await sock.sendMessage(jid, { text })
    return true
  } catch (e) {
    console.error('[safe-queue] send error:', e?.message || e)
    return false
  }
}

function pruneCounters(arr, sinceMs){
  return (Array.isArray(arr) ? arr : []).filter(ts => ts >= sinceMs)
}

async function loadState(){
  const st = settings.get() || {}
  return st.safeQueue || { lastTextIdx: 0, lastSentAtByGroup: {}, sentLastHour: [], sentToday: [] }
}
async function saveState(next){
  const st = settings.get() || {}
  st.safeQueue = next
  settings.set(st) // merge-persist do serviço existente
}

function pickBaseText(idx){
  if (!TEXTS.length) return 'Mensagem padrão.'
  if (ROTATE_SEQ) return TEXTS[idx % TEXTS.length]
  return TEXTS[randInt(0, TEXTS.length-1)]
}

async function eligibleNextGroup(state, targets){
  const now = Date.now()
  const cdMs = COOLDOWN_MIN * 60 * 1000
  const lastBy = state.lastSentAtByGroup || {}
  const eligible = targets
    .filter(g => !lastBy[g.jid] || (now - lastBy[g.jid]) >= cdMs)
    .sort((a,b)=> (lastBy[a.jid]||0)-(lastBy[b.jid]||0))
  return eligible[0] || null
}

module.exports = {
  /**
   * Executa no máx. 1 envio por chamada.
   * Chamar a cada 60s do app, somente se sessão estiver conectada.
   */
  async tick(app){
    const now = Date.now()
    const state = await loadState()
    const st = settings.get() || {}

    // limites por hora/dia
    const hourAgo = now - 60*60*1000
    const sentLastHour = pruneCounters(state.sentLastHour, hourAgo)
    const dayStart = new Date(); dayStart.setHours(0,0,0,0)
    const sentToday = pruneCounters(state.sentToday, dayStart.getTime())

    if (sentToday.length >= DAILY_CAP) return { ok: true, reason: 'daily_cap' }
    if (sentLastHour.length >= MAX_HOURLY) return { ok: true, reason: 'hourly_cap' }

    // alvos
    const targets = getTargetsFromSettings(st)
    if (!targets.length) return { ok: true, reason: 'no_targets' }

    // próximo elegível
    const next = await eligibleNextGroup(state, targets)
    if (!next) return { ok: true, reason: 'cooldown' }

    // selecionar texto e variar
    const baseIdx = (Number(state.lastTextIdx)||0) + 1
    const base = pickBaseText(baseIdx)
    const text = varyText(base, next.name)

    // jitter
    const sleep = ms => new Promise(r=>setTimeout(r, ms))
    const jitter = randInt(JIT_MIN, JIT_MAX) * 1000
    await sleep(jitter)

    const ok = await sendTextViaApp(app, next.jid, text)
    if (!ok) return { ok: false, error: 'send_failed' }

    // persistir estado
    const lastSentAtByGroup = { ...(state.lastSentAtByGroup||{}), [next.jid]: now }
    const newState = {
      lastTextIdx: baseIdx,
      lastSentAtByGroup,
      sentLastHour: [...sentLastHour, now],
      sentToday: [...sentToday, now]
    }
    await saveState(newState)
    return { ok: true, sent: { jid: next.jid, name: next.name }, jitterMs: jitter }
  }
}
