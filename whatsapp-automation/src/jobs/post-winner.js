// src/jobs/post-winner.js
const fs = require('fs');
const { parse, format } = require('date-fns');

// ==== IMPORT RESILIENTE + FALLBACK PARA zonedTimeToUtc ====
let zonedTimeToUtcSafe;
try {
  const tz = require('date-fns-tz');
  zonedTimeToUtcSafe = tz?.zonedTimeToUtc || tz?.default?.zonedTimeToUtc;
  if (!zonedTimeToUtcSafe) zonedTimeToUtcSafe = require('date-fns-tz/zonedTimeToUtc');
} catch (_) {}
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

// pega um template válido, com fallback seguro
function chooseTemplate() {
  if (Array.isArray(templates) && templates.length) {
    return templates[Math.floor(Math.random() * templates.length)];
  }
  return '🎉 Resultado: {{WINNER}}\n🔗 Detalhes: {{RESULT_URL}}\n💸 Cupom: {{COUPON}}';
}

// sempre retorna string, mesmo com undefined/null
function safeStr(v) {
  try { return v == null ? '' : String(v); }
  catch { return ''; }
}

// legenda sempre como string (evita toString interno do Baileys)
function mergeText(tpl, vars) {
  const s = safeStr(tpl);
  return s
    .replaceAll('{{WINNER}}', safeStr(vars.WINNER))
    .replaceAll('{{RESULT_URL}}', safeStr(vars.RESULT_URL))
    .replaceAll('{{COUPON}}', safeStr(vars.COUPON));
}

// encontra um cabeçalho real da planilha aceitando alternativas
function findHeader(headers, candidates) {
  const lower = headers.map((h) => (h || '').trim().toLowerCase());
  for (const cand of candidates) {
    const i = lower.indexOf(cand.toLowerCase());
    if (i !== -1) return headers[i]; // devolve o nome exato da planilha
  }
  return null;
}

// conversor seguro (evita "reading 'toString'")
function coerceStr(v) {
  try { return String(v ?? '').trim(); }
  catch { return ''; }
}

async function runOnce(app) {
  const wa = app.locals.whatsappClient || app.whatsappClient;

  // 0) grupos-alvo
  const st = settings.get();
  const targetJids = Array.isArray(st.postGroupJids) && st.postGroupJids.length
    ? st.postGroupJids.filter(Boolean).map(String)
    : (st.resultGroupJid ? [String(st.resultGroupJid)] : []);

  if (!targetJids.length) {
    return { ok: false, processed: 0, sent: 0, errors: [{ stage: 'precheck', error: 'Nenhum grupo selecionado em /admin/groups' }] };
  }

  // 1) Lê a planilha toda
  const { headers, items, spreadsheetId, tab, sheets } = await getRows();

  // 2) Mapeia cabeçalhos (com alternativas)
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

  // 3) Seleciona linhas "prontas" (data/hora + delay) e ainda não postadas
  const now = new Date();
  const pending = [];

  items.forEach((row, i) => {
    const rowIndex1 = i + 2; // 1-based + header
    const id   = coerceStr(row[H_ID]);
    const data = coerceStr(row[H_DATA]);
    const hora = coerceStr(row[H_HORA]);
    if (!id || !data || !hora) return;

    const flagPosted = coerceStr(row[H_WA_POST]).toLowerCase() === 'postado';
    if (flagPosted || settings.hasPosted(id)) return;

    const text = `${data} ${hora}`;
    let spDate;
    try {
      spDate = parse(text, 'dd/MM/yyyy HH:mm', new Date());
    } catch {
      return; // formato inválido
    }

    const utcDate = zonedTimeToUtcSafe(spDate, TZ);
    const readyAt = new Date(utcDate.getTime() + DELAY_MIN * 60000);
    if (now >= readyAt) {
      pending.push({
        rowIndex1,
        id,
        productName: coerceStr(row[H_PROD]),
        imgUrl: coerceStr(row[H_IMG]),
        spDate
      });
    }
  });

  if (!pending.length) {
    return { ok: true, processed: 0, sent: 0, note: 'sem linhas prontas' };
  }

  // 4) Cupom (uma vez por execução)
  const coupon = await fetchFirstCoupon();

  // 5) Para cada linha, processa e posta
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

      // 5.2) gerar arte
      let posterPath;
      try {
        const dateTimeStr = format(p.spDate, "dd/MM/yyyy 'às' HH:mm");
        posterPath = await generatePoster({
          productImageUrl: p.imgUrl,
          productName: p.productName,
          dateTimeStr,
          winner: winner || 'Ganhador(a)',
          participants
        });
        if (!posterPath) throw new Error('posterPath vazio');
      } catch (e) {
        errors.push({ id: p.id, stage: 'generatePoster', error: e?.message || String(e) });
        continue;
      }

      // 5.3) preparar mídia
      let media;
      try {
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
      } catch (e) {
        errors.push({ id: p.id, stage: 'prepareMedia', error: e?.message || String(e) });
        continue;
      }

      // 5.4) legenda (string garantida)
      const caption = mergeText(chooseTemplate(), {
        WINNER: winner || 'Ganhador(a)',
        RESULT_URL: resultUrl,
        COUPON: coupon
      });

      // 5.5) enviar (para 1..N grupos)
      for (const jid of targetJids) {
        try {
          const payload = { ...media, caption: safeStr(caption) };
          // usa diretamente o sock (mais previsível com mídia)
          await wa.sock.sendMessage(safeStr(jid), payload);
          anySentForThisRow = true;
        } catch (e) {
          errors.push({
            id: p.id,
            stage: 'sendMessage',
            jid: safeStr(jid),
            media: Object.keys(media || {}),
            error: e?.message || String(e)
          });
        }
      }

      // 5.6) marcar na planilha apenas se pelo menos 1 envio OK
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

  return { ok: true, processed: pending.length, sent, errors };
}

module.exports = { runOnce };
