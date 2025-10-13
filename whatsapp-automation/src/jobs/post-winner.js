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
const { fetchFirstCoupon, fetchTopCoupons } = require('../services/coupons');
const { generatePoster } = require('../services/media');
const { makeOverlayVideo } = require('../services/video');

// ====== OPCIONAIS (se existirem) ======
let makeCreatomateVideo = null;
try { ({ makeCreatomateVideo } = require('../services/creatomate')); } catch {}
let pickHeadline = null;
try { ({ pickHeadline } = require('../services/headlines')); } catch {}
let pickBg = null, pickMusic = null;
try { ({ pickBg, pickMusic } = require('../services/media-pool')); } catch {}

// ==========================================================

const TZ = process.env.TZ || 'America/Sao_Paulo';
const DELAY_MIN = Number(process.env.POST_DELAY_MINUTES ?? 10);
const DEBUG_JOB = String(process.env.DEBUG_JOB || '').trim() === '1';

// Janela de segurança para não varrer histórico
const MAX_AGE_H = Number(process.env.POST_MAX_AGE_HOURS || 48);

// === Flags ===
const DISABLE_LINK_PREVIEW = String(process.env.DISABLE_LINK_PREVIEW || '1') === '1';
const SEND_RESULT_URL_SEPARATE = false; // NUNCA enviar link em mensagem separada
const BAILEYS_LINK_PREVIEW_OFF = String(process.env.BAILEYS_LINK_PREVIEW_OFF || '1') === '1';

// ===== Ritmo seguro (iguais ao promo) =====
const SAFE_SEND_GLOBAL_MIN_GAP_MIN = Number(process.env.SAFE_SEND_GLOBAL_MIN_GAP_MIN || 5);
const SAFE_SEND_COOLDOWN_MIN       = Number(process.env.SAFE_SEND_COOLDOWN_MIN || 10);
const SAFE_SEND_JITTER_MIN_SEC     = Number(process.env.SAFE_SEND_JITTER_MIN_SEC || 30);
const SAFE_SEND_JITTER_MAX_SEC     = Number(process.env.SAFE_SEND_JITTER_MAX_SEC || 120);
const SAFE_SEND_MAX_GROUPS_PER_HOUR= Number(process.env.SAFE_SEND_MAX_GROUPS_PER_HOUR || 12);
const SAFE_SEND_DAILY_CAP          = Number(process.env.SAFE_SEND_DAILY_CAP || 100);
const SAFE_SEND_LOCK_TTL_SEC       = Number(process.env.SAFE_SEND_LOCK_TTL_SEC || 30);

// ---------- utils ----------
const dlog = (...a) => { if (DEBUG_JOB) console.log('[JOB]', ...a); };
const delay = (ms) => new Promise(r => setTimeout(r, ms));

let _lastTplIndex = -1;
function chooseTemplateRandom() {
  const templates = require('../services/texts');
  if (!Array.isArray(templates) || !templates.length) {
    return '🎉 Resultado: {{WINNER_BLOCK}}\n🔗 Detalhes: {{RESULT_URL}}\n💸 Cupom: {{COUPON}}';
  }
  if (templates.length === 1) return templates[0];
  let idx;
  do { idx = Math.floor(Math.random() * templates.length); } while (idx === _lastTplIndex);
  _lastTplIndex = idx;
  return templates[idx];
}
function safeStr(v) {
  try { return v == null ? '' : String(v); } catch { return ''; }
}

// rotação determinística por grupo
function nextWinnerTemplateFor(ss, jid) {
  let templates;
  try { templates = require('../services/texts'); } catch { templates = []; }
  if (!Array.isArray(templates) || templates.length === 0) {
    return chooseTemplateRandom();
  }
  const key = `winner:${jid}`;
  const idx = Number(ss.cursors[key] || 0);
  const tpl = templates[(idx % templates.length) || 0];
  ss.cursors[key] = idx + 1;
  return tpl;
}

// Constrói o bloco do vencedor (3 linhas)
function buildWinnerBlock(name, metaDateTime, metaChannel, withLabel = true) {
  const line1 = withLabel ? `Ganhador(a): ${name || 'Ganhador(a)'}` : `${name || 'Ganhador(a)'}`;
  const line2 = metaDateTime ? `${metaDateTime}` : '';
  const line3 = metaChannel ? `${metaChannel}` : '';
  return [line1, line2, line3].filter(Boolean).join('\n');
}

