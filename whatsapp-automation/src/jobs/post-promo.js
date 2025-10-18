// src/jobs/post-promo.js
'use strict';

const axios = require('axios');
const { parse } = require('date-fns');
const crypto = require('crypto');

// === preencher planilha (helpers) ===
const { updateCellByHeaderName } = require('../services/sheets');
const nowISO = () => new Date().toISOString().replace('Z','');

async function writePromoBack(rowNumber, kind, jids) {
  if (kind === 'P1') {
    await updateCellByHeaderName(rowNumber, 'WA_PROMO1', 'Postado');
    await updateCellByHeaderName(rowNumber, 'WA_PROMO1_AT', nowISO());
    await updateCellByHeaderName(rowNumber, 'WA_PROMO1_GROUPS', (jids||[]).join(','));
  } else {
    await updateCellByHeaderName(rowNumber, 'WA_PROMO2', 'Postado');
    await updateCellByHeaderName(rowNumber, 'WA_PROMO2_AT', nowISO());
    await updateCellByHeaderName(rowNumber, 'WA_PROMO2_GROUPS', (jids||[]).join(','));
  }
}

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
function safeStr(v){ try{ return v==null? '' : String(v);}catch{ return '';} }
function localLooksLikeConfiguredTZ() {
  try {
    const tzEnv = safeStr(process.env.TZ).toLowerCase();
    const offsetCfg = Math.abs(Number(process.env.TZ_OFFSET_MINUTES || -180));
    const offsetLocal = Math.abs(new Date().getTimezoneOffset());
    if (tzEnv.includes('sao_paulo') || tzEnv.includes('são_paulo')) return true;
    if (offsetCfg && offsetCfg === offsetLocal) return true;
  } catch {}
  return false;
}
function toUtcFromLocal(d) {
  return zonedTimeToUtcSafe(d, TZ);
}
// ======================================================

const settings = require('../services/settings');
const { getRows, updateCellByHeader } = require('../services/sheets');
const { fetchFirstCoupon } = require('../services/coupons'); // compat
const couponsSvc = require('../services/coupons');            // para top2
const { beforeTexts, dayTexts } = require('../services/promo-texts');
const { acquire: acquireJobLock } = require('../services/job-lock');
const ledger = require('../services/send-ledger');

const DEBUG_JOB = String(process.env.DEBUG_JOB || '').trim() === '1';
const PROMO_BEFORE_DAYS = Number(process.env.PROMO_BEFORE_DAYS || 2);
const PROMO_POST_HOUR  = Number(process.env.PROMO_POST_START_HOUR || 9);
const PROMO_POST_MAX_HOUR = Number(process.env.PROMO_POST_MAX_HOUR || 22);
const BAILEYS_LINK_PREVIEW_OFF = String(process.env.BAILEYS_LINK_PREVIEW_OFF || '1') === '1';
const GROUP_ORDER = String(process.env.GROUP_ORDER || 'shuffle').toLowerCase();

// 🔥 DELAY entre posts (igual post-winner)
const GROUP_POST_DELAY_MIN = Number(process.env.GROUP_POST_DELAY_MINUTES || 3);
const GROUP_POST_DELAY_MAX = Number(process.env.GROUP_POST_DELAY_MAX_MINUTES || 5);

const dlog = (...a) => { if (DEBUG_JOB) console.log('[PROMO]', ...a); };
const coerceStr = (v) => { try { return String(v ?? '').trim(); } catch { return ''; } };

function findHeader(headers, candidates) {
  const lower = headers.map((h) => (h || '').trim().toLowerCase());
  for (const cand of candidates) {
    const i = lower.indexOf(cand.toLowerCase());
    if (i !== -1) return headers[i];
  }
  return null;
}
function mkLocalDateAtHour(spDateOnly /*Date*/, hour = 9) {
  const yyyy = spDateOnly.getFullYear();
  const mm   = spDateOnly.getMonth();
  const dd   = spDateOnly.getDate();
  return new Date(yyyy, mm, dd, hour, 0, 0);
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function mergeText(tpl, vars) {
  return safeStr(tpl)
    .replaceAll('{{PRODUTO}}', safeStr(vars.PRODUTO))
    .replaceAll('{{COUPON}}',  safeStr(vars.COUPON));
}
async function downloadToBuffer(url) {
  const { data } = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SorteiosBot/1.0)' }
  });
  return Buffer.from(data);
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

