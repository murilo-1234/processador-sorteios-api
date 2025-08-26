// src/jobs/post-winner.js
const { parse, format } = require('date-fns');
const { zonedTimeToUtc, utcToZonedTime } = require('date-fns-tz');
const settings = require('../services/settings');
const { getRows, updateCellByHeader } = require('../services/sheets');
const { fetchResultInfo } = require('../services/result');
const { fetchFirstCoupon } = require('../services/coupons');
const { generatePoster } = require('../services/media');
const { makeOverlayVideo } = require('../services/video');

const TZ = 'America/Sao_Paulo';

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
    const idx = low.indexOf(name.toLowerCase());
    if (idx !== -1) return headers[idx];
  }
  return null;
}

async function runOnce(app) {
  const wa = app.locals.whatsappClient || app.whatsappClient;
  const { headers, items, spreadsheetId, tab, sheets } = await getRows();
  if (!headers.length) return { ok: true, processed: 0, reason: 'no-rows' };

  // mapeia cabeçalhos reais da sua planilha
  const H = (aliases) => findHeader(headers, Array.isArray(aliases) ? aliases : [aliases]);

  const hId     = H(['id']);
  const hName   = H(['nome_do_produto', 'nome']);
  const hDate   = H(['data']);
  const hTime   = H(['horario', 'hora']);
  const hImg    = H(['url_imagem_processada', 'imagem', 'img', 'image']);
  const hWAPost = H(['wa_post']);
  const hWAPostAt = H(['wa_post_at']);

  // valida cabeçalhos mínimos
  if (!hId || !hName || !hDate || !hTime || !hImg) {
    return {
      ok: false,
      error: 'missing-headers',
      need: { id: !!hId, nome: !!hName, data: !!hDate, horario: !!hTime, url_imagem_processada: !!hImg }
    };
  }

  const now = new Date();
  const pending = [];

  items.forEach((row, i) => {
    const ridx = i + 2; // linha 2 em diante
    const id = (row[hId] || '').trim();
    if (!id) return;

    // já postado?
    const waPost = (row[hWAPost] || '').toString().trim().toLowerCase();
    if (settings.hasPosted(id) || waPost === 'postado') return;

    // data/hora
    const dateStr = (row[hDate] || '').trim();
    const timeStr = (row[hTime] || '').trim();
    if (!dateStr || !timeStr) return;

    // parse no fuso SP
    const dtSPBase = utcToZonedTime(now, TZ);
    const dtSP = parse(`${dateStr} ${timeStr}`, 'dd/MM/yyyy HH:mm', dtSPBase);
    const dtUTC = zonedTimeToUtc(dtSP, TZ);

    const delayMin = Number(process.env.POST_DELAY_MINUTES || 10);
    const readyAt = new Date(dtUTC.getTime() + delayMin * 60000);
    if (now >= readyAt) {
      pending.push({
        id,
        rowIndex1: ridx,
        productName: row[hName] || '',
        imgUrl: row[hImg] || '',
        dtSP
      });
    }
  });

  if (!pending.length) return { ok: true, processed: 0, sent: 0, reason: 'no-pending' };

  // carrega textos/templates (lazy load para evitar require circular)
  const templates = require('../services/texts');
  const coupon = await fetchFirstCoupon();

  let sent = 0;
  const errors = [];
  for (const p of pending) {
    try {
      // busca info do resultado (ganhador, participantes)
      const { url: resultUrl, winner, participants } = await fetchResultInfo(p.id);

      // gera arte (pôster)
      const dateTimeStr = format(p.dtSP, "dd/MM/yyyy 'às' HH:mm", { timeZone: TZ });
      const posterPath = await generatePoster({
        productImageUrl: p.imgUrl,
        productName: p.productName,
        dateTimeStr,
        winner,
        participants
      });

      // imagem ou vídeo overlay
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

      // texto final
      const caption = mergeText(choose(templates), {
        WINNER: winner,
        RESULT_URL: resultUrl,
        COUPON: coupon
      });

      // destino(s)
      const st = settings.get();
      const targets = [];
      if (st.resultGroupJid) targets.push(st.resultGroupJid);
      if (!targets.length) throw new Error('Nenhum grupo selecionado para postagem');

      for (const jid of targets) {
        await wa.sock.sendMessage(jid, { ...media, caption });
      }

      // marca na planilha: WA_POST / WA_POST_AT
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
