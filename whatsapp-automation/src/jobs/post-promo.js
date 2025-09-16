// src/jobs/post-promo.js
'use strict';

const axios = require('axios');
const { parse } = require('date-fns');

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

const settings = require('../services/settings');
const { getRows, updateCellByHeader } = require('../services/sheets');
const { fetchFirstCoupon } = require('../services/coupons'); // compat
const couponsSvc = require('../services/coupons');            // para top2
const { beforeTexts, dayTexts } = require('../services/promo-texts');

const TZ = process.env.TZ || 'America/Sao_Paulo';
const DEBUG_JOB = String(process.env.DEBUG_JOB || '').trim() === '1';

const PROMO_BEFORE_DAYS = Number(process.env.PROMO_BEFORE_DAYS || 2);
const PROMO_POST_HOUR  = Number(process.env.PROMO_POST_HOUR || 9);

const BAILEYS_LINK_PREVIEW_OFF = String(process.env.BAILEYS_LINK_PREVIEW_OFF || '1') === '1';

const dlog = (...a) => { if (DEBUG_JOB) console.log('[PROMO]', ...a); };
const safeStr = (v) => { try { return v == null ? '' : String(v); } catch { return ''; } };
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

function toUtcFromLocal(d) { return zonedTimeToUtcSafe(d, TZ); }

