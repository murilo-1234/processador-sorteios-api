const { parse, format } = require('date-fns');
const { zonedTimeToUtc, utcToZonedTime } = require('date-fns-tz');
const settings = require('../services/settings');
const { getRows, updateCellByHeader } = require('../services/sheets');
const { fetchResultInfo } = require('../services/result');
const { fetchFirstCoupon } = require('../services/coupons');
const { generatePoster } = require('../services/media');
const { makeOverlayVideo } = require('../services/video');
const templates = require('../services/texts');
const fs = require('fs');

const TZ = 'America/Sao_Paulo';

function pickHeader(headers, aliases) {
  return headers.find(h => aliases.map(a => a.toLowerCase()).includes(h.toLowerCase()));
}
function chooseTemplate() {
  return templates[Math.floor(Math.random() * templates.length)];
}
function mergeText(tpl, vars) {
  return tpl
    .replaceAll('{{WINNER}}', vars.WINNER)
    .replaceAll('{{RESULT_URL}}', vars.RESULT_URL)
    .replaceAll('{{COUPON}}', vars.COUPON);
}

async function runOnce(app) {
  const wa = app.locals.whatsappClient || app.whatsappClient;

  const { headers, items, spreadsheetId, tab, sheets } = await getRows();

  const hId     = pickHeader(headers, ['id', 'ID']);
  const hNome   = pickHeader(headers, ['nome', 'nome_do_produto', 'produto']);
  const hData   = pickHeader(headers, ['data']);
  const hHora   = pickHeader(headers, ['horario', 'hora']);
  const hImg    = pickHeader(headers, ['url_imagem_processada', 'imagem', 'url_imagem']);

  if (!hId || !hNome || !hData || !hHora || !hImg) {
    throw new Error('Cabeçalhos esperados: id, nome, data, horario, url_imagem_processada');
  }

  const now = new Date();
  const pending = [];

  items.forEach((row, i) => {
    const ridx = i + 2; // 1-based + header
    const id = row[hId] || '';
    const waPost = (row['WA_POST'] || '').toLowerCase(); // NOVA coluna
    if (!id) return;
    if (settings.hasPosted(id)) return;        // evita duplicar
    if (waPost === 'postado') return;          // já marcado na planilha

    const dateStr = row[hData];
    const timeStr = row[hHora];
    if (!dateStr || !timeStr) return;

    const dtSP = parse(`${dateStr} ${timeStr}`, 'dd/MM/yyyy HH:mm', utcToZonedTime(now, TZ));
    const dtUTC = zonedTimeToUtc(dtSP, TZ);
    const readyAt = new Date(dtUTC.getTime() + (Number(process.env.POST_DELAY_MINUTES || 10) * 60000));

    if (now >= readyAt) {
      pending.push({
        id,
        rowIndex1: ridx,
        productName: row[hNome],
        imgUrl: row[hImg],
        dtSP
      });
    }
  });

  if (!pending.length) return { ok: true, processed: 0 };

  const coupon = await fetchFirstCoupon();

  let sent = 0, errors = [];
  for (const p of pending) {
    try {
      const { url: resultUrl, winner, participants } = await fetchResultInfo(p.id);

      const dateTimeStr = format(p.dtSP, "dd/MM/yyyy 'às' HH:mm", { timeZone: TZ });
      const posterPath = await generatePoster({
        productImageUrl: p.imgUrl,
        productName: p.productName,
        dateTimeStr,
        winner,
        participants
      });

      let media = { image: fs.createReadStream(posterPath) };
      if ((process.env.POST_MEDIA_TYPE || 'image') === 'video') {
        const vid = await makeOverlayVideo({
          posterPath,
          duration: Number(process.env.VIDEO_DURATION || 7),
          res: process.env.VIDEO_RES || '1080x1350',
          bitrate: process.env.VIDEO_BITRATE || '2000k'
        });
        media = { video: fs.createReadStream(vid) };
      }

      const caption = mergeText(chooseTemplate(), {
        WINNER: winner,
        RESULT_URL: resultUrl,
        COUPON: coupon
      });

      const st = settings.get();
      if (!st.resultGroupJid) throw new Error('Nenhum grupo selecionado para postagem (/admin/groups)');

      await wa.sock.sendMessage(st.resultGroupJid, { ...media, caption });

      // Marca como postado usando as colunas novas
      const ts = new Date().toISOString();
      await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, 'WA_POST', 'Postado');
      await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, 'WA_POST_AT', ts);
      settings.addPosted(p.id);

      sent++;
    } catch (e) {
      errors.push({ id: p.id, error: e?.message || String(e) });
    }
  }

  return { ok: true, processed: pending.length, sent, errors };
}

module.exports = { runOnce };
