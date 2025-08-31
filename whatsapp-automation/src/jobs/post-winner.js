// src/jobs/post-winner.js
const fs = require('fs');
const path = require('path');
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
  // Fallback simples baseado em offset configurável
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
// NOVO: integração Creatomate (apenas será usada se VIDEO_MODE=creatomate)
let makeCreatomateVideo = null;
try {
  ({ makeCreatomateVideo } = require('../services/creatomate'));
} catch { /* arquivo pode não existir em deploy antigo */ }

const TZ = process.env.TZ || 'America/Sao_Paulo';
const DELAY_MIN = Number(process.env.POST_DELAY_MINUTES ?? 10);

function chooseTemplate() {
  const templates = require('../services/texts');
  if (Array.isArray(templates) && templates.length) {
    return templates[Math.floor(Math.random() * templates.length)];
  }
  return '🎉 Resultado: {{WINNER}}\n🔗 Detalhes: {{RESULT_URL}}\n💸 Cupom: {{COUPON}}';
}
function safeStr(v) {
  try { return v == null ? '' : String(v); } catch { return ''; }
}
function mergeText(tpl, vars) {
  const s = safeStr(tpl);
  return s
    .replaceAll('{{WINNER}}', safeStr(vars.WINNER))
    .replaceAll('{{RESULT_URL}}', safeStr(vars.RESULT_URL))
    .replaceAll('{{COUPON}}', safeStr(vars.COUPON));
}
function findHeader(headers, candidates) {
  const lower = headers.map((h) => (h || '').trim().toLowerCase());
  for (const cand of candidates) {
    const i = lower.indexOf(cand.toLowerCase());
    if (i !== -1) return headers[i];
  }
  return null;
}
function coerceStr(v) {
  try { return String(v ?? '').trim(); } catch { return ''; }
}
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
function toUtcFromSheet(spDate) {
  if (localLooksLikeConfiguredTZ()) return spDate;
  return zonedTimeToUtcSafe(spDate, TZ);
}

