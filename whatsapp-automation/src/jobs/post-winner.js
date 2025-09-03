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

// ====== OPCIONAIS (se existirem) ======
let makeCreatomateVideo = null;
try {
  ({ makeCreatomateVideo } = require('../services/creatomate')); // serviço novo
} catch { /* pode não existir em deploy antigo */ }

let pickHeadline = null;
try {
  ({ pickHeadline } = require('../services/headlines')); // retorna string
} catch {}

let pickBg = null, pickMusic = null;
try {
  ({ pickBg, pickMusic } = require('../services/media-pool')); // retornam URLs
} catch {}

// ==========================================================

const TZ = process.env.TZ || 'America/Sao_Paulo';
const DELAY_MIN = Number(process.env.POST_DELAY_MINUTES ?? 10);
const DEBUG_JOB = String(process.env.DEBUG_JOB || '').trim() === '1';

// === Regras de envio do link: MESMA mensagem, sem preview
const DISABLE_LINK_PREVIEW = false;
const SEND_RESULT_URL_SEPARATE = false;
const BAILEYS_LINK_PREVIEW_OFF = true;

// ---------- utils ----------
const dlog = (...a) => { if (DEBUG_JOB) console.log('[JOB]', ...a); };
const delay = (ms) => new Promise(r => setTimeout(r, ms));