// 🔥 Calcular delay aleatório (igual post-winner)
function getRandomDelay() {
  const minMs = GROUP_POST_DELAY_MIN * 60 * 1000;
  const maxMs = GROUP_POST_DELAY_MAX * 60 * 1000;
  return minMs + Math.random() * (maxMs - minMs);
}

// === Cupom (mesma regra do post-winner) ===
async function getCouponTextCTA() {
  try {
    let list = [];
    if (typeof couponsSvc.fetchTopCoupons === 'function') {
      list = await couponsSvc.fetchTopCoupons(2);
    } else if (typeof couponsSvc.fetchCoupons === 'function') {
      list = await couponsSvc.fetchCoupons();
    } else if (typeof couponsSvc.fetchAllCoupons === 'function') {
      list = await couponsSvc.fetchAllCoupons();
    }
    list = Array.isArray(list) ? list.filter(Boolean).map(String) : [];
    const uniq = [...new Set(list)].slice(0, 2);
    if (uniq.length >= 2) return `${uniq[0]} ou ${uniq[1]}`;
    if (uniq.length === 1) return uniq[0];
  } catch {}
  try {
    if (typeof fetchFirstCoupon === 'function') {
      const one = await fetchFirstCoupon();
      if (one) return String(one);
    }
  } catch {}
  return String(process.env.DEFAULT_COUPON || '').trim();
}

function isCanceledFlag(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'cancelado' || s === 'cancelada' || s === 'cancel';
}
function hasResultForRow(row, hdrs) {
  const val = (h) => safeStr(h ? row[h] : '').trim().toLowerCase();
  const winner = val(hdrs.H_WINNER);
  const resultUrl = safeStr(hdrs.H_RESULT_URL ? row[hdrs.H_RESULT_URL] : '').trim();
  const resultAt = safeStr(hdrs.H_RESULT_AT ? row[hdrs.H_RESULT_AT] : '').trim();
  const status = val(hdrs.H_STATUS);
  const ended = ['finalizado','encerrado','concluido','concluído','ok','feito','postado','resultado','divulgado'].includes(status);
  return (!!winner || !!resultUrl || !!resultAt || ended);
}

// --- idempotência por grupo via planilha + ledger ---
function parseGroups(val) {
  const s = safeStr(val).trim();
  if (!s) return new Set();
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return new Set(arr.map((x) => String(x).trim()).filter(Boolean));
  } catch {}
  return new Set(s.split(',').map((x) => x.trim()).filter(Boolean));
}
function groupsToCell(set) { return Array.from(set).join(','); }
function isSuperset(setA, setB) { for (const v of setB) if (!setA.has(v)) return false; return true; }

function buildDeck(n) {
  const idx = Array.from({ length: n }, (_, i) => i);
  return shuffle(idx);
}

function IK(rowId, kind, whenIso, groupJid) {
  return `${rowId}|${kind}|${whenIso}|${groupJid}`;
}