function pickOne(listStr) {
  if (!listStr) return null;
  const arr = String(listStr)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

async function runOnce(app) {
  const wa = app.locals?.whatsappClient || app.whatsappClient;

  // 0) grupos-alvo
  const st = settings.get();
  const targetJids = Array.isArray(st.postGroupJids) && st.postGroupJids.length
    ? st.postGroupJids.filter(Boolean).map((x) => String(x).trim())
    : (st.resultGroupJid ? [String(st.resultGroupJid).trim()] : []);

  if (!targetJids.length) {
    return {
      ok: false,
      processed: 0,
      sent: 0,
      errors: [{ stage: 'precheck', error: 'Nenhum grupo selecionado em /admin/groups' }]
    };
  }

  // 1) Lê a planilha
  const { headers, items, spreadsheetId, tab, sheets } = await getRows();

  // 2) Mapeia cabeçalhos
  const H_ID      = findHeader(headers, ['id', 'codigo', 'código']);
  const H_DATA    = findHeader(headers, ['data', 'date']);
  const H_HORA    = findHeader(headers, ['horario', 'hora', 'horário', 'time']);
  const H_IMG     = findHeader(headers, ['url_imagem_processada', 'url_imagem', 'imagem', 'image_url']);
  const H_PROD    = findHeader(headers, ['nome_do_produto', 'nome', 'produto', 'produto_nome']);
  const H_WA_POST = findHeader(headers, ['wa_post']);
  const H_WA_AT   = findHeader(headers, ['wa_post_at', 'wa_postado_em']);

  if (!H_ID || !H_DATA || !H_HORA || !H_IMG || !H_PROD) {
    throw new Error(
      `Cabeçalhos obrigatórios faltando. Encontrados: ${JSON.stringify(headers)}. ` +
      `Obrigatórios (alguma das opções): id | data | horario | url_imagem_processada | (nome_do_produto ou nome).`
    );
  }

  // 3) Seleciona linhas "prontas"
  const now = new Date();
  const pending = [];
  const skipped = [];

  items.forEach((row, i) => {
    const rowIndex1 = i + 2;

    const id      = coerceStr(row[H_ID]);
    const data    = coerceStr(row[H_DATA]);
    const hora    = coerceStr(row[H_HORA]);
    const imgUrl  = coerceStr(row[H_IMG]);
    const product = coerceStr(row[H_PROD]);

    if (!id || !data || !hora) {
      skipped.push({ row: rowIndex1, id, reason: 'faltando id/data/hora' });
      return;
    }

    const flagPosted = coerceStr(row[H_WA_POST]).toLowerCase() === 'postado';
    if (flagPosted) { skipped.push({ row: rowIndex1, id, reason: 'WA_POST=Postado' }); return; }
    if (settings.hasPosted(id)) { skipped.push({ row: rowIndex1, id, reason: 'settings.hasPosted' }); return; }

    const text = `${data} ${hora}`;
    let spDate;
    try {
      spDate = parse(text, 'dd/MM/yyyy HH:mm', new Date());
      if (isNaN(spDate?.getTime?.())) throw new Error('data/hora inválida');
    } catch {
      skipped.push({ row: rowIndex1, id, reason: 'parseDateFail', raw: text });
      return;
    }

    const utcDate = toUtcFromSheet(spDate);
    const readyAt = new Date(utcDate.getTime() + DELAY_MIN * 60000);
    if (now < readyAt) {
      skipped.push({ row: rowIndex1, id, reason: 'ainda_nao_chegou', readyAt: readyAt.toISOString() });
      return;
    }

    if (!imgUrl || !product) {
      skipped.push({ row: rowIndex1, id, reason: 'faltando imgUrl/nome' });
      return;
    }

    pending.push({ rowIndex1, id, productName: product, imgUrl, spDate });
  });

  if (!pending.length) {
    return { ok: true, processed: 0, sent: 0, note: 'sem linhas prontas', skipped };
  }

  // 4) Cupom (uma vez por execução)
  const coupon = await fetchFirstCoupon();

  // 5) Processa e posta
  let sent = 0;
  const errors = [];

  for (const p of pending) {
    let anySentForThisRow = false;

    try {
      // 5.1) buscar resultado
      let info;
      try {
        info = await fetchResultInfo(p.id);
      } catch (e) {
        errors.push({ id: p.id, stage: 'fetchResultInfo', error: e?.message || String(e) });
        continue;
      }
      const { url: resultUrl, winner, participants } = info;

      // 5.2) gerar mídia (poster ou vídeo)
      let usedPath;
      let media;

      try {
        const wantVideo = (process.env.POST_MEDIA_TYPE || 'image').toLowerCase() === 'video';
        const mode = (process.env.VIDEO_MODE || 'overlay').toLowerCase();

        if (wantVideo && mode === 'creatomate' && typeof makeCreatomateVideo === 'function') {
          // ======= Creatomate =======
          const templateId = process.env.CREATOMATE_TEMPLATE_ID;
          const headline = 'VEJA AQUI A GANHADORA!';
          const premio = p.productName;
          const bgUrl = pickOne(process.env.VIDEO_BG_URLS);
          const musicUrl = pickOne(process.env.AUDIO_URLS);

          usedPath = await makeCreatomateVideo({
            templateId,
            headline,
            premio,
            winner: winner || 'Ganhador(a)',
            participants,
            productImageUrl: p.imgUrl,
            videoBgUrl: bgUrl,
            musicUrl,
            // outDir: resolve default in service
          });

          const buf = fs.readFileSync(usedPath);
          media = { video: buf, mimetype: 'video/mp4' };
        } else {
          // ======= Poster + Overlay (modo antigo) =======
          const dateTimeStr = format(p.spDate, "dd/MM/yyyy 'às' HH:mm");
          const posterPath = await generatePoster({
            productImageUrl: p.imgUrl,
            productName: p.productName,
            dateTimeStr,
            winner: winner || 'Ganhador(a)',
            participants
          });

          usedPath = posterPath;

          if (wantVideo) {
            const vid = await makeOverlayVideo({
              posterPath,
              duration: Number(process.env.VIDEO_DURATION || 7),
              res: process.env.VIDEO_RES || '1080x1350',
              bitrate: process.env.VIDEO_BITRATE || '2000k'
            });
            usedPath = vid;
            const buf = fs.readFileSync(vid);
            media = { video: buf, mimetype: 'video/mp4' };
          } else {
            const buf = fs.readFileSync(posterPath);
            media = { image: buf, mimetype: 'image/png' };
          }
        }
      } catch (e) {
        errors.push({ id: p.id, stage: 'prepareMedia', error: e?.message || String(e) });
        continue;
      }

      // 5.3) legenda
      const caption = mergeText(chooseTemplate(), {
        WINNER: winner || 'Ganhador(a)',
        RESULT_URL: resultUrl,
        COUPON: coupon
      });

      // 5.4) enviar
      for (const rawJid of targetJids) {
        let jid = safeStr(rawJid).trim();
        try {
          if (!jid || !jid.endsWith('@g.us')) throw new Error(`JID inválido: "${jid}"`);
          const payload = { ...media, caption: safeStr(caption) };
          await wa.sock.sendMessage(jid, payload);
          anySentForThisRow = true;
        } catch (e) {
          errors.push({
            id: p.id, stage: 'sendMessage', jid,
            mediaKeys: Object.keys(media || {}), captionLen: (caption || '').length,
            usedPath, error: e?.message || String(e)
          });
        }
      }

      // 5.5) marcar planilha
      try {
        if (anySentForThisRow) {
          const postAt = new Date().toISOString();
          await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, H_WA_POST || 'WA_POST', 'Postado');
          await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, H_WA_AT   || 'WA_POST_AT', postAt);
          settings.addPosted(p.id);
          sent++;
        }
      } catch (e) {
        errors.push({ id: p.id, stage: 'updateSheet', error: e?.message || String(e) });
      }
    } catch (e) {
      errors.push({ id: p.id, stage: 'unknown', error: e?.message || String(e) });
    }
  }

  return { ok: true, processed: pending.length, sent, errors, skipped };
}

module.exports = { runOnce };
