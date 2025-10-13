// src/jobs/post-promo.js
'use strict';

const axios = require('axios');
const { parse } = require('date-fns');

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
  if (localLooksLikeConfiguredTZ()) return d;
  return zonedTimeToUtcSafe(d, TZ);
}
// ======================================================

const settings = require('../services/settings');
const { getRows, updateCellByHeader } = require('../services/sheets');
const { fetchFirstCoupon } = require('../services/coupons'); // compat
const couponsSvc = require('../services/coupons');            // para top2
const { beforeTexts, dayTexts } = require('../services/promo-texts');

const DEBUG_JOB = String(process.env.DEBUG_JOB || '').trim() === '1';
const PROMO_BEFORE_DAYS = Number(process.env.PROMO_BEFORE_DAYS || 2);
const PROMO_POST_HOUR  = Number(process.env.PROMO_POST_HOUR || 9);
const BAILEYS_LINK_PREVIEW_OFF = String(process.env.BAILEYS_LINK_PREVIEW_OFF || '1') === '1';

// ===== Ritmo seguro (com defaults) =====
const SAFE_SEND_GLOBAL_MIN_GAP_MIN = Number(process.env.SAFE_SEND_GLOBAL_MIN_GAP_MIN || 5);
const SAFE_SEND_COOLDOWN_MIN       = Number(process.env.SAFE_SEND_COOLDOWN_MIN || 10);
const SAFE_SEND_JITTER_MIN_SEC     = Number(process.env.SAFE_SEND_JITTER_MIN_SEC || 30);
const SAFE_SEND_JITTER_MAX_SEC     = Number(process.env.SAFE_SEND_JITTER_MAX_SEC || 120);
const SAFE_SEND_MAX_GROUPS_PER_HOUR= Number(process.env.SAFE_SEND_MAX_GROUPS_PER_HOUR || 12);
const SAFE_SEND_DAILY_CAP          = Number(process.env.SAFE_SEND_DAILY_CAP || 100);
const SAFE_SEND_LOCK_TTL_SEC       = Number(process.env.SAFE_SEND_LOCK_TTL_SEC || 30);

const dlog = (...a) => { if (DEBUG_JOB) console.log('[PROMO]', ...a); };
const coerceStr = (v) => { try { return String(v ?? '').trim(); } catch { return ''; } };
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- helpers ----------
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

// --- idempotência por grupo (na planilha) ---
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

// --- estado seguro em settings ---
function getSafeState() {
  const cur = settings.get();
  const ss = cur.safeSend || {};
  return {
    lastSentAtByGroup: ss.lastSentAtByGroup || {},
    cursors: ss.cursors || {},
    sentLastHour: Array.isArray(ss.sentLastHour) ? ss.sentLastHour : [],
    sentToday: Array.isArray(ss.sentToday) ? ss.sentToday : [],
    lastGlobalSentAt: Number(ss.lastGlobalSentAt || 0),
    locks: ss.locks || {}
  };
}
function saveSafeState(next) {
  const cur = settings.get();
  settings.set({ ...cur, safeSend: next });
}
function pruneCounters(ss, now) {
  const hrAgo = now - 60*60*1000;
  const dayAgo = now - 24*60*60*1000;
  ss.sentLastHour = ss.sentLastHour.filter(ts => ts >= hrAgo);
  ss.sentToday    = ss.sentToday.filter(ts => ts >= dayAgo);
}
function eligibleGlobal(ss, now) {
  pruneCounters(ss, now);
  const gapOk = (now - (ss.lastGlobalSentAt || 0)) >= SAFE_SEND_GLOBAL_MIN_GAP_MIN * 60 * 1000;
  const hourOk = ss.sentLastHour.length < SAFE_SEND_MAX_GROUPS_PER_HOUR;
  const dayOk = ss.sentToday.length < SAFE_SEND_DAILY_CAP;
  return gapOk && hourOk && dayOk;
}
function eligibleGroup(ss, jid, now) {
  const last = Number(ss.lastSentAtByGroup[jid] || 0);
  return (now - last) >= SAFE_SEND_COOLDOWN_MIN * 60 * 1000;
}
function pickNextGroup(candidates, ss, now) {
  const list = candidates
    .filter(j => eligibleGroup(ss, j, now))
    .sort((a,b) => (ss.lastSentAtByGroup[a]||0) - (ss.lastSentAtByGroup[b]||0));
  return list[0] || null;
}
function nextTextFor(ss, cat, jid, list10) {
  const key = `${cat}:${jid}`;
  const idx = Number(ss.cursors[key] || 0);
  const text = list10[(idx % list10.length) || 0];
  ss.cursors[key] = idx + 1;
  return text;
}

