// src/jobs/post-custom.js
'use strict';

const fs = require('fs');
const { parse, addMinutes } = require('date-fns');

// ========== TZ utils (iguais ao post-winner) ==========
let zonedTimeToUtcSafe;
try {
  const tz = require('date-fns-tz');
  zonedTimeToUtcSafe = tz?.zonedTimeToUtc || tz?.default?.zonedTimeToUtc;
  if (!zonedTimeToUtcSafe) zonedTimeToUtcSafe = require('date-fns-tz/zonedTimeToUtc');
} catch (_) {}
if (typeof zonedTimeToUtcSafe !== 'function') {
  const TZ_OFFSET_MINUTES = Number(process.env.TZ_OFFSET_MINUTES || -180);
  zonedTimeToUtcSafe = (date) => {
    const d = date instanceof Date ? date : new Date(date);
    return new Date(d.getTime() + Math.abs(TZ_OFFSET_MINUTES) * 60 * 1000);
  };
}
const TZ = process.env.TZ || 'America/Sao_Paulo';

function safeStr(v) {
  try { return v == null ? '' : String(v); } catch { return ''; }
}

function coerceStr(v) { 
  try { return String(v ?? '').trim(); } catch { return ''; } 
}

const settings = require('../services/settings');
const { getCustomPostsRows, updateCustomPost } = require('../services/custom-posts');
const { acquire: acquireJobLock } = require('../services/job-lock');
const ledger = require('../services/send-ledger');

const DEBUG_JOB = String(process.env.DEBUG_JOB || '').trim() === '1';
const CUSTOM_POST_EXPIRE_MINUTES = Number(process.env.CUSTOM_POST_EXPIRE_MINUTES || 30);
const GROUP_POST_DELAY_MIN = Number(process.env.GROUP_POST_DELAY_MINUTES || 2);
const GROUP_POST_DELAY_MAX = Number(process.env.GROUP_POST_DELAY_MAX_MINUTES || 4);
const BAILEYS_LINK_PREVIEW_OFF = String(process.env.BAILEYS_LINK_PREVIEW_OFF || '1') === '1';

const dlog = (...a) => { if (DEBUG_JOB) console.log('[CUSTOM]', ...a); };

function parseCsvSet(csv) {
  const s = String(csv || '');
  if (!s.trim()) return new Set();
  return new Set(s.split(',').map(x => x.trim()).filter(Boolean));
}

function setToCsv(set) { 
  return Array.from(set).join(','); 
}

function parseTimestamp(val) {
  if (!val) return null;
  try {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d;
  } catch {}
  return null;
}

function IK(rowId, kind, whenIso, groupJid) {
  return `${rowId}|${kind}|${whenIso}|${groupJid}`;
}

function getRandomDelay() {
  const min = GROUP_POST_DELAY_MIN * 60000;
  const max = GROUP_POST_DELAY_MAX * 60000;
  return Math.floor(Math.random() * (max - min)) + min;
}

async function getPreferredSock(app) {
  try {
    const waAdmin = app?.locals?.waAdmin || app?.waAdmin;
    if (waAdmin && typeof waAdmin.getStatus === 'function') {
      const st = await waAdmin.getStatus();
      if (st?.connected) return waAdmin.getSock();
    }
  } catch (_) {}
  const waClient = app?.locals?.whatsappClient || app?.whatsappClient;
  return waClient?.sock || null;
}

