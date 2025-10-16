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
  const FALLBACK_OFFSET_MIN = Number(process.env.TZ_OFFSET_MINUTES || -180);
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

const { assignRandomTextsToGroups } = require('../services/text-shuffler');
const { acquire: acquireJobLock } = require('../services/job-lock');
const ledger = require('../services/send-ledger');

// ==========================================================
const TZ = process.env.TZ || 'America/Sao_Paulo';
const DELAY_MIN = Number(process.env.POST_DELAY_MINUTES ?? 10);
const DEBUG_JOB = String(process.env.DEBUG_JOB || '').trim() === '1';
const GROUP_ORDER = String(process.env.GROUP_ORDER || 'shuffle').toLowerCase();
const MAX_AGE_H = Number(process.env.POST_MAX_AGE_HOURS || 48);

// 🆕 Intervalo entre grupos (padrão: 5 minutos)
const GROUP_INTERVAL_MINUTES = Number(process.env.GROUP_POST_INTERVAL_MINUTES || 5);

const DISABLE_LINK_PREVIEW = String(process.env.DISABLE_LINK_PREVIEW || '1') === '1';
const SEND_RESULT_URL_SEPARATE = false;
const BAILEYS_LINK_PREVIEW_OFF = String(process.env.BAILEYS_LINK_PREVIEW_OFF || '1') === '1';

// ---------- utils ----------
const dlog = (...a) => { if (DEBUG_JOB) console.log('[JOB]', ...a); };

