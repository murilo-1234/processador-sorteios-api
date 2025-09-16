// src/services/promo-schedule.js
'use strict';

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

const TZ = process.env.TZ || 'America/Sao_Paulo';
const PROMO_BEFORE_DAYS = Number(process.env.PROMO_BEFORE_DAYS || 2);
const PROMO_POST_HOUR  = Number(process.env.PROMO_POST_HOUR || 9);

const { getRows, updateCellByHeader } = require('./sheets');

const safe = (v) => (v == null ? '' : String(v));
const lower = (v) => safe(v).trim().toLowerCase();
const isCanceled = (v) => ['cancelado','cancelada','cancel'].includes(lower(v));
const isPosted = (v) => lower(v) === 'postado';

function findHeader(headers, candidates, fallback) {
  const lowerH = headers.map(h => (h || '').trim().toLowerCase());
  for (const cand of candidates) {
    const i = lowerH.indexOf(cand.toLowerCase());
    if (i !== -1) return headers[i];
  }
  return fallback || null;
}

function mkLocalDateAtHour(spDateOnly /*Date*/, hour = 9) {
  const yyyy = spDateOnly.getFullYear();
  const mm   = spDateOnly.getMonth();
  const dd   = spDateOnly.getDate();
  return new Date(yyyy, mm, dd, hour, 0, 0);
}
function toUtcFromLocal(d) { return zonedTimeToUtcSafe(d, TZ); }

function asISO(d) {
  try { return new Date(d).toISOString(); } catch { return null; }
}

async function computeHeaders() {
  const { headers, items, spreadsheetId, tab, sheets } = await getRows();
  const H_PROD = findHeader(headers, ['nome_do_produto','produto','nome','produto_nome']);
  const H_DATA = findHeader(headers, ['data','date']);
  const H_IMG  = findHeader(headers, [
    'url_imagem_sorteio', 'imagem_sorteio', 'url_imagem_processada', 'url_imagem', 'imagem', 'image_url'
  ]);

  const H_P1   = findHeader(headers, ['wa_promo1','wa_promocao1','promo1','wa_promo_1'], 'WA_PROMO1');
  const H_P1AT = findHeader(headers, ['wa_promo1_at','wa_promocao1_at','promo1_at'], 'WA_PROMO1_AT');
  const H_P2   = findHeader(headers, ['wa_promo2','wa_promocao2','promo2','wa_promo_2'], 'WA_PROMO2');
  const H_P2AT = findHeader(headers, ['wa_promo2_at','wa_promocao2_at','promo2_at'], 'WA_PROMO2_AT');

  // campos de resultado/encerramento
  const H_WINNER     = findHeader(headers, ['ganhador','ganhadora','vencedor','winner','nome_ganhador']);
  const H_RESULT_URL = findHeader(headers, ['resultado_url','url_resultado','link_resultado','url_result','resultado']);
  const H_RESULT_AT  = findHeader(headers, ['resultado_at','result_at','data_resultado','resultado_data']);
  const H_STATUS     = findHeader(headers, ['status','situacao','situação','state']);

  return { headers, items, spreadsheetId, tab, sheets, H_PROD, H_DATA, H_IMG, H_P1, H_P1AT, H_P2, H_P2AT, H_WINNER, H_RESULT_URL, H_RESULT_AT, H_STATUS };
}

function hasResultRow(row, H_WINNER, H_RESULT_URL, H_RESULT_AT, H_STATUS) {
  const winner = safe(row[H_WINNER]).trim();
  const rurl   = safe(row[H_RESULT_URL]).trim();
  const rat    = safe(row[H_RESULT_AT]).trim();
  const st     = lower(row[H_STATUS]);
  const ended  = ['finalizado','encerrado','concluido','concluído','ok','feito','postado','resultado','divulgado'].includes(st);
  return (!!winner || !!rurl || !!rat || ended);
}

