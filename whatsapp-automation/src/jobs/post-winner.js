// src/jobs/post-winner.js
const settings = require('../services/settings');
const { getRows, updateCellByHeader } = require('../services/sheets');
const { fetchResultInfo } = require('../services/result');
const { fetchFirstCoupon } = require('../services/coupons');
const { generatePoster } = require('../services/media');
const { makeOverlayVideo } = require('../services/video');

// ---- helpers ---------------------------------------------------------------

// Converte "dd/MM/yyyy" + "HH:mm" para Date em UTC,
// assumindo fuso de São Paulo (-03:00).
function spToUtc(dateStr, timeStr) {
  const [dd, mm, yyyy] = dateStr.split('/').map(n => parseInt(n, 10));
  const [hh, min] = timeStr.split(':').map(n => parseInt(n, 10));
  const pad = (n) => String(n).padStart(2, '0');
  const iso = `${yyyy}-${pad(mm)}-${pad(dd)}T${pad(hh)}:${pad(min)}:00-03:00`;
  return new Date(iso); // em memória fica UTC
}

function choose(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function mergeText(tpl, vars) {
  return tpl
    .replaceAll('{{WINNER}}', vars.WINNER)
    .replaceAll('{{RESULT_URL}}', vars.RESULT_URL)
    .replaceAll('{{COUPON}}', vars.COUPON);
}

function findHeader(headers, aliases) {
  const low = headers.map(h => (h || '').toLowerCase());
  for (const name of aliases) {
    const i = low.indexOf(name.toLowerCase());
    if (i !== -1) return headers[i];
  }
  return null;
}

// ---------------------------------------------------------------------------

async function runOnce(app) {
  const wa = app.locals.whatsappClient || app.whatsappClient;
  const { headers, items, spreadsheetId, tab, sheets } = await getRows();
  if (!headers.length) return { ok: true, processed: 0, reason: 'no-rows' };

  const H = (aliases) => findHeader(headers, Array.isArray(aliases) ? aliases : [aliases]);

  const hId       = H(['id']);
  const hName     = H(['nome_do_produto', 'nome']);
  const hDate     = H(['data']);
  const hTime     = H(['horario', 'hora']);
  const hImg      = H(['url_imagem_processada', 'imagem', 'img', 'image']);
  const hWAPost   = H(['wa_post']);
  const hWAPostAt = H(['wa_post_at']);

  if (!hId || !hName || !hDate || !hTime || !hImg) {
    return {
      ok: false,
      error: 'missing-headers',
      need: { id: !!hId, nome: !!hName, data: !!hDate, horario: !!hTime, url_imagem_processada: !!hImg }
    };
  }

  const now = new Date();
  const delayMin = Number(process.env.POST_DELAY_MINUTES || 10);

  const pending = [];
  items.forEach((row, i) => {
    const ridx = i + 2;
    const id = (row[hId] || '').trim();
    if (!id) return;

    // já postado?
    const waPost = (row[hWAPost] || '').toString().trim().toLowerCase();
    if (settings.hasPosted(id) || waPost === 'postado') return;

    const dateStr = (row[hDate] || '').trim();
    const timeStr = (row[hTime] || '').trim();
    if (!dateStr || !timeStr) return;

    const dtUTC = spToUtc(dateStr, timeStr);
    const readyAt = new Date(dtUTC.getTime() + delayMin * 60000);

    if (now >= readyAt) {
      pending.push({
        id,
        rowIndex1: ridx,
        productName: row[hName] || '',
        imgUrl: row[hImg] || '',
        dateStr,
        timeStr
      });
    }
  });

  if (!pending.length) return { ok: true, processed: 0, sent: 0, reason: 'no-pending' };

  const templates = require('../services/texts');
  const coupon = await fetchFirstCoupon();

  let sent = 0;
  const errors = [];

  for (const p of pending) {
    try {
      const { url: resultUrl, winner, participants } = await fetchResultInfo(p.id);

      // Gera pôster (passamos a data/hora como texto mesmo)
      const dateTimeStr = `${p.dateStr} às ${p.timeStr}`;
      const posterPath = await generatePoster({
        productImageUrl: p.imgUrl,
        productName: p.productName,
        dateTimeStr,
        winner,
        participants
      });

      // mídia: imagem ou vídeo overlay
      let media = { image: require('fs').createReadStream(posterPath) };
      if ((process.env.POST_MEDIA_TYPE || 'image') === 'video') {
        const vid = await makeOverlayVideo({
          posterPath,
          duration: Number(process.env.VIDEO_DURATION || 7),
          res: process.env.VIDEO_RES || '1080x1350',
          bitrate: process.env.VIDEO_BITRATE || '2000k'
        });
        media = { video: require('fs').createReadStream(vid) };
      }

      // legenda
      const caption = mergeText(choose(templates), {
        WINNER: winner,
        RESULT_URL: resultUrl,
        COUPON: coupon
      });

      // destino
      const st = settings.get();
      const targets = [];
      if (st.resultGroupJid) targets.push(st.resultGroupJid);
      if (!targets.length) throw new Error('Nenhum grupo selecionado para postagem');

      for (const jid of targets) {
        await wa.sock.sendMessage(jid, { ...media, caption });
      }

      // marca na planilha
      await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, 'WA_POST', 'Postado');
      await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, 'WA_POST_AT', new Date().toISOString());
      settings.addPosted(p.id);

      sent++;
    } catch (e) {
      errors.push({ id: p.id, error: e?.message || String(e) });
    }
  }

  return { ok: true, processed: pending.length, sent, errors };
}

module.exports = { runOnce };