async function runOnce(app, opts = {}) {
  const dryRun = !!opts.dryRun || String(app?.locals?.reqDry || '').trim() === '1';
  const st = settings.get();

  const targetJids = Array.isArray(st.postGroupJids) && st.postGroupJids.length
    ? st.postGroupJids.filter(Boolean).map((x) => String(x).trim())
    : (st.resultGroupJid ? [String(st.resultGroupJid).trim()] : []);

  if (!targetJids.length) {
    dlog('skip: sem grupos-alvo configurados em /admin/groups');
    return { ok: false, reason: 'no_target_groups' };
  }
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

  const H_P2   = findHeader(headers, ['wa_promo2','wa_promocao2','promo2','wa_promo_2']) || 'WA_PROMO2';
  const H_P2AT = findHeader(headers, ['wa_promo2_at','wa_promocao2_at','promo2_at'])     || 'WA_PROMO2_AT';
  const H_P2G  = findHeader(headers, ['wa_promo2_groups','wa_promocao2_groups','promo2_groups']) || 'WA_PROMO2_GROUPS';

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
  const nowTs = now.getTime();
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
  const ss0 = getSafeState();

  // permite no máximo 1 envio por execução
  let didSend = false;

  for (let i = 0; i < items.length && !didSend; i++) {
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

    const p1Posted   = String(row[H_P1] || '').toLowerCase() === 'postado';
    const p2Posted   = String(row[H_P2] || '').toLowerCase() === 'postado';
    const p1Canceled = isCanceledFlag(row[H_P1]);
    const p2Canceled = isCanceledFlag(row[H_P2]);

    const dayLocal    = mkLocalDateAtHour(spDate, PROMO_POST_HOUR);
    const beforeLocal = new Date(dayLocal.getTime() - PROMO_BEFORE_DAYS * 24 * 60 * 60 * 1000);
    const p1At = toUtcFromLocal(beforeLocal);
    const p2At = toUtcFromLocal(dayLocal);

    // estado mutável desta execução
    const ss = getSafeState(); // recarrega a cada linha para minimizar concorrência
    const canGlobal = eligibleGlobal(ss, nowTs);

    // ===== Promo 1 — 48h antes (categoria: pre2) =====
    if (!didSend && canGlobal && !p1Canceled && now >= p1At) {
      const alreadyP1 = parseGroups(row[H_P1G]);
      if (isSuperset(alreadyP1, targetSet)) {
        if (!p1Posted && !dryRun) {
          await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P1, 'Postado');
          await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P1AT, new Date().toISOString());
        }
      } else {
        const remaining = targetJids.filter(j => !alreadyP1.has(j));

        const candidate = pickNextGroup(remaining, ss, nowTs);
        if (candidate) {
          const lockKey = `pre2:${candidate}`;
          const lockUntil = Number(ss.locks[lockKey] || 0);
          if (nowTs >= lockUntil) {
            // trava antes de aguardar jitter
            ss.locks[lockKey] = nowTs + SAFE_SEND_LOCK_TTL_SEC * 1000;
            saveSafeState(ss);

            const caption = mergeText(nextTextFor(ss, 'pre2', candidate, beforeTexts), { PRODUTO: product, COUPON: couponText });

            let payload;
            try {
              const buf = await downloadToBuffer(imgUrl);
              payload = { image: buf, caption };
            } catch {
              payload = { text: `${caption}\n\n${imgUrl}` };
            }

            if (dryRun) {
              dlog('DRY-RUN P1 =>', { row: rowIndex1, id, at: p1At.toISOString(), to: candidate });
            } else {
              const jitter = Math.max(0, Math.min(SAFE_SEND_JITTER_MAX_SEC, SAFE_SEND_JITTER_MIN_SEC + Math.floor(Math.random() * (SAFE_SEND_JITTER_MAX_SEC - SAFE_SEND_JITTER_MIN_SEC + 1))));
              await delay(jitter * 1000);

              const opts = BAILEYS_LINK_PREVIEW_OFF ? { linkPreview: false } : undefined;
              await sock.sendMessage(candidate, payload, opts);

              alreadyP1.add(candidate);
              await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P1G, groupsToCell(alreadyP1));

              const ts = Date.now();
              ss.lastSentAtByGroup[candidate] = ts;
              ss.lastGlobalSentAt = ts;
              pruneCounters(ss, ts);
              ss.sentLastHour.push(ts);
              ss.sentToday.push(ts);
              // libera lock
              delete ss.locks[lockKey];
              saveSafeState(ss);

              if (isSuperset(alreadyP1, targetSet)) {
                const iso = new Date().toISOString();
                await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P1, 'Postado');
                await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P1AT, iso);
              }
              sent++;
              didSend = true;
            }
          }
        }
      }
    }

    // ===== Promo 2 — no dia (categoria: day0) =====
    if (!didSend) {
      const ss2 = getSafeState();
      const canGlobal2 = eligibleGlobal(ss2, nowTs);
      if (canGlobal2 && !p2Canceled && now >= p2At) {
        const alreadyP2 = parseGroups(row[H_P2G]);
        if (isSuperset(alreadyP2, targetSet)) {
          if (!p2Posted && !dryRun) {
            await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P2, 'Postado');
            await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P2AT, new Date().toISOString());
          }
        } else {
          const remaining = targetJids.filter(j => !alreadyP2.has(j));
          const candidate = pickNextGroup(remaining, ss2, nowTs);
          if (candidate) {
            const lockKey = `day0:${candidate}`;
            const lockUntil = Number(ss2.locks[lockKey] || 0);
            if (nowTs >= lockUntil) {
              ss2.locks[lockKey] = nowTs + SAFE_SEND_LOCK_TTL_SEC * 1000;
              saveSafeState(ss2);

              const caption = mergeText(nextTextFor(ss2, 'day0', candidate, dayTexts), { PRODUTO: product, COUPON: couponText });

              let payload;
              try {
                const buf = await downloadToBuffer(imgUrl);
                payload = { image: buf, caption };
              } catch {
                payload = { text: `${caption}\n\n${imgUrl}` };
              }

              if (dryRun) {
                dlog('DRY-RUN P2 =>', { row: rowIndex1, id, at: p2At.toISOString(), to: candidate });
              } else {
                const jitter = Math.max(0, Math.min(SAFE_SEND_JITTER_MAX_SEC, SAFE_SEND_JITTER_MIN_SEC + Math.floor(Math.random() * (SAFE_SEND_JITTER_MAX_SEC - SAFE_SEND_JITTER_MIN_SEC + 1))));
                await delay(jitter * 1000);

                const opts = BAILEYS_LINK_PREVIEW_OFF ? { linkPreview: false } : undefined;
                await sock.sendMessage(candidate, payload, opts);

                alreadyP2.add(candidate);
                await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P2G, groupsToCell(alreadyP2));

                const ts = Date.now();
                ss2.lastSentAtByGroup[candidate] = ts;
                ss2.lastGlobalSentAt = ts;
                pruneCounters(ss2, ts);
                ss2.sentLastHour.push(ts);
                ss2.sentToday.push(ts);
                delete ss2.locks[lockKey];
                saveSafeState(ss2);

                if (isSuperset(alreadyP2, targetSet)) {
                  const iso = new Date().toISOString();
                  await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P2, 'Postado');
                  await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P2AT, iso);
                }
                sent++;
                didSend = true;
              }
            }
          }
        }
      } else if (DEBUG_JOB) {
        dlog('aguardando P2 ou bloqueado por ritmo', { id, row: rowIndex1 });
      }
    }
  }

  dlog('done', { sent, errors: errors.length, skipped: skipped.length });
  return { ok: true, sent, errors, skipped };
}

module.exports = { runOnce };
