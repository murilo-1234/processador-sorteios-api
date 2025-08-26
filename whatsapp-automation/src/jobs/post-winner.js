// src/jobs/post-winner.js
const fs = require('fs');
const { parse, format } = require('date-fns');

// ==== IMPORT RESILIENTE + FALLBACK PARA zonedTimeToUtc ====
let zonedTimeToUtcSafe;
try {
  const tz = require('date-fns-tz');
  zonedTimeToUtcSafe = tz?.zonedTimeToUtc || tz?.default?.zonedTimeToUtc;
  if (!zonedTimeToUtcSafe) {
    zonedTimeToUtcSafe = require('date-fns-tz/zonedTimeToUtc');
  }
} catch (_) { /* ignora */ }
if (typeof zonedTimeToUtcSafe !== 'function') {
  const FALLBACK_OFFSET_MIN = Number(process.env.TZ_OFFSET_MINUTES || -180); // SP = -180
  zonedTimeToUtcSafe = (date /*, tz */) => {
    const d = date instanceof Date ? date : new Date(date);
    return new Date(d.getTime() + Math.abs(FALLBACK_OFFSET_MIN) * 60 * 1000);
  };
}
// ==========================================================

const settings = require('../services/settings');
const { getRows, updateCellByHeader } = require('../services/sheets');
const { fetchResultInfo } = require('../services/result');
const { fetchFirstCoupon } = require('../services/coupons');
const { generatePoster } = require('../services/media');
const { makeOverlayVideo } = require('../services/video');
const templates = require('../services/texts');

const TZ = 'America/Sao_Paulo';
const DELAY_MIN = Number(process.env.POST_DELAY_MINUTES || 10);

function chooseTemplate() {
  return templates[Math.floor(Math.random() * templates.length)];
}

function mergeText(tpl, vars) {
  return tpl
    .replaceAll('{{WINNER}}', vars.WINNER)
    .replaceAll('{{RESULT_URL}}', vars.RESULT_URL)
    .replaceAll('{{COUPON}}', vars.COUPON);
}

function findHeader(headers, candidates) {
  const lower = headers.map((h) => (h || '').trim().toLowerCase());
  for (const cand of candidates) {
    const i = lower.indexOf(cand.toLowerCase());
    if (i !== -1) return headers[i];
  }
  return null;
}

function coerceStr(v) { return (v ?? '').toString().trim(); }

async function runOnce(app) {
  const wa = app.locals.whatsappClient || app.whatsappClient;

  const { headers, items, spreadsheetId, tab, sheets } = await getRows();

  const H_ID      = findHeader(headers, ['id', 'codigo', 'código']);
  const H_DATA    = findHeader(headers, ['data', 'date']);
  const H_HORA    = findHeader(headers, ['horario', 'hora', 'horário', 'time']);
  const H_IMG     = findHeader(headers, ['url_imagem_processada', 'url_imagem', 'imagem', 'image_url']);
  const H_PROD    = findHeader(headers, ['nome_do_produto', 'nome', 'produto', 'produto_nome']);
  const H_WA_POST = findHeader(headers, ['wa_post']);
  const H_WA_AT   = findHeader(headers, ['wa_post_at', 'wa_postado_em']);

  if (!H_ID || !H_DATA || !H_HORA || !H_IMG || !H_PROD) {
    throw new Error(
      `Cabeçalhos obrigatórios faltando. Achou: ${JSON.stringify(headers)}. ` +
      `Obrigatórios (alguma das opções): id | data | horario | url_imagem_processada | (nome_do_produto ou nome).`
    );
  }

  const now = new Date();
  const pending = [];

  items.forEach((row, i) => {
    const rowIndex1 = i + 2;

    const id   = coerceStr(row[H_ID]);
    const data = coerceStr(row[H_DATA]);
    const hora = coerceStr(row[H_HORA]);
    if (!id || !data || !hora) return;

    const flagPosted = coerceStr(row[H_WA_POST]).toLowerCase() === 'postado';
    if (flagPosted || settings.hasPosted(id)) return;

    try {
      const spDate = parse(`${data} ${hora}`, 'dd/MM/yyyy HH:mm', new Date());
      const readyAt = new Date(zonedTimeToUtcSafe(spDate, TZ).getTime() + DELAY_MIN * 60000);
      if (now >= readyAt) {
        pending.push({
          rowIndex1,
          id,
          productName: coerceStr(row[H_PROD]),
          imgUrl: coerceStr(row[H_IMG]),
          spDate
        });
      }
    } catch { /* ignora linha inválida */ }
  });

  if (!pending.length) {
    return { ok: true, processed: 0, sent: 0, note: 'sem linhas prontas' };
  }

  const coupon = await fetchFirstCoupon();

  let sent = 0;
  const errors = [];

  for (const p of pending) {
    try {
      const { url: resultUrl, winner, participants } = await fetchResultInfo(p.id);

      const dateTimeStr = format(p.spDate, "dd/MM/yyyy 'às' HH:mm");
      const posterPath = await generatePoster({
        productImageUrl: p.imgUrl,
        productName: p.productName,
        dateTimeStr,
        winner: winner || 'Ganhador(a)',
        participants
      });

      let media;
      if ((process.env.POST_MEDIA_TYPE || 'image') === 'video') {
        const vid = await makeOverlayVideo({
          posterPath,
          duration: Number(process.env.VIDEO_DURATION || 7),
          res: process.env.VIDEO_RES || '1080x1350',
          bitrate: process.env.VIDEO_BITRATE || '2000k'
        });
        media = { video: fs.createReadStream(vid) };
      } else {
        media = { image: fs.createReadStream(posterPath) };
      }

      const caption = mergeText(chooseTemplate(), {
        WINNER: winner || 'Ganhador(a)',
        RESULT_URL: resultUrl,
        COUPON: coupon
      });

      const st = settings.get();
      const targets = (Array.isArray(st.postGroupJids) && st.postGroupJids.length)
        ? st.postGroupJids
        : (st.resultGroupJid ? [st.resultGroupJid] : []);

      if (!targets.length) throw new Error('Nenhum grupo selecionado em /admin/groups');

      // Envia para TODOS os grupos selecionados
      for (const jid of targets) {
        await wa.sock.sendMessage(jid, { ...media, caption });
      }

      const postAt = new Date().toISOString();
      await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, H_WA_POST || 'WA_POST', 'Postado');
      await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, H_WA_AT   || 'WA_POST_AT', postAt);

      settings.addPosted(p.id);
      sent++;
    } catch (e) {
      errors.push({ id: p.id, error: e?.message || String(e) });
    }
  }

  return { ok: true, processed: pending.length, sent, errors };
}

module.exports = { runOnce };
