const fs = require('fs');

const settings = require('../services/settings');
const { getRows, updateCellByHeader } = require('../services/sheets');
const { fetchResultInfo } = require('../services/result');
const { fetchFirstCoupon } = require('../services/coupons');
const { generatePoster } = require('../services/media');
const { makeOverlayVideo } = require('../services/video');
const templates = require('../services/texts');

// ===== Util: parse "dd/MM/yyyy" + "HH:mm" como hora de São Paulo (UTC-3) e retorna em UTC =====
function parseSPToUTC(dateStr, timeStr) {
  // dateStr: dd/MM/yyyy   timeStr: HH:mm
  const [dd, mm, yyyy] = String(dateStr).split('/').map((v) => parseInt(v, 10));
  const [HH, MM] = String(timeStr).split(':').map((v) => parseInt(v, 10));
  if (!yyyy || !mm || !dd || isNaN(HH) || isNaN(MM)) {
    return null;
  }
  // São Paulo (atual) = UTC-3  ->  UTC = SP + 3h
  const utcDate = new Date(Date.UTC(yyyy, mm - 1, dd, HH + 3, MM, 0, 0));
  return utcDate;
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
  const delayMin = Number(process.env.POST_DELAY_MINUTES || 10);
  const mediaType = (process.env.POST_MEDIA_TYPE || 'image').toLowerCase();

  const { headers, items, spreadsheetId, tab, sheets } = await getRows();

  // mapa case-insensitive dos cabeçalhos
  const H = (name) => headers.find(h => (h || '').toLowerCase() === String(name).toLowerCase());

  const hId   = H('id');
  const hProd = H('nome_do_produto') || H('nome');
  const hData = H('data');
  const hHora = H('horario') || H('hora');
  const hImg  = H('url_imagem_processada') || H('url_imagem');

  if (!hId || !hProd || !hData || !hHora || !hImg) {
    throw new Error('Cabeçalhos esperados: id, nome/nome_do_produto, data, horario, url_imagem_processada');
  }

  const now = new Date();
  const pending = [];

  items.forEach((row, i) => {
    const rowIndex1 = i + 2; // 1-based, considerando header na linha 1
    const id = (row[hId] || '').trim();
    const status = (row['Status'] || row['status'] || '').trim();

    if (!id) return;
    if (settings.hasPosted(id)) return;                 // já postado (cache)
    if (status.toLowerCase() === 'postado') return;     // já marcado na planilha

    const dateStr = (row[hData] || '').trim();
    const timeStr = (row[hHora] || '').trim();
    if (!dateStr || !timeStr) return;

    const eventUTC = parseSPToUTC(dateStr, timeStr);
    if (!eventUTC) return;

    const readyAt = new Date(eventUTC.getTime() + delayMin * 60000);
    if (now >= readyAt) {
      pending.push({
        id,
        rowIndex1,
        productName: row[hProd] || '',
        imgUrl: row[hImg] || '',
        // já temos o texto formatado, aproveitamos o original
        dateTimeStr: `${dateStr} às ${timeStr}`,
        eventUTC
      });
    }
  });

  if (!pending.length) return { ok: true, processed: 0 };

  const coupon = await fetchFirstCoupon();

  let sent = 0;
  const errors = [];

  for (const p of pending) {
    try {
      const { url: resultUrl, winner, participants } = await fetchResultInfo(p.id);

      // pôster (imagem)
      const posterPath = await generatePoster({
        productImageUrl: p.imgUrl,
        productName: p.productName,
        dateTimeStr: p.dateTimeStr,
        winner,
        participants
      });

      // imagem ou vídeo overlay
      let mediaMsg;
      if (mediaType === 'video') {
        const vid = await makeOverlayVideo({
          posterPath,
          duration: Number(process.env.VIDEO_DURATION || 7),
          res: process.env.VIDEO_RES || '1080x1350',
          bitrate: process.env.VIDEO_BITRATE || '2000k'
        });
        mediaMsg = { video: fs.createReadStream(vid) };
      } else {
        mediaMsg = { image: fs.createReadStream(posterPath) };
      }

      // texto (template aleatório)
      const caption = mergeText(chooseTemplate(), {
        WINNER: winner,
        RESULT_URL: resultUrl,
        COUPON: coupon
      });

      // destino
      const st = settings.get();
      if (!st.resultGroupJid) throw new Error('Nenhum grupo selecionado para postagem (settings.resultGroupJid vazio)');

      await wa.sock.sendMessage(st.resultGroupJid, { ...mediaMsg, caption });

      // marca como postado (planilha + cache)
      await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, 'Status', 'Postado');
      settings.addPosted(p.id);

      sent++;
    } catch (e) {
      errors.push({ id: p.id, error: e?.message || String(e) });
    }
  }

  return { ok: true, processed: pending.length, sent, errors };
}

module.exports = { runOnce };