function safeStr(v) {
  try { return v == null ? '' : String(v); } catch { return ''; }
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
function pickOneCSV(listStr) {
  if (!listStr) return null;
  const arr = String(listStr)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}
function pickHeadlineSafe() {
  if (typeof pickHeadline === 'function') return pickHeadline();
  return pickOneCSV(process.env.HEADLINES) || 'VEJA AQUI A GANHADORA!';
}
function pickBgSafe() {
  if (typeof pickBg === 'function') return pickBg();
  return pickOneCSV(process.env.VIDEO_BG_URLS) || '';
}
function pickMusicSafe() {
  if (typeof pickMusic === 'function') return pickMusic();
  return pickOneCSV(process.env.AUDIO_URLS) || '';
}

// Remove URLs do texto (quando necessário)
function stripUrls(text, alsoRemove = []) {
  let out = safeStr(text);
  for (const u of alsoRemove) {
    if (u) out = out.replaceAll(u, '');
  }
  out = out.replace(/https?:\/\/\S+/g, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

// Normaliza nome do vencedor (remove inicial solta, ex. "M Murilo ...")
function normalizeName(name = '') {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2 && parts[0].length === 1) parts.shift();
  return parts.join(' ');
}

// Converte "YYYY-MM-DD" -> "DD/MM/YY"
function toDDMMYY(dateStr = '') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y.slice(-2)}`;
}

// Separa nome, data/hora e canal do campo winner
function parseWinnerMeta(winnerStr = '') {
  // pega "2025-09-03 16:54:41"
  const m = winnerStr.match(/(20\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  let shortDateTime = '';
  if (m) shortDateTime = `${toDDMMYY(m[1])} ${m[2]}`;

  // canal
  let channel = '';
  const wa = winnerStr.match(/WhatsApp:[^,]+/i);
  const fb = winnerStr.match(/Facebook:[^,]+/i);
  if (wa) channel = wa[0].trim();
  else if (fb) channel = fb[0].trim();

  // nome = winnerStr sem a data/hora e sem o canal
  let name = winnerStr
    .replace(/(20\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/, '')
    .replace(/(WhatsApp:[^,]+|Facebook:[^,]+)/i, '')
    .trim();

  name = normalizeName(name);

  return { name: name || winnerStr.trim(), shortDateTime, channel };
}

// --- preferir o socket do painel admin (/admin) ---
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

// Monta legenda espaçada, com link junto
function buildCaption({ winnerName, shortDateTime, channel, resultUrl }) {
  return [
    '🎈 Temos vencedora... olha que sucesso:',
    winnerName,
    `${shortDateTime} ${channel}`.trim(),
    '',
    'Link resultado 👇',
    resultUrl,
    '',
    '📞 Me chame aqui para combinar a entrega do prêmio: (48) 99178-4533',
    '⏰ Prazo hoje — depois faremos novo sorteio.',
    '',
    '🚨 O MELHOR do MUNDO em LIQUIDAÇÃO. Use meu cupom PEGAN 👇',
    '💳 Procure por Murilo Cerqueira - cupons só valem aqui.',
    'Meu link: https://www.natura.com.br/consultoria/clubemac',
    '🛍️ 🎟️ Cupom extra: PEGAN',
    '🚚 Frete grátis acima de R$99',
    '🎯 Mais cupons:',
    'https://clubemac.com.br/cupons/'
  ].join('\n');
}
// -------------------------------------

/**
 * Executa o job 1x.
 * @param {*} app  express app com locals.whatsappClient/waAdmin
 * @param {*} opts { dryRun?: boolean }
 */
async function runOnce(app, opts = {}) {
  const dryRun =
    !!opts.dryRun ||
    String(app?.locals?.reqDry || '').trim() === '1';
  dlog('tick start', { dryRun });

  // 0) grupos-alvo
  const st = settings.get();
  const targetJids = Array.isArray(st.postGroupJids) && st.postGroupJids.length
    ? st.postGroupJids.filter(Boolean).map((x) => String(x).trim())
    : (st.resultGroupJid ? [String(st.resultGroupJid).trim()] : []);

  if (!targetJids.length) {
    dlog('skip: nenhum grupo selecionado');
    return {
      ok: false,
      processed: 0,
      sent: 0,
      errors: [{ stage: 'precheck', error: 'Nenhum grupo selecionado em /admin/groups' }]
    };
  }
  dlog('targets', targetJids);

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

  // Opcionais (headline/bg/music por linha)
  const H_CUSTOM_HEADLINE = findHeader(headers, ['headline']);
  const H_BG_URL          = findHeader(headers, ['video_bg_url', 'bg_url']);
  const H_MUSIC_URL       = findHeader(headers, ['music_url', 'audio_url']);

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

    // opcionais por linha
    const customHeadline = H_CUSTOM_HEADLINE ? coerceStr(row[H_CUSTOM_HEADLINE]) : '';
    const bgUrl          = H_BG_URL          ? coerceStr(row[H_BG_URL])          : '';
    const musicUrl       = H_MUSIC_URL       ? coerceStr(row[H_MUSIC_URL])       : '';

    pending.push({
      rowIndex1, id,
      productName: product,
      imgUrl, spDate,
      customHeadline, bgUrl, musicUrl,
    });
  });

  if (!pending.length) {
    dlog('sem linhas prontas');
    return { ok: true, processed: 0, sent: 0, note: 'sem linhas prontas', skipped };
  }

  // 4) Cupom (uma vez por execução)
  const coupon = await fetchFirstCoupon();
  dlog('coupon', coupon);

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
      dlog('linha', p.id, { winner, participantsCount: Array.isArray(participants) ? participants.length : 0 });

      // 5.2) gerar mídia (poster ou vídeo)
      let usedPath;
      let media;

      try {
        const wantVideo = (process.env.POST_MEDIA_TYPE || 'image').toLowerCase() === 'video';
        const mode = (process.env.VIDEO_MODE || 'overlay').toLowerCase();

        // Escolhas (prioridade: planilha > listas/código > ENV CSV)
        const headline   = p.customHeadline || pickHeadlineSafe();
        const premio     = p.productName;
        const videoBgUrl = p.bgUrl    || pickBgSafe();
        const musicUrl   = p.musicUrl || pickMusicSafe();

        // Parse do vencedor
        const { name: winnerNameRaw, shortDateTime, channel } = parseWinnerMeta(winner || '');
        const winnerName = normalizeName(winnerNameRaw);

        if (wantVideo && mode === 'creatomate' && typeof makeCreatomateVideo === 'function') {
          const templateId = process.env.CREATOMATE_TEMPLATE_ID;

          usedPath = await makeCreatomateVideo({
            templateId,
            headline,
            premio,
            winner: winnerName || 'Ganhador(a)',
            participants,
            productImageUrl: p.imgUrl,
            videoBgUrl,
            musicUrl,
          });

          const buf = fs.readFileSync(usedPath);
          media = { video: buf, mimetype: 'video/mp4' };
        } else {
          // Poster (imagem) — agora com nome + meta DENTRO do banner
          const dateTimeStr = format(p.spDate, "dd/MM/yyyy 'às' HH:mm");
          const posterPath = await generatePoster({
            productImageUrl: p.imgUrl,
            productName: p.productName,
            dateTimeStr,
            winner: winnerName || 'Ganhador(a)',
            winnerMetaDateTime: shortDateTime || '',
            winnerMetaChannel:  channel || '',
            participants
          });

          usedPath = posterPath;

          if (wantVideo) {
            if (dryRun) {
              const buf = fs.readFileSync(posterPath);
              media = { image: buf, mimetype: 'image/png' };
              dlog('dry-run: pulando FFmpeg, usando poster como imagem');
            } else {
              try {
                const vid = await makeOverlayVideo({
                  posterPath,
                  duration: Number(process.env.VIDEO_DURATION || 7),
                  res: process.env.VIDEO_RES || '1080x1350',
                  bitrate: process.env.VIDEO_BITRATE || '2000k',
                  bg: videoBgUrl,
                  music: musicUrl
                });
                usedPath = vid;
                const buf = fs.readFileSync(vid);
                media = { video: buf, mimetype: 'video/mp4' };
              } catch (fferr) {
                errors.push({ id: p.id, stage: 'prepareMedia(video)', error: fferr?.message || String(fferr) });
                const buf = fs.readFileSync(posterPath);
                media = { image: buf, mimetype: 'image/png' };
              }
            }
          } else {
            const buf = fs.readFileSync(posterPath);
            media = { image: buf, mimetype: 'image/png' };
          }
        }
        dlog('midia pronta', { usedPath, keys: Object.keys(media || {}) });
      } catch (e) {
        errors.push({ id: p.id, stage: 'prepareMedia', error: e?.message || String(e) });
        continue;
      }

      // 5.3) legenda — UMA mensagem, link junto
      const parsed = parseWinnerMeta(info.winner || '');
      const caption = buildCaption({
        winnerName: normalizeName(parsed.name || 'Ganhador(a)'),
        shortDateTime: parsed.shortDateTime,
        channel: parsed.channel,
        resultUrl: info.url
      });

      // 5.4) enviar (prioriza sessão admin; se não, cliente interno)
      const sock = await getPreferredSock(app);
      if (!sock) {
        errors.push({ id: p.id, stage: 'sendMessage', error: 'WhatsApp não conectado (admin/cliente)' });
      } else if (dryRun) {
        dlog('dry-run => NÃO enviou', { to: targetJids, id: p.id, caption });
      } else {
        for (const rawJid of targetJids) {
          let jid = safeStr(rawJid).trim();
          try {
            if (!jid || !jid.endsWith('@g.us')) throw new Error(`JID inválido: "${jid}"`);
            const payload = { ...media, caption: safeStr(caption) };
            const opts = BAILEYS_LINK_PREVIEW_OFF ? { linkPreview: false } : undefined;

            await sock.sendMessage(jid, payload, opts); // UMA mensagem, sem preview
            anySentForThisRow = true;
            dlog('enviado', { jid, id: p.id });
          } catch (e) {
            errors.push({
              id: p.id, stage: 'sendMessage', jid,
              mediaKeys: Object.keys(media || {}), captionLen: (caption || '').length,
              usedPath, error: e?.message || String(e)
            });
          }
        }
      }

      // 5.5) marcar planilha
      try {
        if (!dryRun && anySentForThisRow) {
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

  dlog('tick end', { processed: pending.length, sent, errorsCount: errors.length, skippedCount: skipped.length });
  return { ok: true, processed: pending.length, sent, errors, skipped, dryRun };
}

module.exports = { runOnce };