function choose(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return list[Math.floor(Math.random() * list.length)];
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

// === Cupom (mesma regra do post-winner): top2; fallback 1º; fallback ENV ===
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

// Detecta se a linha já tem resultado de sorteio (ganhador/resultado/status).
function hasResultForRow(row, hdrs) {
  const val = (h) => safeStr(h ? row[h] : '').trim().toLowerCase();

  const winner = val(hdrs.H_WINNER);
  const resultUrl = safeStr(hdrs.H_RESULT_URL ? row[hdrs.H_RESULT_URL] : '').trim();
  const resultAt = safeStr(hdrs.H_RESULT_AT ? row[hdrs.H_RESULT_AT] : '').trim();
  const status = val(hdrs.H_STATUS);
  const ended = ['finalizado','encerrado','concluido','concluído','ok','feito','postado','resultado','divulgado'].includes(status);

  return (!!winner || !!resultUrl || !!resultAt || ended);
}

async function runOnce(app, opts = {}) {
  const dryRun = !!opts.dryRun || String(app?.locals?.reqDry || '').trim() === '1';
  const st = settings.get();

  const targetJids = Array.isArray(st.postGroupJids) && st.postGroupJids.length
    ? st.postGroupJids.filter(Boolean).map(String)
    : (st.resultGroupJid ? [String(st.resultGroupJid)] : []);

  if (!targetJids.length) {
    dlog('skip: sem grupos-alvo configurados em /admin/groups');
    return { ok: false, reason: 'no_target_groups' };
  }

  const { headers, items, spreadsheetId, tab, sheets } = await getRows();

  const H_PROD = findHeader(headers, ['nome_do_produto','produto','nome','produto_nome']);
  const H_DATA = findHeader(headers, ['data','date']);
  const H_IMG  = findHeader(headers, [
    'url_imagem_sorteio', 'imagem_sorteio', 'url_imagem_processada', 'url_imagem', 'imagem', 'image_url'
  ]);

  // Campos de controle das promoções
  const H_P1   = findHeader(headers, ['wa_promo1','wa_promocao1','promo1','wa_promo_1']) || 'WA_PROMO1';
  const H_P1AT = findHeader(headers, ['wa_promo1_at','wa_promocao1_at','promo1_at'])     || 'WA_PROMO1_AT';
  const H_P2   = findHeader(headers, ['wa_promo2','wa_promocao2','promo2','wa_promo_2']) || 'WA_PROMO2';
  const H_P2AT = findHeader(headers, ['wa_promo2_at','wa_promocao2_at','promo2_at'])     || 'WA_PROMO2_AT';

  // Sinais de resultado/encerramento do sorteio
  const H_WINNER     = findHeader(headers, ['ganhador','ganhadora','vencedor','winner','nome_ganhador']);
  const H_RESULT_URL = findHeader(headers, ['resultado_url','url_resultado','link_resultado','url_result','resultado']);
  const H_RESULT_AT  = findHeader(headers, ['resultado_at','result_at','data_resultado','resultado_data']);
  const H_STATUS     = findHeader(headers, ['status','situacao','situação','state']);

  if (!H_PROD || !H_DATA || !H_IMG) {
    throw new Error(
      `Cabeçalhos obrigatórios faltando. Encontrados: ${JSON.stringify(headers)}. ` +
      `Obrigatórios (alguma das opções): produto | data | imagem.`
    );
  }

  const now = new Date();
  const todayLocalDateOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // meia-noite local (data puro)
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

    const product = coerceStr(row[H_PROD]);
    const dateStr = coerceStr(row[H_DATA]); // dd/MM/yyyy
    const imgUrl  = coerceStr(row[H_IMG]);

    if (!product || !dateStr || !imgUrl) {
      skipped.push({ row: rowIndex1, reason: 'faltando produto/data/img' });
      continue;
    }

    const p1Posted = String(row[H_P1] || '').toLowerCase() === 'postado';
    const p2Posted = String(row[H_P2] || '').toLowerCase() === 'postado';
    const p1Canceled = isCanceledFlag(row[H_P1]);
    const p2Canceled = isCanceledFlag(row[H_P2]);

    let spDate;
    try {
      spDate = parse(dateStr, 'dd/MM/yyyy', new Date());
      if (isNaN(spDate?.getTime?.())) throw new Error('data inválida');
    } catch {
      skipped.push({ row: rowIndex1, reason: 'parseDateFail', raw: dateStr });
      continue;
    }

    // ✅ Somente sorteios futuros (data da planilha >= hoje) e sem resultado ainda.
    if (spDate < todayLocalDateOnly) {
      skipped.push({ row: rowIndex1, reason: 'past_draw' });
      continue;
    }
    if (hasResultForRow(row, hdrs)) {
      skipped.push({ row: rowIndex1, reason: 'has_result' });
      continue;
    }

    const dayLocal    = mkLocalDateAtHour(spDate, PROMO_POST_HOUR);
    const beforeLocal = new Date(dayLocal.getTime() - PROMO_BEFORE_DAYS * 24 * 60 * 60 * 1000);

    const p1At = toUtcFromLocal(beforeLocal);
    const p2At = toUtcFromLocal(dayLocal);

    // Promo 1 — 48h antes
    if (!p1Posted && !p1Canceled && now >= p1At) {
      const caption = mergeText(choose(beforeTexts), { PRODUTO: product, COUPON: couponText });

      try {
        let payload;
        try {
          const buf = await downloadToBuffer(imgUrl);
          payload = { image: buf, caption };
        } catch {
          payload = { text: `${caption}\n\n${imgUrl}` };
        }

        if (dryRun) {
          dlog('DRY-RUN P1 =>', { row: rowIndex1, caption: caption.slice(0, 80) + '...' });
        } else {
          for (const rawJid of targetJids) {
            const jid = String(rawJid || '').trim();
            if (!jid.endsWith('@g.us')) continue;
            const opts = BAILEYS_LINK_PREVIEW_OFF ? { linkPreview: false } : undefined;
            await sock.sendMessage(jid, payload, opts);
          }

          const ts = new Date().toISOString();
          await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P1, 'Postado');
          await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P1AT, ts);
          sent++;
        }
      } catch (e) {
        errors.push({ row: rowIndex1, stage: 'send-promo1', error: e?.message || String(e) });
      }
    }

    // Promo 2 — no dia
    if (!p2Posted && !p2Canceled && now >= p2At) {
      const caption = mergeText(choose(dayTexts), { PRODUTO: product, COUPON: couponText });

      try {
        let payload;
        try {
          const buf = await downloadToBuffer(imgUrl);
          payload = { image: buf, caption };
        } catch {
          payload = { text: `${caption}\n\n${imgUrl}` };
        }

        if (dryRun) {
          dlog('DRY-RUN P2 =>', { row: rowIndex1, caption: caption.slice(0, 80) + '...' });
        } else {
          for (const rawJid of targetJids) {
            const jid = String(rawJid || '').trim();
            if (!jid.endsWith('@g.us')) continue;
            const opts = BAILEYS_LINK_PREVIEW_OFF ? { linkPreview: false } : undefined;
            await sock.sendMessage(jid, payload, opts);
          }

          const ts = new Date().toISOString();
          await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P2, 'Postado');
          await updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, H_P2AT, ts);
          sent++;
        }
      } catch (e) {
        errors.push({ row: rowIndex1, stage: 'send-promo2', error: e?.message || String(e) });
      }
    }
  }

  dlog('done', { sent, errors: errors.length, skipped: skipped.length });
  return { ok: true, sent, errors, skipped };
}

module.exports = { runOnce };