async function runOnce(app, opts = {}) {
  const lock = await acquireJobLock('post-custom');
  if (!lock) return { ok: false, reason: 'job_locked' };

  try {
    const dryRun = !!opts.dryRun || String(app?.locals?.reqDry || '').trim() === '1';
    
    dlog('tick start', { dryRun });
    
    const st = settings.get();
    let targetJids = Array.isArray(st.postGroupJids) && st.postGroupJids.length
      ? st.postGroupJids.filter(Boolean).map((x) => String(x).trim())
      : (st.resultGroupJid ? [String(st.resultGroupJid).trim()] : []);

    if (!targetJids.length) {
      dlog('skip: sem grupos-alvo configurados');
      return { 
        ok: false, 
        processed: 0,
        sent: 0,
        errors: [{ stage: 'precheck', error: 'Nenhum grupo selecionado' }]
      };
    }
    
    dlog('targets', targetJids);

    const now = new Date();
    const rows = await getCustomPostsRows();

    const pending = [];
    const skipped = [];

    rows.forEach((row, i) => {
      const rowIndex1 = i + 2;
      const id = coerceStr(row.ID);
      const status = coerceStr(row.STATUS);
      const data = coerceStr(row.DATA);
      const hora = coerceStr(row.HORA);
      const mediaPath = coerceStr(row.MEDIA_PATH);
      const mediaType = coerceStr(row.MEDIA_TYPE);
      const texto1 = coerceStr(row.TEXTO_1);
      const texto2 = coerceStr(row.TEXTO_2);
      const texto3 = coerceStr(row.TEXTO_3);
      const texto4 = coerceStr(row.TEXTO_4);
      const texto5 = coerceStr(row.TEXTO_5);

      if (!id || !data || !hora) {
        skipped.push({ row: rowIndex1, id, reason: 'faltando id/data/hora' });
        return;
      }

      // 🔥 IGNORA STATUS: Duplicado, Concluído, Cancelado, Expirado
      if (!['Agendado', 'Postando'].includes(status)) {
        skipped.push({ row: rowIndex1, id, reason: 'status_invalido', status });
        return;
      }

      let dataHora;
      try {
        dataHora = parse(`${data} ${hora}`, 'yyyy-MM-dd HH:mm', new Date());
        if (isNaN(dataHora?.getTime?.())) throw new Error('data/hora inválida');
      } catch {
        skipped.push({ row: rowIndex1, id, reason: 'parseDateFail' });
        return;
      }

      if (now < dataHora) {
        skipped.push({ row: rowIndex1, id, reason: 'ainda_nao_chegou' });
        return;
      }

      const diffMin = (now - dataHora) / 60000;
      if (diffMin > CUSTOM_POST_EXPIRE_MINUTES && status === 'Agendado') {
        updateCustomPost(id, { STATUS: 'Expirado', ATUALIZADO_EM: now.toISOString() });
        skipped.push({ row: rowIndex1, id, reason: 'expirado' });
        return;
      }

      const nextAt = parseTimestamp(row.WA_POST_NEXT_AT);
      if (nextAt && now < nextAt) {
        skipped.push({ row: rowIndex1, id, reason: 'aguardando_delay' });
        return;
      }

      const textos = [texto1, texto2, texto3, texto4, texto5].filter(Boolean);
      if (textos.length < 5) {
        skipped.push({ row: rowIndex1, id, reason: 'faltam_textos' });
        return;
      }

      if (!mediaPath || !fs.existsSync(mediaPath)) {
        skipped.push({ row: rowIndex1, id, reason: 'media_nao_encontrada' });
        return;
      }

      const postedSet = parseCsvSet(row.WA_CUSTOM_GROUPS);
      const remainingJids = targetJids.filter(j => !postedSet.has(j));

      if (remainingJids.length === 0) {
        skipped.push({ row: rowIndex1, id, reason: 'todos_grupos_postados' });
        return;
      }

      pending.push({
        rowIndex1, id, dataHora, mediaPath, mediaType,
        textos, postedSet, remainingJids,
        whenIso: dataHora.toISOString()
      });
    });

    if (!pending.length) {
      dlog('sem linhas prontas');
      return { ok: true, processed: 0, sent: 0, note: 'sem linhas prontas', skipped };
    }

    pending.sort((a, b) => a.dataHora - b.dataHora);
    
    console.log(`📋 [post-custom] Posts encontrados:`);
    pending.forEach(p => {
      const horario = p.dataHora.toLocaleString('pt-BR');
      console.log(`   ${p.id} - ${horario} | ${p.postedSet.size}/${targetJids.length} grupos`);
    });

    const post = pending.find(p => p.remainingJids.length > 0);
    
    if (!post) {
      console.log(`✅ [post-custom] Todos completos!`);
      return { ok: true, processed: 0, sent: 0, note: 'todos completos', skipped };
    }

    console.log(`⚠️ [post-custom] Processando: ${post.id}`);

    const sock = await getPreferredSock(app);
    if (!sock && !dryRun) {
      return { 
        ok: false, 
        processed: 0,
        sent: 0,
        errors: [{ stage: 'sendMessage', error: 'WhatsApp não conectado' }]
      };
    }

    let sent = 0;
    const errors = [];

    try {
      const totalGrupos = targetJids.length;
      const proximoGrupo = targetJids.find(jid => !post.postedSet.has(jid));

      if (!proximoGrupo) {
        await updateCustomPost(post.id, {
          STATUS: 'Concluído',
          WA_POST_NEXT_AT: '',
          ATUALIZADO_EM: now.toISOString()
        });
        return { ok: true, processed: 1, sent: 0, skipped };
      }

      const idx = targetJids.indexOf(proximoGrupo);
      console.log(`🎯 [post-custom] Grupo ${idx + 1}/${totalGrupos}`);

      const ik = IK(post.id, 'CUSTOM', post.whenIso, proximoGrupo);
      const res = await ledger.reserve(ik);
      
      if (res.status !== 'ok') {
        post.postedSet.add(proximoGrupo);
        await updateCustomPost(post.id, { 
          WA_CUSTOM_GROUPS: setToCsv(post.postedSet),
          ATUALIZADO_EM: now.toISOString()
        });
      } else {
        const textoIndex = idx % post.textos.length;
        const caption = post.textos[textoIndex];

        const mediaBuffer = fs.readFileSync(post.mediaPath);
        const isVideo = post.mediaType.startsWith('video');
        const media = isVideo 
          ? { video: mediaBuffer, mimetype: post.mediaType }
          : { image: mediaBuffer, mimetype: post.mediaType };

        const payload = { ...media, caption };
        const opts = BAILEYS_LINK_PREVIEW_OFF ? { linkPreview: false } : undefined;

        if (!dryRun) {
          await sock.sendMessage(proximoGrupo, payload, opts);
          await ledger.commit(ik);
          sent++;
          console.log(`✅ [post-custom] Postado!`);
        }

        post.postedSet.add(proximoGrupo);
        const novosPostados = post.postedSet.size;
        
        await updateCustomPost(post.id, { 
          WA_CUSTOM_GROUPS: setToCsv(post.postedSet),
          ATUALIZADO_EM: now.toISOString()
        });

        if (novosPostados === totalGrupos) {
          await updateCustomPost(post.id, {
            STATUS: 'Concluído',
            WA_POST_NEXT_AT: '',
            ATUALIZADO_EM: now.toISOString()
          });
          console.log(`🎉 [post-custom] COMPLETO!`);
        } else {
          const delayMs = getRandomDelay();
          const nextPostAt = new Date(now.getTime() + delayMs);
          
          await updateCustomPost(post.id, {
            STATUS: 'Postando',
            WA_POST_NEXT_AT: nextPostAt.toISOString(),
            ATUALIZADO_EM: now.toISOString()
          });
          
          console.log(`⏰ [post-custom] Próximo: ${nextPostAt.toLocaleTimeString('pt-BR')}`);
        }
      }

    } catch (e) {
      errors.push({ id: post.id, error: e?.message || String(e) });
    }

    return { ok: true, processed: 1, sent, errors, skipped, dryRun };

  } finally {
    try { await lock.release(); } catch {}
  }
}

module.exports = { runOnce };