async function listScheduled() {
  const { headers, items, H_PROD, H_DATA, H_IMG, H_P1, H_P2, H_WINNER, H_RESULT_URL, H_RESULT_AT, H_STATUS } = await computeHeaders();
  const scheduled = [];
  const posted = [];
  const now = new Date();
  const todayLocalDateOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  for (let i = 0; i < items.length; i++) {
    const row = items[i];
    const rowIndex1 = i + 2;

    const product = safe(row[H_PROD]).trim();
    const dateStr = safe(row[H_DATA]).trim();
    const imgUrl  = safe(row[H_IMG]).trim();
    if (!product || !dateStr || !imgUrl) continue;

    let spDate;
    try {
      spDate = parse(dateStr, 'dd/MM/yyyy', new Date());
      if (isNaN(spDate?.getTime?.())) continue;
    } catch { continue; }

    const dayLocal    = mkLocalDateAtHour(spDate, PROMO_POST_HOUR);
    const beforeLocal = new Date(dayLocal.getTime() - PROMO_BEFORE_DAYS * 24 * 60 * 60 * 1000);

    const p1At = toUtcFromLocal(beforeLocal);
    const p2At = toUtcFromLocal(dayLocal);

    const p1Val = row[H_P1];
    const p2Val = row[H_P2];

    const hasResult = hasResultRow(row, H_WINNER, H_RESULT_URL, H_RESULT_AT, H_STATUS);

    const base = { row: rowIndex1, product, dateStr, imgUrl };

    // P1
    {
      const st = isPosted(p1Val) ? 'posted' : isCanceled(p1Val) ? 'canceled' : (now >= p1At ? 'due' : 'upcoming');
      const entry = { ...base, kind:'promo1', atLocalISO: asISO(beforeLocal), atUtcISO: asISO(p1At), status: st, canCancel: !isPosted(p1Val) && !isCanceled(p1Val) };
      if (st === 'posted') posted.push(entry);
      else {
        // Somente agenda se sorteio é futuro (data >= hoje) e sem resultado
        if (spDate >= todayLocalDateOnly && !hasResult) scheduled.push(entry);
      }
    }

    // P2
    {
      const st = isPosted(p2Val) ? 'posted' : isCanceled(p2Val) ? 'canceled' : (now >= p2At ? 'due' : 'upcoming');
      const entry = { ...base, kind:'promo2', atLocalISO: asISO(dayLocal), atUtcISO: asISO(p2At), status: st, canCancel: !isPosted(p2Val) && !isCanceled(p2Val) };
      if (st === 'posted') posted.push(entry);
      else {
        if (spDate >= todayLocalDateOnly && !hasResult) scheduled.push(entry);
      }
    }
  }

  // ordena por data/hora local
  const sorter = (a, b) => new Date(a.atLocalISO) - new Date(b.atLocalISO);
  scheduled.sort(sorter);
  posted.sort(sorter);

  return { scheduled, posted };
}

async function cancelScheduled(rowIndex1, which) {
  if (!rowIndex1 || (which !== 'p1' && which !== 'p2')) {
    throw new Error('Parâmetros inválidos. Use { row, which:"p1"|"p2" }.');
  }
  const { headers, spreadsheetId, tab, sheets, items, H_P1, H_P2 } = await computeHeaders();
  const idx0 = Number(rowIndex1) - 2;
  if (idx0 < 0 || idx0 >= items.length) throw new Error('Linha fora da faixa.');

  const row = items[idx0];
  const targetHeader = which === 'p1' ? H_P1 : H_P2;
  const cur = row[targetHeader];

  if (isPosted(cur)) throw new Error('Já postado; não é possível cancelar.');
  if (isCanceled(cur)) return { row: rowIndex1, which, header: targetHeader, value: 'Cancelado', unchanged: true };

  await updateCellByHeader(sheets, spreadsheetId, tab, headers, Number(rowIndex1), targetHeader, 'Cancelado');
  return { row: rowIndex1, which, header: targetHeader, value: 'Cancelado' };
}

module.exports = {
  listScheduled,
  cancelScheduled,
};