// Substituição com tratamento:
function mergeText(tpl, vars) {
  let s = safeStr(tpl);

  const name = safeStr(vars.WINNER);
  const dt   = safeStr(vars.WINNER_DT);
  const ch   = safeStr(vars.WINNER_CH);

  const blockFull    = buildWinnerBlock(name, dt, ch, true);

  if (s.includes('{{WINNER_BLOCK}}')) {
    s = s.replaceAll('{{WINNER_BLOCK}}', blockFull);
  }

  const reLabelName = /(Ganhador(?:\(a\))?:\s*){{WINNER}}/gi;
  if (reLabelName.test(s)) {
    s = s.replace(reLabelName, (_m, label) => {
      const firstLine = `${label}${name}`;
      const rest = [dt, ch].filter(Boolean).join('\n');
      return rest ? `${firstLine}\n${rest}` : firstLine;
    });
  } else if (s.includes('{{WINNER}}')) {
    s = s.replaceAll('{{WINNER}}', blockFull);
  }

  s = s
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
  const arr = String(listStr).split(',').map(s => s.trim()).filter(Boolean);
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

// Remove APENAS a URL do resultado, mantendo links fixos dos templates
function stripSpecificUrls(text, urls = []) {
  let out = safeStr(text);
  for (const u of urls) {
    if (!u) continue;
    out = out.replaceAll(u, '');
    if (u.endsWith('/')) out = out.replaceAll(u.slice(0, -1), '');
    else out = out.replaceAll(u + '/', '');
  }
  return out;
}

// Remove letra de avatar no começo do nome
function stripLeadingAvatarLetter(name = '') {
  const m = String(name).match(/^([A-ZÁÀÂÃÉÈÊÍÌÎÓÒÔÕÚÙÛÇ])\s+(.+)$/i);
  if (m && m[2] && m[2].length >= 2) return m[2].trim();
  return String(name).trim();
}

// extrai nome + data/hora + canal do campo winner
function parseWinnerDetailed(winnerStr = '') {
  const raw = String(winnerStr || '').replace(/\s+/g, ' ').trim();

  const dtMatch = raw.match(/\s(20\d{2}-\d{2}-\d{2})\s(\d{2}:\d{2}:\d{2})/);
  let name = raw;
  if (dtMatch) name = raw.slice(0, dtMatch.index).trim();
  name = stripLeadingAvatarLetter(name);

  let metaDateTime = '';
  if (dtMatch) {
    const [yyyy, mm, dd] = dtMatch[1].split('-');
    metaDateTime = `Entrou na lista: ${dd}/${mm}/${String(yyyy).slice(-2)} ${dtMatch[2]}`;
  }

  let metaChannel = '';
  const ch = raw.match(/(WhatsApp:[^•]+|Facebook:[^•]+|Instagram:[^•]+)/i);
  if (ch) metaChannel = `Acesso via: ${ch[1].trim()}`;

  return { name, metaDateTime, metaChannel };
}

function winnerLooksReady(info) {
  const raw = String(info?.winner || '');
  if (!raw) return false;
  if (/ser[áa]\s+anunciado/i.test(raw)) return false;
  const { name, metaDateTime } = parseWinnerDetailed(raw);
  if (!name || name.length < 3) return false;
  if (!metaDateTime) return false;
  return true;
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

function ensureLinkInsideCaption(caption, resultUrl) {
  const cap = String(caption || '');
  const url = String(resultUrl || '').trim();
  if (!url) return cap;
  if (cap.includes(url)) return cap;
  const join = cap.trim().length ? `${cap.trim()}\n\n` : '';
  return `${join}Link resultado👇\n${url}`;
}

// ---- helpers idempotência por grupo ----
function parseCsvSet(csv) {
  const s = String(csv || '');
  if (!s.trim()) return new Set();
  return new Set(s.split(',').map(x => x.trim()).filter(Boolean));
}
function setToCsv(set) { return Array.from(set).join(','); }

// ----- estado seguro compartilhado -----
function getSafeState() {
  const cur = settings.get();
  const ss = cur.safeSend || {};
  return {
    lastSentAtByGroup: ss.lastSentAtByGroup || {},
    cursors: ss.cursors || {},
    sentLastHour: Array.isArray(ss.sentLastHour) ? ss.sentLastHour : [],
    sentToday: Array.isArray(ss.sentToday) ? ss.sentToday : [],
    lastGlobalSentAt: Number(ss.lastGlobalSentAt || 0),
    locks: ss.locks || {}
  };
}
function saveSafeState(next) {
  const cur = settings.get();
  settings.set({ ...cur, safeSend: next });
}
function pruneCounters(ss, now) {
  const hrAgo = now - 60*60*1000;
  const dayAgo = now - 24*60*60*1000;
  ss.sentLastHour = ss.sentLastHour.filter(ts => ts >= hrAgo);
  ss.sentToday    = ss.sentToday.filter(ts => ts >= dayAgo);
}
function eligibleGlobal(ss, now) {
  pruneCounters(ss, now);
  const gapOk = (now - (ss.lastGlobalSentAt || 0)) >= SAFE_SEND_GLOBAL_MIN_GAP_MIN * 60 * 1000;
  const hourOk = ss.sentLastHour.length < SAFE_SEND_MAX_GROUPS_PER_HOUR;
  const dayOk = ss.sentToday.length < SAFE_SEND_DAILY_CAP;
  return gapOk && hourOk && dayOk;
}
function eligibleGroup(ss, jid, now) {
  const last = Number(ss.lastSentAtByGroup[jid] || 0);
  return (now - last) >= SAFE_SEND_COOLDOWN_MIN * 60 * 1000;
}
function pickNextGroup(candidates, ss, now) {
  const list = candidates
    .filter(j => eligibleGroup(ss, j, now))
    .sort((a,b) => (ss.lastSentAtByGroup[a]||0) - (ss.lastSentAtByGroup[b]||0));
  return list[0] || null;
}

async function runOnce(app, opts = {}) {
  const dryRun =
    !!opts.dryRun ||
    String(app?.locals?.reqDry || '').trim() === '1';
  dlog('tick start', { dryRun });

  const st = settings.get();
  const targetJids = Array.isArray(st.postGroupJids) && st.postGroupJids.length
    ? st.postGroupJids.filter(Boolean).map((x) => String(x).trim())
    : (st.resultGroupJid ? [String(st.resultGroupJid).trim()] : []);

  if (!targetJids.length) {
    dlog('skip: nenhum grupo selecionado');
    return { ok: false, processed: 0, sent: 0, errors: [{ stage: 'precheck', error: 'Nenhum grupo selecionado em /admin/groups' }] };
  }
  dlog('targets', targetJids);

  const { headers, items, spreadsheetId, tab, sheets } = await getRows();

  const H_ID       = findHeader(headers, ['id', 'codigo', 'código']);
  const H_DATA     = findHeader(headers, ['data', 'date']);
  const H_HORA     = findHeader(headers, ['horario', 'hora', 'horário', 'time']);
  const H_IMG      = findHeader(headers, ['url_imagem_processada', 'url_imagem', 'imagem', 'image_url']);
  const H_PROD     = findHeader(headers, ['nome_do_produto', 'nome', 'produto', 'produto_nome']);
  const H_WA_POST  = findHeader(headers, ['wa_post']);
  const H_WA_AT    = findHeader(headers, ['wa_post_at', 'wa_postado_em']);
  const H_WA_GROUPS= findHeader(headers, ['wa_post_groups','wa_groups','wa_grupos']); // modo por grupo

  const H_CUSTOM_HEADLINE = findHeader(headers, ['headline']);
  const H_BG_URL          = findHeader(headers, ['video_bg_url', 'bg_url']);
  const H_MUSIC_URL       = findHeader(headers, ['music_url', 'audio_url']);

  if (!H_ID || !H_DATA || !H_HORA || !H_IMG || !H_PROD) {
    throw new Error(
      `Cabeçalhos obrigatórios faltando. Encontrados: ${JSON.stringify(headers)}. ` +
      `Obrigatórios (alguma das opções): id | data | horario | url_imagem_processada | (nome_do_produto ou nome).`
    );
  }

  const usePerGroupMode = !!H_WA_GROUPS;

  const now = new Date();
  const nowTs = now.getTime();
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

    if (!usePerGroupMode) {
      const flagPosted = coerceStr(row[H_WA_POST]).toLowerCase() === 'postado';
      if (flagPosted) { skipped.push({ row: rowIndex1, id, reason: 'WA_POST=Postado' }); return; }
      if (settings.hasPosted(id)) { skipped.push({ row: rowIndex1, id, reason: 'settings.hasPosted' }); return; }
    }

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

    const tooOld = (now - utcDate) > MAX_AGE_H * 60 * 60 * 1000;
    if (tooOld) { skipped.push({ row: rowIndex1, id, reason: 'older_than_window' }); return; }
    if (now < readyAt) { skipped.push({ row: rowIndex1, id, reason: 'ainda_nao_chegou', readyAt: readyAt.toISOString() }); return; }
    if (!imgUrl || !product) { skipped.push({ row: rowIndex1, id, reason: 'faltando imgUrl/nome' }); return; }

    const customHeadline = H_CUSTOM_HEADLINE ? coerceStr(row[H_CUSTOM_HEADLINE]) : '';
    const bgUrl          = H_BG_URL          ? coerceStr(row[H_BG_URL])          : '';
    const musicUrl       = H_MUSIC_URL       ? coerceStr(row[H_MUSIC_URL])       : '';

    let postedSet = new Set();
    if (usePerGroupMode) postedSet = parseCsvSet(row[H_WA_GROUPS]);

    const remainingJids = usePerGroupMode ? targetJids.filter(j => !postedSet.has(j)) : targetJids.slice();
    if (usePerGroupMode && remainingJids.length === 0) {
      skipped.push({ row: rowIndex1, id, reason: 'todos_grupos_ja_postados' });
      return;
    }

    pending.push({
      rowIndex1, id,
      productName: product,
      imgUrl, spDate,
      customHeadline, bgUrl, musicUrl,
      postedSet, remainingJids
    });
  });

  if (!pending.length) {
    dlog('sem linhas prontas');
    return { ok: true, processed: 0, sent: 0, note: 'sem linhas prontas', skipped };
  }

  // 1×1 por execução
  let sent = 0;
  const errors = [];

  // percorre linhas até achar 1 grupo elegível e postar
  for (const p of pending) {
    const ss = getSafeState();
    if (!eligibleGlobal(ss, nowTs)) { dlog('bloqueado por ritmo global'); break; }

    const candidate = pickNextGroup(p.remainingJids, ss, nowTs);
    if (!candidate) { continue; }

    // trava (evita duplicidade durante jitter)
    const lockKey = `winner:${candidate}`;
    const lockUntil = Number(ss.locks[lockKey] || 0);
    if (nowTs < lockUntil) { continue; }
    ss.locks[lockKey] = nowTs + SAFE_SEND_LOCK_TTL_SEC * 1000;
    saveSafeState(ss);

    // buscar resultado
    let info;
    try {
      info = await fetchResultInfo(p.id);
    } catch (e) {
      errors.push({ id: p.id, stage: 'fetchResultInfo', error: e?.message || String(e) });
      // solta lock
      const s2 = getSafeState(); delete s2.locks[lockKey]; saveSafeState(s2);
      continue;
    }
    const { url: resultUrl, winner, participants } = info;
    if (!winnerLooksReady(info)) {
      const s2 = getSafeState(); delete s2.locks[lockKey]; saveSafeState(s2);
      skipped.push({ id: p.id, reason: 'winner_not_ready' });
      continue;
    }
    const { name: winnerName, metaDateTime, metaChannel } = parseWinnerDetailed(winner || '');

    // mídia
    let usedPath;
    let media;
    try {
      const wantVideo = (process.env.POST_MEDIA_TYPE || 'image').toLowerCase() === 'video';
      const mode = (process.env.VIDEO_MODE || 'overlay').toLowerCase();

      const headline   = p.customHeadline || pickHeadlineSafe();
      const premio     = p.productName;
      const videoBgUrl = p.bgUrl    || pickBgSafe();
      const musicUrl   = p.musicUrl || pickMusicSafe();

      if (wantVideo && mode === 'creatomate' && typeof makeCreatomateVideo === 'function') {
        const templateId = process.env.CREATOMATE_TEMPLATE_ID;
        usedPath = await makeCreatomateVideo({
          templateId, headline, premio,
          winner: winnerName || 'Ganhador(a)',
          participants, productImageUrl: p.imgUrl,
          videoBgUrl, musicUrl,
        });
        const buf = fs.readFileSync(usedPath);
        media = { video: buf, mimetype: 'video/mp4' };
      } else {
        const dateTimeStr = format(p.spDate, "dd/MM/yyyy 'às' HH:mm");
        const posterPath = await generatePoster({
          productImageUrl: p.imgUrl,
          productName: p.productName,
          dateTimeStr,
          winner: winnerName || 'Ganhador(a)',
          winnerMetaDateTime: metaDateTime,
          winnerMetaChannel:  metaChannel,
          winnerMeta: winner,
          participants
        });
        usedPath = posterPath;
        if (wantVideo) {
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
            const buf = fs.readFileSync(posterPath);
            media = { image: buf, mimetype: 'image/png' };
            dlog('FFmpeg falhou, fallback para imagem (poster)', fferr?.message || fferr);
          }
        } else {
          const buf = fs.readFileSync(posterPath);
          media = { image: buf, mimetype: 'image/png' };
        }
      }
    } catch (e) {
      errors.push({ id: p.id, stage: 'prepareMedia', error: e?.message || String(e) });
      const s2 = getSafeState(); delete s2.locks[lockKey]; saveSafeState(s2);
      continue;
    }

    // legenda com rotação por grupo
    const tpl = nextWinnerTemplateFor(ss, candidate);
    const resultUrlStr = safeStr(resultUrl);
    let captionFull = mergeText(tpl, {
      WINNER: winnerName || 'Ganhador(a)',
      WINNER_DT: metaDateTime,
      WINNER_CH: metaChannel,
      RESULT_URL: resultUrlStr,
      COUPON: (await (async () => {
        try {
          const list = await fetchTopCoupons(2);
          if (Array.isArray(list) && list.length > 1) return `${list[0]} ou ${list[1]}`;
          if (Array.isArray(list) && list.length === 1) return list[0];
        } catch {}
        return await fetchFirstCoupon();
      })())
    });
    captionFull = ensureLinkInsideCaption(captionFull, resultUrlStr);
    const captionOut = captionFull;

    // enviar
    const sock = await getPreferredSock(app);
    if (!sock) {
      errors.push({ id: p.id, stage: 'sendMessage', error: 'WhatsApp não conectado (admin/cliente)' });
      const s2 = getSafeState(); delete s2.locks[lockKey]; saveSafeState(s2);
      break;
    }

    if (dryRun) {
      dlog('dry-run => NÃO enviou', { to: candidate, id: p.id });
      const s2 = getSafeState(); delete s2.locks[lockKey]; saveSafeState(s2);
      break;
    }

    const jitter = Math.max(0, Math.min(SAFE_SEND_JITTER_MAX_SEC, SAFE_SEND_JITTER_MIN_SEC + Math.floor(Math.random() * (SAFE_SEND_JITTER_MAX_SEC - SAFE_SEND_JITTER_MIN_SEC + 1))));
    await delay(jitter * 1000);

    const opts = BAILEYS_LINK_PREVIEW_OFF ? { linkPreview: false } : undefined;
    await sock.sendMessage(candidate, { ...media, caption: safeStr(captionOut) }, opts);

    // marca grupo na planilha imediatamente
    if (usePerGroupMode) {
      p.postedSet.add(candidate);
      const headerName = H_WA_GROUPS || 'WA_POST_GROUPS';
      try {
        await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, headerName, setToCsv(p.postedSet));
      } catch (e) {
        errors.push({ id: p.id, stage: 'updateSheet(WA_POST_GROUPS)', error: e?.message || String(e) });
      }
    }

    // marca linha (não bloqueia futuramente em modo por grupo)
    try {
      const postAt = new Date().toISOString();
      await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, H_WA_POST || 'WA_POST', 'Postado');
      await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, H_WA_AT   || 'WA_POST_AT', postAt);
      if (!usePerGroupMode) settings.addPosted(p.id);
    } catch (e) {
      errors.push({ id: p.id, stage: 'updateSheet', error: e?.message || String(e) });
    }

    // atualiza ritmo e cursor
    const ts = Date.now();
    ss.lastSentAtByGroup[candidate] = ts;
    ss.lastGlobalSentAt = ts;
    pruneCounters(ss, ts);
    ss.sentLastHour.push(ts);
    ss.sentToday.push(ts);
    delete ss.locks[lockKey];
    saveSafeState(ss);

    sent = 1;
    break; // 1×1 por execução
  }

  dlog('tick end', { processed: pending.length, sent, errorsCount: errors.length, skippedCount: skipped.length });
  return { ok: true, processed: pending.length, sent, errors, skipped, dryRun };
}

module.exports = { runOnce };