let _templates = null;
function templatesList() {
  if (_templates) return _templates;
  try {
    const arr = require('../services/texts');
    if (Array.isArray(arr) && arr.length) _templates = arr.slice();
  } catch {}
  if (!_templates) _templates = ['🎉 Resultado: {{WINNER_BLOCK}}\n🔗 Detalhes: {{RESULT_URL}}\n💸 Cupom: {{COUPON}}'];
  return _templates;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function safeStr(v) {
  try { return v == null ? '' : String(v); } catch { return ''; }
}

function buildWinnerBlock(name, metaDateTime, metaChannel, withLabel = true) {
  const line1 = withLabel ? `Ganhador(a): ${name || 'Ganhador(a)'}` : `${name || 'Ganhador(a)'}`;
  const line2 = metaDateTime ? `${metaDateTime}` : '';
  const line3 = metaChannel ? `${metaChannel}` : '';
  return [line1, line2, line3].filter(Boolean).join('\n');
}

function mergeText(tpl, vars) {
  let s = safeStr(tpl);
  const name = safeStr(vars.WINNER);
  const dt   = safeStr(vars.WINNER_DT);
  const ch   = safeStr(vars.WINNER_CH);

  const blockFull    = buildWinnerBlock(name, dt, ch, true);
  const blockNoLabel = buildWinnerBlock(name, dt, ch, false);

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

function coerceStr(v) { try { return String(v ?? '').trim(); } catch { return ''; } }

function toUtcFromSheet(spDate) {
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

function stripLeadingAvatarLetter(name = '') {
  const m = String(name).match(/^([A-ZÁÀÂÃÉÈÊÍÌÎÓÒÔÕÚÙÛÇ])\s+(.+)$/i);
  if (m && m[2] && m[2].length >= 2) return m[2].trim();
  return String(name).trim();
}

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
  if (/será\s+anunciado/i.test(raw)) return false;

  const { name, metaDateTime } = parseWinnerDetailed(raw);
  if (!name || name.length < 3) return false;
  if (!metaDateTime) return false;

  return true;
}

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

function ensureLinkInsideCaption(caption, resultUrl) {
  const cap = String(caption || '');
  const url = String(resultUrl || '').trim();
  if (!url) return cap;
  if (cap.includes(url)) return cap;

  const join = cap.trim().length ? `${cap.trim()}\n\n` : '';
  return `${join}Link resultado👇\n${url}`;
}

function parseCsvSet(csv) {
  const s = String(csv || '');
  if (!s.trim()) return new Set();
  return new Set(s.split(',').map(x => x.trim()).filter(Boolean));
}

function setToCsv(set) { return Array.from(set).join(','); }

function IK(rowId, kind, whenIso, groupJid) {
  return `${rowId}|${kind}|${whenIso}|${groupJid}`;
}

async function runOnce(app, opts = {}) {
  const lock = await acquireJobLock('post-winner');
  if (!lock) return { ok: false, reason: 'job_locked' };

  try {
    const dryRun =
      !!opts.dryRun ||
      String(app?.locals?.reqDry || '').trim() === '1';

    dlog('tick start', { dryRun });

    const st = settings.get();
    let targetJids = Array.isArray(st.postGroupJids) && st.postGroupJids.length
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

    if (GROUP_ORDER === 'shuffle') targetJids = shuffle(targetJids);
    dlog('targets', targetJids);

    const { headers, items, spreadsheetId, tab, sheets } = await getRows();

    const H_ID       = findHeader(headers, ['id', 'codigo', 'código']);
    const H_DATA     = findHeader(headers, ['data', 'date']);
    const H_HORA     = findHeader(headers, ['horario', 'hora', 'horário', 'time']);
    const H_IMG      = findHeader(headers, ['url_imagem_processada', 'url_imagem', 'imagem', 'image_url']);
    const H_PROD     = findHeader(headers, ['nome_do_produto', 'nome', 'produto', 'produto_nome']);
    const H_WA_POST  = findHeader(headers, ['wa_post']);
    const H_WA_AT    = findHeader(headers, ['wa_post_at', 'wa_postado_em']);
    const H_WA_GROUPS= findHeader(headers, ['wa_post_groups','wa_groups','wa_grupos']);

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

      const localDate = spDate;
      const readyAt = new Date(localDate.getTime() + DELAY_MIN * 60000);

      if (DEBUG_JOB) {
        dlog(`⏰ Linha ${rowIndex1}:`);
        dlog(`   Planilha: ${data} ${hora}`);
        dlog(`   Parsed: ${spDate.toLocaleString('pt-BR')}`);
        dlog(`   Postar após: ${readyAt.toLocaleString('pt-BR')}`);
        dlog(`   Agora: ${now.toLocaleString('pt-BR')}`);
      }

      const tooOld = (now - localDate) > MAX_AGE_H * 60 * 60 * 1000;
      if (tooOld) {
        skipped.push({ row: rowIndex1, id, reason: 'older_than_window' });
        return;
      }

      if (now < readyAt) {
        skipped.push({ row: rowIndex1, id, reason: 'ainda_nao_chegou', readyAt: readyAt.toISOString() });
        return;
      }

      if (!imgUrl || !product) {
        skipped.push({ row: rowIndex1, id, reason: 'faltando imgUrl/nome' });
        return;
      }

      const customHeadline = H_CUSTOM_HEADLINE ? coerceStr(row[H_CUSTOM_HEADLINE]) : '';
      const bgUrl          = H_BG_URL          ? coerceStr(row[H_BG_URL])          : '';
      const musicUrl       = H_MUSIC_URL       ? coerceStr(row[H_MUSIC_URL])       : '';

      let postedSet = new Set();
      if (usePerGroupMode) postedSet = parseCsvSet(row[H_WA_GROUPS]);

      const remainingJids = usePerGroupMode
        ? targetJids.filter(j => !postedSet.has(j))
        : targetJids.slice();

      if (usePerGroupMode && remainingJids.length === 0) {
        skipped.push({ row: rowIndex1, id, reason: 'todos_grupos_ja_postados' });
        return;
      }

      pending.push({
        rowIndex1, id,
        productName: product,
        imgUrl, spDate,
        customHeadline, bgUrl, musicUrl,
        postedSet, remainingJids,
        whenIso: localDate.toISOString()
      });
    });

    if (!pending.length) {
      dlog('sem linhas prontas');
      return { ok: true, processed: 0, sent: 0, note: 'sem linhas prontas', skipped };
    }

    let coupon;
    try {
      if (typeof fetchTopCoupons === 'function') {
        const list = await fetchTopCoupons(2);
        if (Array.isArray(list) && list.length > 1) {
          coupon = `${list[0]} ou ${list[1]}`;
        } else if (Array.isArray(list) && list.length === 1) {
          coupon = list[0];
        }
      }
    } catch (_) {}

    if (!coupon) coupon = await fetchFirstCoupon();
    dlog('coupon', coupon);

    let sent = 0;
    const errors = [];

    // 🔥 SOLUÇÃO A: Processa APENAS 1 sorteio por vez
    if (pending.length > 1) {
      console.log(`⚠️ [post-winner] Encontrados ${pending.length} sorteios prontos. Processando apenas o primeiro para evitar sobreposição.`);
      console.log(`📋 [post-winner] Sorteios encontrados: ${pending.map(p => p.id).join(', ')}`);
      console.log(`✅ [post-winner] Processando: ${pending[0].id}`);
    }

    // Processa APENAS o primeiro sorteio
    const sorteioPraProcessar = pending.slice(0, 1);

    for (const p of sorteioPraProcessar) {
      try {
        let info;
        try {
          info = await fetchResultInfo(p.id);
        } catch (e) {
          errors.push({ id: p.id, stage: 'fetchResultInfo', error: e?.message || String(e) });
          continue;
        }

        const { url: resultUrl, winner, participants } = info;
        dlog('linha', p.id, { winner, participantsCount: Array.isArray(participants) ? participants.length : 0 });

        if (!winnerLooksReady(info)) {
          skipped.push({ id: p.id, reason: 'winner_not_ready' });
          continue;
        }

        const { name: winnerName, metaDateTime, metaChannel } = parseWinnerDetailed(winner || '');

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

        const tpls = templatesList();
        const resultUrlStr = safeStr(resultUrl);
        const groupTextMap = assignRandomTextsToGroups(tpls, p.remainingJids);
        
        console.log(`📝 [post-winner] Textos sorteados para ${p.remainingJids.length} grupos`);

        const sock = await getPreferredSock(app);
        if (!sock) {
          errors.push({ id: p.id, stage: 'sendMessage', error: 'WhatsApp não conectado (admin/cliente)' });
          continue;
        }

        if (dryRun) {
          dlog('dry-run => NÃO enviou', { to: p.remainingJids, id: p.id, link: resultUrlStr });
          continue;
        }

        // 🔥 NOVO SISTEMA DE AGENDAMENTO COM setTimeout
        const orderedJids = (GROUP_ORDER === 'shuffle') ? shuffle(p.remainingJids) : p.remainingJids;
        
        console.log(`\n🗓️ [post-winner] Agendando ${orderedJids.length} grupos com intervalo de ${GROUP_INTERVAL_MINUTES} minutos`);
        console.log(`⏰ [post-winner] Hora atual: ${new Date().toLocaleTimeString('pt-BR')}`);

        // Agenda cada grupo
        orderedJids.forEach((rawJid, idx) => {
          const jid = safeStr(rawJid).trim();
          const delayMs = (idx + 1) * GROUP_INTERVAL_MINUTES * 60 * 1000; // +5min, +10min, +15min...
          const scheduledTime = new Date(Date.now() + delayMs);
          
          console.log(`📅 [post-winner] Grupo ${idx + 1}/${orderedJids.length} agendado para: ${scheduledTime.toLocaleTimeString('pt-BR')} (+${(idx + 1) * GROUP_INTERVAL_MINUTES}min)`);

          // Agenda a postagem
          setTimeout(async () => {
            try {
              console.log(`\n🚀 [post-winner] Iniciando postagem agendada - Grupo ${idx + 1}/${orderedJids.length}`);
              console.log(`⏰ [post-winner] Hora real: ${new Date().toLocaleTimeString('pt-BR')}`);
              
              if (!jid || !jid.endsWith('@g.us')) {
                throw new Error(`JID inválido: "${jid}"`);
              }

              // Dedupe
              const ik = IK(p.id, 'RES', p.whenIso, jid);
              const res = await ledger.reserve(ik, { rowId: p.id, kind: 'RES', whenIso: p.whenIso, jid });
              
              if (res.status !== 'ok') {
                console.log(`⚠️ [post-winner] Grupo ${idx + 1} já foi postado (dedupe): ${res.reason}`);
                return;
              }

              // Pega texto específico do grupo
              const tpl = groupTextMap[jid] || tpls[0];
              
              let captionFull = mergeText(tpl, {
                WINNER: winnerName || 'Ganhador(a)',
                WINNER_DT: metaDateTime,
                WINNER_CH: metaChannel,
                RESULT_URL: resultUrlStr,
                COUPON: coupon
              });

              captionFull = ensureLinkInsideCaption(captionFull, resultUrlStr);

              const payload = { ...media, caption: safeStr(captionFull) };
              const opts = BAILEYS_LINK_PREVIEW_OFF ? { linkPreview: false } : undefined;

              // POSTA!
              await sock.sendMessage(jid, payload, opts);
              await ledger.commit(ik, { message: 'sent' });
              
              sent++;
              
              console.log(`✅ [post-winner] Grupo ${idx + 1}/${orderedJids.length} postado com sucesso: ${jid}`);

              // 🔥 MARCA NA PLANILHA IMEDIATAMENTE APÓS POSTAR
              if (usePerGroupMode) {
                try {
                  p.postedSet.add(jid);
                  const headerName = H_WA_GROUPS || 'WA_POST_GROUPS';
                  
                  await updateCellByHeader(
                    sheets, spreadsheetId, tab, headers, p.rowIndex1, headerName,
                    setToCsv(p.postedSet)
                  );
                  
                  console.log(`📝 [post-winner] Planilha atualizada - Grupos postados: ${setToCsv(p.postedSet)}`);
                  
                  // Se foi o último grupo, marca WA_POST = Postado
                  if (p.postedSet.size === orderedJids.length) {
                    const postAt = new Date().toISOString();
                    await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, H_WA_POST || 'WA_POST', 'Postado');
                    await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, H_WA_AT || 'WA_POST_AT', postAt);
                    
                    console.log(`✅ [post-winner] Todos os grupos postados! Marcado WA_POST=Postado`);
                    
                    if (!usePerGroupMode) settings.addPosted(p.id);
                  }
                  
                } catch (e) {
                  console.error(`❌ [post-winner] Erro ao atualizar planilha:`, e.message);
                  errors.push({ id: p.id, stage: 'updateSheet(WA_POST_GROUPS)', error: e?.message || String(e) });
                }
              }

            } catch (e) {
              console.error(`❌ [post-winner] Erro ao postar grupo ${idx + 1}:`, e.message);
              errors.push({
                id: p.id, stage: 'sendMessage', jid,
                error: e?.message || String(e)
              });
            }
          }, delayMs);
        });

        console.log(`✅ [post-winner] ${orderedJids.length} grupos agendados com sucesso para o sorteio ${p.id}\n`);

      } catch (e) {
        errors.push({ id: p.id, stage: 'unknown', error: e?.message || String(e) });
      }
    }

    dlog('tick end', { processed: pending.length, scheduled: sent, errorsCount: errors.length, skippedCount: skipped.length });

    return { ok: true, processed: pending.length, sent, errors, skipped, dryRun };

  } finally {
    try { await lock.release(); } catch {}
  }
}

module.exports = { runOnce };