async function runOnce(app, opts = {}) {
  const lock = await acquireJobLock('post-promo');
  if (!lock) return { ok: false, reason: 'job_locked' };
  try {
    const dryRun = !!opts.dryRun || String(app?.locals?.reqDry || '').trim() === '1';
    const st = settings.get();

    let targetJids = Array.isArray(st.postGroupJids) && st.postGroupJids.length
      ? st.postGroupJids.filter(Boolean).map((x) => String(x).trim())
      : (st.resultGroupJid ? [String(st.resultGroupJid).trim()] : []);

    if (!targetJids.length) {
      dlog('skip: sem grupos-alvo configurados em /admin/groups');
      return { ok: false, reason: 'no_target_groups' };
    }
    if (GROUP_ORDER === 'shuffle') targetJids = shuffle(targetJids);
    const targetSet = new Set(targetJids);

    const { headers, items, spreadsheetId, tab, sheets } = await getRows();

    // Obrigatórios
    const H_ID   = findHeader(headers, ['id','codigo','código']);
    const H_HORA = findHeader(headers, ['horario','hora','horário','time']);
    const H_PLAN = findHeader(headers, ['url_planilha','planilha','url_da_planilha','sheet_url','url_plan']);

    const H_PROD = findHeader(headers, ['nome_do_produto','produto','nome','produto_nome']);
    const H_DATA = findHeader(headers, ['data','date']);
    const H_IMG  = findHeader(headers, [
      'url_imagem_processada','url_imagem_sorteio','imagem_sorteio','url_imagem','imagem','image_url'
    ]);

    // Controle promo
    const H_P1   = findHeader(headers, ['wa_promo1','wa_promocao1','promo1','wa_promo_1']) || 'WA_PROMO1';
    const H_P1AT = findHeader(headers, ['wa_promo1_at','wa_promocao1_at','promo1_at'])     || 'WA_PROMO1_AT';
    const H_P1G  = findHeader(headers, ['wa_promo1_groups','wa_promocao1_groups','promo1_groups']) || 'WA_PROMO1_GROUPS';
    const H_P1_NEXT = findHeader(headers, ['wa_promo1_next_at','promo1_next_at']) || 'WA_PROMO1_NEXT_AT'; // 🔥 NOVO

    const H_P2   = findHeader(headers, ['wa_promo2','wa_promocao2','promo2','wa_promo_2']) || 'WA_PROMO2';
    const H_P2AT = findHeader(headers, ['wa_promo2_at','wa_promocao2_at','promo2_at'])     || 'WA_PROMO2_AT';
    const H_P2G  = findHeader(headers, ['wa_promo2_groups','wa_promocao2_groups','promo2_groups']) || 'WA_PROMO2_GROUPS';
    const H_P2_NEXT = findHeader(headers, ['wa_promo2_next_at','promo2_next_at']) || 'WA_PROMO2_NEXT_AT'; // 🔥 NOVO

    // Resultado
    const H_WINNER     = findHeader(headers, ['ganhador','ganhadora','vencedor','winner','nome_ganhador']);
    const H_RESULT_URL = findHeader(headers, ['resultado_url','url_resultado','link_resultado','url_result','resultado']);
    const H_RESULT_AT  = findHeader(headers, ['resultado_at','result_at','data_resultado','resultado_data']);
    const H_STATUS     = findHeader(headers, ['status','situacao','situação','state']);

    if (!H_ID || !H_DATA || !H_HORA || !H_PROD || !H_IMG || !H_PLAN) {
      throw new Error(
        `Cabeçalhos faltando. Encontrados: ${JSON.stringify(headers)}. ` +
        `Obrigatórios: id | data | (horario/hora) | produto | url_imagem_processada | url_planilha.`
      );
    }

    const now = new Date();
    const todayLocalDateOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const couponText = await getCouponTextCTA();

    let sent = 0;
    const errors = [];
    const skipped = [];

    const sock = await getPreferredSock(app);
    if (!sock && !dryRun) {
      dlog('WhatsApp não conectado.');
      return { ok: false, reason: 'wa_disconnected' };
    }

    const hdrs = { H_WINNER, H_RESULT_URL, H_RESULT_AT, H_STATUS };

    for (let i = 0; i < items.length; i++) {
      const row = items[i];
      const rowIndex1 = i + 2;

      const id      = coerceStr(row[H_ID]);
      const product = coerceStr(row[H_PROD]);
      const dateStr = coerceStr(row[H_DATA]); // dd/MM/yyyy
      const horaStr = coerceStr(row[H_HORA]);
      const imgUrl  = coerceStr(row[H_IMG]);
      const planUrl = coerceStr(row[H_PLAN]);

      const missing = [];
      if (!id)      missing.push('id');
      if (!dateStr) missing.push('data');
      if (!horaStr) missing.push('hora');
      if (!product) missing.push('produto');
      if (!imgUrl)  missing.push('url_imagem_processada');
      if (!planUrl) missing.push('url_planilha');
      if (missing.length) { skipped.push({ row: rowIndex1, id, reason: 'faltando_campos', missing }); continue; }

      let spDate;
      try {
        spDate = parse(dateStr, 'dd/MM/yyyy', new Date());
        if (isNaN(spDate?.getTime?.())) throw new Error('data inválida');
      } catch {
        skipped.push({ row: rowIndex1, id, reason: 'parseDateFail', raw: dateStr });
        continue;
      }

      if (spDate < todayLocalDateOnly) { skipped.push({ row: rowIndex1, id, reason: 'past_draw' }); continue; }
      if (hasResultForRow(row, hdrs))  { skipped.push({ row: rowIndex1, id, reason: 'has_result' }); continue; }

      // 🔥 Validação: Janela horária (9h-22h)
      const horaAtual = now.getHours();
      if (horaAtual < PROMO_POST_HOUR || horaAtual >= PROMO_POST_MAX_HOUR) {
        skipped.push({ row: rowIndex1, id, reason: 'fora_janela_horaria', hora: horaAtual, janela: `${PROMO_POST_HOUR}h-${PROMO_POST_MAX_HOUR}h` });
        continue;
      }

      const p1Posted   = String(row[H_P1] || '').toLowerCase() === 'postado';
      const p2Posted   = String(row[H_P2] || '').toLowerCase() === 'postado';
      const p1Canceled = isCanceledFlag(row[H_P1]);
      const p2Canceled = isCanceledFlag(row[H_P2]);

      const dayLocal    = mkLocalDateAtHour(spDate, PROMO_POST_HOUR);
      const beforeLocal = new Date(dayLocal.getTime() - PROMO_BEFORE_DAYS * 24 * 60 * 60 * 1000);
      const p1At = toUtcFromLocal(beforeLocal);
      const p2At = toUtcFromLocal(dayLocal);

      // ===== Promo 1 — 2 dias antes =====
      if (!p1Canceled && now >= p1At) {
        const alreadyP1 = parseGroups(row[H_P1G]);
        if (isSuperset(alreadyP1, targetSet)) {
          if (!p1Posted && !dryRun) {
            await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P1, 'Postado');
            await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P1AT, new Date().toISOString());
          }
        } else {
          // 🔥 VERIFICAR TIMESTAMP antes de processar
          const nextAt = row[H_P1_NEXT];
          const nowMs = Date.now();
          if (nextAt && nowMs < Number(nextAt)) {
            const waitMin = Math.ceil((Number(nextAt) - nowMs) / 60000);
            dlog(`aguardando P1 delay`, { id, row: rowIndex1, aguardar: `${waitMin}min` });
            continue;
          }

          // mídia preparada 1x
          let imageBuf = null;
          try { imageBuf = await downloadToBuffer(imgUrl); } catch {}

          // baralho de textos
          const list = Array.isArray(beforeTexts) ? beforeTexts.slice() : [];
          const deck = buildDeck(list.length || 1);

          const whenIso = p1At.toISOString();

          let anySent = false;
          for (const rawJid of (GROUP_ORDER === 'shuffle' ? shuffle(targetJids) : targetJids)) {
            const jid = String(rawJid || '').trim();
            if (!jid.endsWith('@g.us')) continue;
            if (alreadyP1.has(jid)) { dlog('skip P1 já enviado', { jid, row: rowIndex1, id }); continue; }

            // IK + reserva
            const ik = IK(id, 'P1', whenIso, jid);
            const textIndexCandidate = deck.length ? deck.shift() : 0;
            const res = await ledger.reserve(ik, { textIndex: textIndexCandidate, rowId: id, kind: 'P1', whenIso, jid });
            if (res.status !== 'ok') { dlog('dedupe P1', { ik, reason: res.reason }); continue; }
            const textIndex = (res.record && res.record.data && Number.isInteger(res.record.data.textIndex))
              ? res.record.data.textIndex : textIndexCandidate;

            const caption = mergeText(
              (list.length ? list[textIndex % list.length] : ''),
              { PRODUTO: product, COUPON: couponText }
            );

            const payload = imageBuf ? { image: imageBuf, caption } : { text: `${caption}\n\n${imgUrl}` };
            const opts = BAILEYS_LINK_PREVIEW_OFF ? { linkPreview: false } : undefined;

            if (!dryRun) {
              await sock.sendMessage(jid, payload, opts);
              await ledger.commit(ik, { message: 'sent' });

              alreadyP1.add(jid);
              await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P1G, groupsToCell(alreadyP1));
              
              // 🔥 CALCULAR E SALVAR PRÓXIMO TIMESTAMP
              const delayMs = getRandomDelay();
              const nextTimestamp = Date.now() + delayMs;
              await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P1_NEXT, String(nextTimestamp));
              
              anySent = true;
              sent++;
              const delayMin = (delayMs / 60000).toFixed(1);
              dlog('P1 enviado', { jid, id, proximoEm: `${delayMin}min` });
            } else {
              dlog('DRY-RUN P1 =>', { row: rowIndex1, id, jid, at: whenIso, textIndex });
            }
          }

          if (anySent && isSuperset(alreadyP1, targetSet)) {
            const ts = new Date().toISOString();
            await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P1, 'Postado');
            await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P1AT, ts);
          }
        }
      } else {
        dlog('aguardando P1', { id, row: rowIndex1, now: now.toISOString(), p1At: p1At.toISOString() });
      }

      // ===== Promo 2 — no dia =====
      if (!p2Canceled && now >= p2At) {
        
        // 🔥 Validação: Não postar "do dia" após horário do sorteio
        try {
          const horaParts = horaStr.split(':');
          if (horaParts.length >= 2) {
            const hora = parseInt(horaParts[0].trim(), 10);
            const minuto = parseInt(horaParts[1].trim(), 10);
            
            if (!isNaN(hora) && !isNaN(minuto)) {
              const horarioSorteio = new Date(spDate);
              horarioSorteio.setHours(hora, minuto, 0, 0);
              
              if (now >= horarioSorteio) {
                skipped.push({ 
                  row: rowIndex1, 
                  id, 
                  reason: 'sorteio_ja_aconteceu', 
                  horarioSorteio: horarioSorteio.toISOString(),
                  agora: now.toISOString()
                });
                dlog('P2 skip: sorteio já aconteceu', { id, horarioSorteio: horarioSorteio.toISOString() });
                continue;
              }
            }
          }
        } catch (err) {
          dlog('Erro ao validar horário do sorteio P2:', err);
        }

        const alreadyP2 = parseGroups(row[H_P2G]);
        if (isSuperset(alreadyP2, targetSet)) {
          if (!p2Posted && !dryRun) {
            await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P2, 'Postado');
            await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P2AT, new Date().toISOString());
          }
        } else {
          // 🔥 VERIFICAR TIMESTAMP antes de processar
          const nextAt = row[H_P2_NEXT];
          const nowMs = Date.now();
          if (nextAt && nowMs < Number(nextAt)) {
            const waitMin = Math.ceil((Number(nextAt) - nowMs) / 60000);
            dlog(`aguardando P2 delay`, { id, row: rowIndex1, aguardar: `${waitMin}min` });
            continue;
          }

          let imageBuf = null;
          try { imageBuf = await downloadToBuffer(imgUrl); } catch {}

          const list = Array.isArray(dayTexts) ? dayTexts.slice() : [];
          const deck = buildDeck(list.length || 1);

          const whenIso = p2At.toISOString();

          let anySent = false;
          for (const rawJid of (GROUP_ORDER === 'shuffle' ? shuffle(targetJids) : targetJids)) {
            const jid = String(rawJid || '').trim();
            if (!jid.endsWith('@g.us')) continue;
            if (alreadyP2.has(jid)) { dlog('skip P2 já enviado', { jid, row: rowIndex1, id }); continue; }

            const ik = IK(id, 'P2', whenIso, jid);
            const textIndexCandidate = deck.length ? deck.shift() : 0;
            const res = await ledger.reserve(ik, { textIndex: textIndexCandidate, rowId: id, kind: 'P2', whenIso, jid });
            if (res.status !== 'ok') { dlog('dedupe P2', { ik, reason: res.reason }); continue; }
            const textIndex = (res.record && res.record.data && Number.isInteger(res.record.data.textIndex))
              ? res.record.data.textIndex : textIndexCandidate;

            const caption = mergeText(
              (list.length ? list[textIndex % list.length] : ''),
              { PRODUTO: product, COUPON: couponText }
            );

            const payload = imageBuf ? { image: imageBuf, caption } : { text: `${caption}\n\n${imgUrl}` };
            const opts = BAILEYS_LINK_PREVIEW_OFF ? { linkPreview: false } : undefined;

            if (!dryRun) {
              await sock.sendMessage(jid, payload, opts);
              await ledger.commit(ik, { message: 'sent' });

              alreadyP2.add(jid);
              await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P2G, groupsToCell(alreadyP2));
              
              // 🔥 CALCULAR E SALVAR PRÓXIMO TIMESTAMP
              const delayMs = getRandomDelay();
              const nextTimestamp = Date.now() + delayMs;
              await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P2_NEXT, String(nextTimestamp));
              
              anySent = true;
              sent++;
              const delayMin = (delayMs / 60000).toFixed(1);
              dlog('P2 enviado', { jid, id, proximoEm: `${delayMin}min` });
            } else {
              dlog('DRY-RUN P2 =>', { row: rowIndex1, id, jid, at: whenIso, textIndex });
            }
          }

          if (anySent && isSuperset(alreadyP2, targetSet)) {
            const ts = new Date().toISOString();
            await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P2, 'Postado');
            await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P2AT, ts);
          }
        }
      } else {
        dlog('aguardando P2', { id, row: rowIndex1, now: now.toISOString(), p2At: p2At.toISOString() });
      }
    }

    dlog('done', { sent, errors: errors.length, skipped: skipped.length });
    return { ok: true, sent, errors, skipped };
  } finally {
    try { await lock.release(); } catch {}
  }
}

module.exports = { runOnce };
