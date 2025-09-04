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

// === Flags para evitar preview e/ou enviar URL separada ===
const DISABLE_LINK_PREVIEW = String(process.env.DISABLE_LINK_PREVIEW || '1') === '1'; // remove preview do resultado
const SEND_RESULT_URL_SEPARATE = String(process.env.SEND_RESULT_URL_SEPARATE || '1') === '1'; // manda o link em msg separada (se não estiver na legenda)
const BAILEYS_LINK_PREVIEW_OFF = String(process.env.BAILEYS_LINK_PREVIEW_OFF || '1') === '1'; // { linkPreview:false } nas opções

// ---------- utils ----------
const dlog = (...a) => { if (DEBUG_JOB) console.log('[JOB]', ...a); };
const delay = (ms) => new Promise(r => setTimeout(r, ms));

let _lastTplIndex = -1;
function chooseTemplate() {
  const templates = require('../services/texts');
  if (!Array.isArray(templates) || !templates.length) {
    return '🎉 Resultado: {{WINNER_BLOCK}}\n🔗 Detalhes: {{RESULT_URL}}\n💸 Cupom: {{COUPON}}';
  }
  // evita repetir o último
  if (templates.length === 1) return templates[0];
  let idx;
  do { idx = Math.floor(Math.random() * templates.length); } while (idx === _lastTplIndex);
  _lastTplIndex = idx;
  return templates[idx];
}
function safeStr(v) {
  try { return v == null ? '' : String(v); } catch { return ''; }
}

// substitui {{WINNER_BLOCK}} quando existir; senão, injeta o bloco em {{WINNER}}
function mergeText(tpl, vars) {
  let s = safeStr(tpl);
  const block = safeStr(vars.WINNER_BLOCK || '');
  if (s.includes('{{WINNER_BLOCK}}')) s = s.replaceAll('{{WINNER_BLOCK}}', block);
  else if (block) s = s.replaceAll('{{WINNER}}', block);
  s = s
    .replaceAll('{{WINNER}}', safeStr(vars.WINNER))
    .replaceAll('{{RESULT_URL}}', safeStr(vars.RESULT_URL))
    .replaceAll('{{COUPON}}', safeStr(vars.COUPON));
  return s;
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
// Fallbacks se os serviços opcionais não existirem
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

// Remove APENAS URLs específicas (para manter os links fixos do texts.js)
function stripSpecificUrls(text, urls = []) {
  let out = safeStr(text);
  for (const u of urls) {
    if (!u) continue;
    // remove literal e variações com / no fim
    out = out.replaceAll(u, '');
    if (u.endsWith('/')) out = out.replaceAll(u.slice(0, -1), '');
    else out = out.replaceAll(u + '/', '');
  }
  // normaliza espaços
  return out.replace(/\s{2,}/g, ' ').trim();
}

// extrai nome + data/hora + canal do campo winner
function parseWinnerDetailed(winnerStr = '') {
  const raw = String(winnerStr || '').trim();

  // nome = tudo antes do primeiro " 20YY-"
  const dtMatch = raw.match(/\s(20\d{2}-\d{2}-\d{2})\s(\d{2}:\d{2}:\d{2})/);
  let name = raw;
  if (dtMatch) name = raw.slice(0, dtMatch.index).trim();

  let metaDateTime = '';
  if (dtMatch) {
    const [yyyy, mm, dd] = dtMatch[1].split('-');
    metaDateTime = `Entrou na lista: ${dd}/${mm}/${String(yyyy).slice(-2)} ${dtMatch[2]}`;
  }

  let metaChannel = '';
  const ch = raw.match(/(WhatsApp:[^•]+|Facebook:[^•]+)/i);
  if (ch) metaChannel = `Acesso via: ${ch[1].trim()}`;

  return { name, metaDateTime, metaChannel };
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

      const { name: winnerName, metaDateTime, metaChannel } = parseWinnerDetailed(winner || '');

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

        if (wantVideo && mode === 'creatomate' && typeof makeCreatomateVideo === 'function') {
          // ======= Creatomate =======
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
          // ======= Poster + Vídeo Overlay (FFmpeg) =======
          const dateTimeStr = format(p.spDate, "dd/MM/yyyy 'às' HH:mm");
          const posterPath = await generatePoster({
            productImageUrl: p.imgUrl,
            productName: p.productName,
            dateTimeStr,
            winner: winnerName || 'Ganhador(a)',
            winnerMetaDateTime: metaDateTime,
            winnerMetaChannel:  metaChannel,
            winnerMeta: winner, // retrocompat
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
                dlog('FFmpeg falhou, fallback para imagem (poster)', fferr?.message || fferr);
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

      // 5.3) legenda — WINNER_BLOCK em 3 linhas
      const resultUrlStr = safeStr(resultUrl);
      const winnerBlock =
        `Ganhador(a): ${winnerName || 'Ganhador(a)'}\n` +
        (metaDateTime ? `${metaDateTime}\n` : '') +
        (metaChannel  ? `${metaChannel}` : '');

      const captionFull = mergeText(chooseTemplate(), {
        WINNER: winnerName || 'Ganhador(a)',
        WINNER_BLOCK: winnerBlock.trim(),
        RESULT_URL: resultUrlStr,
        COUPON: coupon
      });

      // Evita preview do LINK DE RESULTADO, mas mantém os links fixos do texts.js
      const captionOut = (DISABLE_LINK_PREVIEW)
        ? stripSpecificUrls(captionFull, [resultUrlStr])
        : captionFull;

      const linkAlreadyInside = resultUrlStr && captionOut.includes(resultUrlStr);

      // 5.4) enviar (prioriza sessão admin; se não, cliente interno)
      const sock = await getPreferredSock(app);
      if (!sock) {
        errors.push({ id: p.id, stage: 'sendMessage', error: 'WhatsApp não conectado (admin/cliente)' });
      } else if (dryRun) {
        dlog('dry-run => NÃO enviou', { to: targetJids, id: p.id, caption: captionOut, link: resultUrlStr });
      } else {
        for (const rawJid of targetJids) {
          let jid = safeStr(rawJid).trim();
          try {
            if (!jid || !jid.endsWith('@g.us')) throw new Error(`JID inválido: "${jid}"`);
            const payload = { ...media, caption: safeStr(captionOut) };
            const opts = BAILEYS_LINK_PREVIEW_OFF ? { linkPreview: false } : undefined;

            await sock.sendMessage(jid, payload, opts); // imagem/vídeo

            // (Opcional) manda o link do resultado em uma segunda mensagem, somente se NÃO estiver na legenda
            if (SEND_RESULT_URL_SEPARATE && resultUrlStr && !linkAlreadyInside) {
              await delay(500);
              await sock.sendMessage(jid, { text: resultUrlStr }, opts);
            }

            anySentForThisRow = true;
            dlog('enviado', { jid, id: p.id, withLink: !!(SEND_RESULT_URL_SEPARATE && resultUrlStr && !linkAlreadyInside) });
          } catch (e) {
            errors.push({
              id: p.id, stage: 'sendMessage', jid,
              mediaKeys: Object.keys(media || {}), captionLen: (captionOut || '').length,
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
