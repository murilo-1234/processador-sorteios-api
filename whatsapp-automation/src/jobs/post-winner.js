// src/jobs/post-winner.js
const fs = require('fs');
const { parse, format } = require('date-fns');

// ==== IMPORT RESILIENTE + FALLBACK PARA zonedTimeToUtc ====
let zonedTimeToUtcSafe;
try {
  const tz = require('date-fns-tz');
  zonedTimeToUtcSafe = tz?.zonedTimeToUtc || tz?.default?.zonedTimeToUtc;
  if (!zonedTimeToUtcSafe) {
    // alguns builds expõem por submódulo
    zonedTimeToUtcSafe = require('date-fns-tz/zonedTimeToUtc');
  }
} catch (_) { /* ignora */ }
if (typeof zonedTimeToUtcSafe !== 'function') {
  // Fallback simples para SP (UTC-03). Permite ajustar por env se precisar.
  const FALLBACK_OFFSET_MIN = Number(process.env.TZ_OFFSET_MINUTES || -180); // SP = -180
  zonedTimeToUtcSafe = (date /*, tz */) => {
    const d = date instanceof Date ? date : new Date(date);
    // "data/hora de SP" -> UTC: somar +3h
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

// 2) legenda sempre como string (mais defensivo)
function mergeText(tpl, vars) {
  const s = String(tpl || '');
  return s
    .replaceAll('{{WINNER}}', vars.WINNER)
    .replaceAll('{{RESULT_URL}}', vars.RESULT_URL)
    .replaceAll('{{COUPON}}', vars.COUPON);
}

// encontra um cabeçalho real da planilha aceitando alternativas
function findHeader(headers, candidates) {
  const lower = headers.map((h) => (h || '').trim().toLowerCase());
  for (const cand of candidates) {
    const i = lower.indexOf(cand.toLowerCase());
    if (i !== -1) return headers[i]; // devolve o nome exato
  }
  return null;
}

// 1) conversor mais seguro (evita "reading 'toString'")
function coerceStr(v) {
  try { return String(v ?? '').trim(); }
  catch { return ''; }
}

async function runOnce(app) {
  const wa = app.locals.whatsappClient || app.whatsappClient;

  // 1) Lê a planilha toda
  const { headers, items, spreadsheetId, tab, sheets } = await getRows();

  // 2) Mapeia cabeçalhos (com alternativas)
  const H_ID      = findHeader(headers, ['id', 'codigo', 'código']);
  const H_DATA    = findHeader(headers, ['data', 'date']);
  const H_HORA    = findHeader(headers, ['horario', 'hora', 'horário', 'time']);
  const H_IMG     = findHeader(headers, ['url_imagem_processada', 'url_imagem', 'imagem', 'image_url']);
  // Aceita "nome_do_produto" OU "nome"
  const H_PROD    = findHeader(headers, ['nome_do_produto', 'nome', 'produto', 'produto_nome']);
  // Colunas de controle para o WhatsApp
  const H_WA_POST = findHeader(headers, ['wa_post']);
  const H_WA_AT   = findHeader(headers, ['wa_post_at', 'wa_postado_em']);

  if (!H_ID || !H_DATA || !H_HORA || !H_IMG || !H_PROD) {
    throw new Error(
      `Cabeçalhos obrigatórios faltando. Achou: ${JSON.stringify(headers)}. ` +
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

    // Se já marcado como postado, ignora
    const flagPosted = coerceStr(row[H_WA_POST]).toLowerCase() === 'postado';
    if (flagPosted || settings.hasPosted(id)) return;

    // Data/Hora São Paulo -> UTC + delay
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

  // 4) Cupom (uma vez)
  const coupon = await fetchFirstCoupon();

  // 5) Para cada linha, processa e posta (com try/catch por etapa)
  let sent = 0;
  const errors = [];

  for (const p of pending) {
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

      // 5.4) legenda
      const caption = mergeText(chooseTemplate(), {
        WINNER: winner || 'Ganhador(a)',
        RESULT_URL: resultUrl,
        COUPON: coupon
      });

      // 5.5) enviar (JID normalizado; compatível com postGroupJids OU resultGroupJid)
      try {
        const st = settings.get();

        const baseJids = Array.isArray(st.postGroupJids) && st.postGroupJids.length
          ? st.postGroupJids
          : [st.resultGroupJid];

        const jids = baseJids
          .map(j => String(j ?? '').trim())
          .filter(Boolean);

        if (!jids.length) throw new Error('Nenhum grupo selecionado em /admin/groups');

        if (!wa?.sock?.sendMessage) {
          throw new Error('WhatsApp socket indisponível (sock.sendMessage ausente)');
        }

        const payload = { ...media, caption: String(caption ?? '') };

        // envia para 1 ou mais grupos (sem quebrar compatibilidade)
        for (const jid of jids) {
          await wa.sock.sendMessage(jid, payload);
        }
      } catch (e) {
        errors.push({ id: p.id, stage: 'sendMessage', error: e?.message || String(e) });
        continue;
      }

      // 5.6) marcar na planilha
      try {
        const postAt = new Date().toISOString();
        await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, 'WA_POST', 'Postado');
        await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, 'WA_POST_AT', postAt);
        settings.addPosted(p.id);
        sent++;
      } catch (e) {
        errors.push({ id: p.id, stage: 'updateSheet', error: e?.message || String(e) });
        // segue para o próximo
      }
    } catch (e) {
      errors.push({ id: p.id, stage: 'unknown', error: e?.message || String(e) });
    }
  }

  return { ok: true, processed: pending.length, sent, errors };
}

module.exports = { runOnce };
