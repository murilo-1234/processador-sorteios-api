// src/jobs/post-promo.js - VERSÃO COM DEBUG PARA g188/g190
'use strict';

const axios = require('axios');
const { parse, addMinutes } = require('date-fns');

// ========== TZ utils (iguais ao post-winner) ==========
let zonedTimeToUtcSafe;
try {
  const tz = require('date-fns-tz');
  zonedTimeToUtcSafe = tz?.zonedTimeToUtc || tz?.default?.zonedTimeToUtc;
  if (!zonedTimeToUtcSafe) zonedTimeToUtcSafe = require('date-fns-tz/zonedTimeToUtc');
} catch (_) {}
if (typeof zonedTimeToUtcSafe !== 'function') {
  const TZ_OFFSET_MINUTES = Number(process.env.TZ_OFFSET_MINUTES || -180);
  zonedTimeToUtcSafe = (date) => {
    const d = date instanceof Date ? date : new Date(date);
    return new Date(d.getTime() + Math.abs(TZ_OFFSET_MINUTES) * 60 * 1000);
  };
}
const TZ = process.env.TZ || 'America/Sao_Paulo';
function safeStr(v){ try{ return v==null? '' : String(v);}catch{ return '';} }
function toUtcFromLocal(d) {
  return zonedTimeToUtcSafe(d, TZ);
}
// ======================================================

const settings = require('../services/settings');
const { getRows, updateCellByHeader } = require('../services/sheets');
const { fetchFirstCoupon } = require('../services/coupons');
const couponsSvc = require('../services/coupons');
const { beforeTexts, dayTexts } = require('../services/promo-texts');
const { acquire: acquireJobLock } = require('../services/job-lock');
const ledger = require('../services/send-ledger');

// 🔥 IGUAL POST-WINNER: Sistema de textos diferentes por grupo
const { assignRandomTextsToGroups } = require('../services/text-shuffler');

const DEBUG_JOB = String(process.env.DEBUG_JOB || '').trim() === '1';
const PROMO_BEFORE_DAYS = Number(process.env.PROMO_BEFORE_DAYS || 2);
const PROMO_POST_HOUR  = Number(process.env.PROMO_POST_START_HOUR || 9);
const PROMO_POST_MAX_HOUR = Number(process.env.PROMO_POST_MAX_HOUR || 22);
const BAILEYS_LINK_PREVIEW_OFF = String(process.env.BAILEYS_LINK_PREVIEW_OFF || '1') === '1';
const GROUP_ORDER = String(process.env.GROUP_ORDER || 'shuffle').toLowerCase();

// 🔥 DELAY entre posts (minutos)
const GROUP_POST_DELAY_MIN = Number(process.env.GROUP_POST_DELAY_MINUTES || 3);

const dlog = (...a) => { if (DEBUG_JOB) console.log('[PROMO]', ...a); };
const coerceStr = (v) => { try { return String(v ?? '').trim(); } catch { return ''; } };

function findHeader(headers, candidates) {
  const lower = headers.map((h) => (h || '').trim().toLowerCase());
  for (const cand of candidates) {
    const i = lower.indexOf(cand.toLowerCase());
    if (i !== -1) return headers[i];
  }
  return null;
}

function mkLocalDateAtHour(spDateOnly, hour = 9) {
  const yyyy = spDateOnly.getFullYear();
  const mm   = spDateOnly.getMonth();
  const dd   = spDateOnly.getDate();
  return new Date(yyyy, mm, dd, hour, 0, 0);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function mergeText(tpl, vars) {
  return safeStr(tpl)
    .replaceAll('{{PRODUTO}}', safeStr(vars.PRODUTO))
    .replaceAll('{{COUPON}}',  safeStr(vars.COUPON));
}

async function downloadToBuffer(url) {
  const { data } = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SorteiosBot/1.0)' }
  });
  return Buffer.from(data);
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

// === Cupom ===
async function getCouponTextCTA() {
  try {
    let list = [];
    if (typeof couponsSvc.fetchTopCoupons === 'function') {
      list = await couponsSvc.fetchTopCoupons(2);
    } else if (typeof couponsSvc.fetchCoupons === 'function') {
      list = await couponsSvc.fetchCoupons();
    } else if (typeof couponsSvc.fetchAllCoupons === 'function') {
      list = await couponsSvc.fetchAllCoupons();
    }
    list = Array.isArray(list) ? list.filter(Boolean).map(String) : [];
    const uniq = [...new Set(list)].slice(0, 2);
    if (uniq.length >= 2) return `${uniq[0]} ou ${uniq[1]}`;
    if (uniq.length === 1) return uniq[0];
  } catch {}
  try {
    if (typeof fetchFirstCoupon === 'function') {
      const one = await fetchFirstCoupon();
      if (one) return String(one);
    }
  } catch {}
  return String(process.env.DEFAULT_COUPON || '').trim();
}

function isCanceledFlag(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'cancelado' || s === 'cancelada' || s === 'cancel';
}

// --- idempotência por grupo via planilha + ledger ---
function parseGroups(val) {
  const s = safeStr(val).trim();
  if (!s) return new Set();
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return new Set(arr.map((x) => String(x).trim()).filter(Boolean));
  } catch {}
  return new Set(s.split(',').map((x) => x.trim()).filter(Boolean));
}

function groupsToCell(set) { return Array.from(set).join(','); }

function isSuperset(setA, setB) { 
  for (const v of setB) if (!setA.has(v)) return false; 
  return true; 
}

function IK(rowId, kind, whenIso, groupJid) {
  return `${rowId}|${kind}|${whenIso}|${groupJid}`;
}

// 🔥 Parse timestamp da planilha (IGUAL POST-WINNER)
function parseTimestamp(val) {
  if (!val) return null;
  try {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d;
  } catch {}
  return null;
}

async function runOnce(app, opts = {}) {
  const lock = await acquireJobLock('post-promo');
  if (!lock) return { ok: false, reason: 'job_locked' };
  
  try {
    const dryRun = !!opts.dryRun || String(app?.locals?.reqDry || '').trim() === '1';
    
    dlog('tick start', { dryRun });
    
    const st = settings.get();

    let targetJids = Array.isArray(st.postGroupJids) && st.postGroupJids.length
      ? st.postGroupJids.filter(Boolean).map((x) => String(x).trim())
      : (st.resultGroupJid ? [String(st.resultGroupJid).trim()] : []);

    if (!targetJids.length) {
      dlog('skip: sem grupos-alvo configurados em /admin/groups');
      return { 
        ok: false, 
        processed: 0,
        sent: 0,
        errors: [{ stage: 'precheck', error: 'Nenhum grupo selecionado em /admin/groups' }]
      };
    }
    
    if (GROUP_ORDER === 'shuffle') targetJids = shuffle(targetJids);
    dlog('targets', targetJids);
    
    const targetSet = new Set(targetJids);

    const { headers, items, spreadsheetId, tab, sheets } = await getRows();

    // Cabeçalhos obrigatórios
    const H_ID   = findHeader(headers, ['id','codigo','código']);
    const H_HORA = findHeader(headers, ['horario','hora','horário','time']);
    const H_PLAN = findHeader(headers, ['url_planilha','planilha','url_da_planilha','sheet_url','url_plan']);
    const H_PROD = findHeader(headers, ['nome_do_produto','produto','nome','produto_nome']);
    const H_DATA = findHeader(headers, ['data','date']);
    const H_IMG  = findHeader(headers, [
      'url_imagem_processada','url_imagem_sorteio','imagem_sorteio','url_imagem','imagem','image_url'
    ]);

    // Controle promo
    const H_P1   = findHeader(headers, ['wa_promo1','wa_promocao1','promo1','wa_promo_1']) || 'WA_PROMO1';
    const H_P1AT = findHeader(headers, ['wa_promo1_at','wa_promocao1_at','promo1_at'])     || 'WA_PROMO1_AT';
    const H_P1G  = findHeader(headers, ['wa_promo1_groups','wa_promocao1_groups','promo1_groups']) || 'WA_PROMO1_GROUPS';
    const H_P1_NEXT = findHeader(headers, ['wa_promo1_next_at','promo1_next_at']) || 'WA_PROMO1_NEXT_AT';

    const H_P2   = findHeader(headers, ['wa_promo2','wa_promocao2','promo2','wa_promo_2']) || 'WA_PROMO2';
    const H_P2AT = findHeader(headers, ['wa_promo2_at','wa_promocao2_at','promo2_at'])     || 'WA_PROMO2_AT';
    const H_P2G  = findHeader(headers, ['wa_promo2_groups','wa_promocao2_groups','promo2_groups']) || 'WA_PROMO2_GROUPS';
    const H_P2_NEXT = findHeader(headers, ['wa_promo2_next_at','promo2_next_at']) || 'WA_PROMO2_NEXT_AT';

    // Resultado
    const H_WINNER = findHeader(headers, ['ganhador','ganhadora','vencedor','winner','nome_ganhador']);

    if (!H_ID || !H_DATA || !H_HORA || !H_PROD || !H_IMG || !H_PLAN) {
      throw new Error(
        `Cabeçalhos faltando. Encontrados: ${JSON.stringify(headers)}. ` +
        `Obrigatórios: id | data | (horario/hora) | produto | url_imagem_processada | url_planilha.`
      );
    }

    const now = new Date();
    const todayLocalDateOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const couponText = await getCouponTextCTA();

    // 🔥 IGUAL POST-WINNER: Coletar sorteios pendentes
    const pendingP1 = [];
    const pendingP2 = [];
    const skipped = [];

    items.forEach((row, i) => {
      const rowIndex1 = i + 2;
      const id      = coerceStr(row[H_ID]);
      
      // 🔥 DEBUG: Início do processamento
      if (id === 'g188' || id === 'g190') {
        console.log(`🔍 [DEBUG] Iniciando processamento de ${id} (linha ${rowIndex1})`);
      }
      
      const product = coerceStr(row[H_PROD]);
      const dateStr = coerceStr(row[H_DATA]);
      const horaStr = coerceStr(row[H_HORA]);
      const imgUrl  = coerceStr(row[H_IMG]);
      const planUrl = coerceStr(row[H_PLAN]);

      const missing = [];
      if (!id) missing.push('id');
      if (!dateStr) missing.push('data');
      if (!horaStr) missing.push('hora');
      if (!product) missing.push('produto');
      if (!imgUrl) missing.push('url_imagem_processada');
      if (!planUrl) missing.push('url_planilha');
      
      if (missing.length) {
        if (id === 'g188' || id === 'g190') {
          console.log(`❌ [DEBUG] ${id} BLOQUEADO: faltando_campos - ${JSON.stringify(missing)}`);
        }
        skipped.push({ row: rowIndex1, id, reason: 'faltando_campos', missing });
        return;
      }

      let spDate;
      try {
        spDate = parse(dateStr, 'dd/MM/yyyy', new Date());
        if (isNaN(spDate?.getTime?.())) throw new Error('data inválida');
      } catch {
        if (id === 'g188' || id === 'g190') {
          console.log(`❌ [DEBUG] ${id} BLOQUEADO: parseDateFail - ${dateStr}`);
        }
        skipped.push({ row: rowIndex1, id, reason: 'parseDateFail', raw: dateStr });
        return;
      }

      if (spDate < todayLocalDateOnly) {
        if (id === 'g188' || id === 'g190') {
          console.log(`❌ [DEBUG] ${id} BLOQUEADO: past_draw`);
          console.log(`   spDate: ${spDate.toLocaleString('pt-BR')}`);
          console.log(`   today: ${todayLocalDateOnly.toLocaleString('pt-BR')}`);
        }
        skipped.push({ row: rowIndex1, id, reason: 'past_draw' });
        return;
      }

      // Só bloqueia se JÁ TEM GANHADOR
      const winner = safeStr(H_WINNER ? row[H_WINNER] : '').trim();
      if (winner) {
        if (id === 'g188' || id === 'g190') {
          console.log(`❌ [DEBUG] ${id} BLOQUEADO: has_winner - "${winner}"`);
        }
        skipped.push({ row: rowIndex1, id, reason: 'has_winner' });
        return;
      }

      // Janela horária
      const horaAtual = now.getHours();
      if (horaAtual < PROMO_POST_HOUR || horaAtual >= PROMO_POST_MAX_HOUR) {
        if (id === 'g188' || id === 'g190') {
          console.log(`❌ [DEBUG] ${id} BLOQUEADO: fora_janela_horaria`);
          console.log(`   Hora atual: ${horaAtual}h`);
          console.log(`   Janela: ${PROMO_POST_HOUR}h-${PROMO_POST_MAX_HOUR}h`);
        }
        skipped.push({ 
          row: rowIndex1, 
          id, 
          reason: 'fora_janela_horaria', 
          hora: horaAtual, 
          janela: `${PROMO_POST_HOUR}h-${PROMO_POST_MAX_HOUR}h` 
        });
        return;
      }

      const p1Canceled = isCanceledFlag(row[H_P1]);
      const p2Canceled = isCanceledFlag(row[H_P2]);

      const dayLocal    = mkLocalDateAtHour(spDate, PROMO_POST_HOUR);
      const beforeLocal = new Date(dayLocal.getTime() - PROMO_BEFORE_DAYS * 24 * 60 * 60 * 1000);
      const p1At = toUtcFromLocal(beforeLocal);
      const p2At = toUtcFromLocal(dayLocal);

      // === PROMO 1 (2 dias antes) ===
      if (!p1Canceled && now >= p1At) {
        if (id === 'g188' || id === 'g190') {
          console.log(`✅ [DEBUG] ${id} passou validação P1 - verificando grupos...`);
        }
        
        const alreadyP1 = parseGroups(row[H_P1G]);
        const p1Posted = String(row[H_P1] || '').toLowerCase() === 'postado';
        
        if (p1Posted || isSuperset(alreadyP1, targetSet)) {
          if (id === 'g188' || id === 'g190') {
            console.log(`❌ [DEBUG] ${id} BLOQUEADO P1: já completou todos os grupos`);
            console.log(`   p1Posted: ${p1Posted}`);
            console.log(`   alreadyP1: ${Array.from(alreadyP1).length} grupos`);
            console.log(`   targetSet: ${targetSet.size} grupos`);
          }
          return;
        }

        // Verifica timestamp do próximo post
        const nextAtStr = row[H_P1_NEXT];
        const nextAt = parseTimestamp(nextAtStr);
        
        if (nextAt && now < nextAt) {
          const waitMin = Math.ceil((nextAt - now) / 60000);
          if (id === 'g188' || id === 'g190') {
            console.log(`⏳ [DEBUG] ${id} BLOQUEADO P1: aguardando_delay - ${waitMin} minutos`);
          }
          skipped.push({
            row: rowIndex1,
            id,
            reason: 'aguardando_delay_p1',
            nextAt: nextAt.toISOString(),
            waitMinutes: waitMin
          });
          return;
        }

        const remainingJids = targetJids.filter(j => !alreadyP1.has(j));
        
        if (remainingJids.length > 0) {
          if (id === 'g188' || id === 'g190') {
            console.log(`🎯 [DEBUG] ${id} ADICIONADO a pendingP1! Grupos restantes: ${remainingJids.length}`);
          }
          pendingP1.push({
            rowIndex1,
            id,
            product,
            imgUrl,
            spDate,
            kind: 'P1',
            whenIso: p1At.toISOString(),
            postedSet: alreadyP1,
            remainingJids
          });
        } else {
          if (id === 'g188' || id === 'g190') {
            console.log(`❌ [DEBUG] ${id} P1: remainingJids.length = 0`);
          }
        }
      } else {
        if (id === 'g188' || id === 'g190') {
          console.log(`⏸️ [DEBUG] ${id} ainda não chegou P1`);
          console.log(`   p1Canceled: ${p1Canceled}`);
          console.log(`   now >= p1At: ${now >= p1At}`);
          console.log(`   now: ${now.toLocaleString('pt-BR')}`);
          console.log(`   p1At: ${p1At.toLocaleString('pt-BR')}`);
        }
      }

      // === PROMO 2 (no dia) ===
      if (!p2Canceled && now >= p2At) {
        // Não postar após horário do sorteio
        try {
          const horaParts = horaStr.split(':');
          if (horaParts.length >= 2) {
            const hora = parseInt(horaParts[0].trim(), 10);
            const minuto = parseInt(horaParts[1].trim(), 10);
            
            if (!isNaN(hora) && !isNaN(minuto)) {
              const horarioSorteio = new Date(spDate);
              horarioSorteio.setHours(hora, minuto, 0, 0);
              
              if (now >= horarioSorteio) {
                if (id === 'g188' || id === 'g190') {
                  console.log(`❌ [DEBUG] ${id} BLOQUEADO P2: sorteio_ja_aconteceu`);
                }
                skipped.push({
                  row: rowIndex1,
                  id,
                  reason: 'sorteio_ja_aconteceu',
                  horarioSorteio: horarioSorteio.toISOString()
                });
                return;
              }
            }
          }
        } catch {}

        const alreadyP2 = parseGroups(row[H_P2G]);
        const p2Posted = String(row[H_P2] || '').toLowerCase() === 'postado';
        
        if (p2Posted || isSuperset(alreadyP2, targetSet)) {
          return;
        }

        // Verifica timestamp do próximo post
        const nextAtStr = row[H_P2_NEXT];
        const nextAt = parseTimestamp(nextAtStr);
        
        if (nextAt && now < nextAt) {
          const waitMin = Math.ceil((nextAt - now) / 60000);
          skipped.push({
            row: rowIndex1,
            id,
            reason: 'aguardando_delay_p2',
            nextAt: nextAt.toISOString(),
            waitMinutes: waitMin
          });
          return;
        }

        const remainingJids = targetJids.filter(j => !alreadyP2.has(j));
        
        if (remainingJids.length > 0) {
          pendingP2.push({
            rowIndex1,
            id,
            product,
            imgUrl,
            spDate,
            kind: 'P2',
            whenIso: p2At.toISOString(),
            postedSet: alreadyP2,
            remainingJids
          });
        }
      }
    });

    // 🔥 IGUAL POST-WINNER: ORDENA POR HORÁRIO (FIFO)
    pendingP1.sort((a, b) => a.spDate - b.spDate);
    pendingP2.sort((a, b) => a.spDate - b.spDate);

    // 🔥 IGUAL POST-WINNER: LOG DETALHADO DA FILA
    if (pendingP1.length > 0) {
      console.log(`📋 [post-promo] P1 encontrados (ordenados por horário):`);
      pendingP1.forEach(p => {
        const horario = p.spDate.toLocaleString('pt-BR');
        const totalGrupos = targetJids.length;
        const postados = p.postedSet.size;
        const restantes = totalGrupos - postados;
        console.log(`   ${p.id} - ${horario} | Grupos: ${postados}/${totalGrupos} postados (${restantes} restantes)`);
      });
    }
    
    if (pendingP2.length > 0) {
      console.log(`📋 [post-promo] P2 encontrados (ordenados por horário):`);
      pendingP2.forEach(p => {
        const horario = p.spDate.toLocaleString('pt-BR');
        const totalGrupos = targetJids.length;
        const postados = p.postedSet.size;
        const restantes = totalGrupos - postados;
        console.log(`   ${p.id} - ${horario} | Grupos: ${postados}/${totalGrupos} postados (${restantes} restantes)`);
      });
    }

    // 🔥 IGUAL POST-WINNER: PROCESSA APENAS 1 SORTEIO POR VEZ
    // Prioridade: P1 primeiro, depois P2
    const sorteioComPendentesP1 = pendingP1.find(p => p.remainingJids.length > 0);
    const sorteioComPendentesP2 = pendingP2.find(p => p.remainingJids.length > 0);
    
    let sorteioParaProcessar = null;
    let isP1 = false;

    if (sorteioComPendentesP1) {
      sorteioParaProcessar = sorteioComPendentesP1;
      isP1 = true;
      console.log(`⚠️ [post-promo] Processando: ${sorteioParaProcessar.id} (P1)`);
    } else if (sorteioComPendentesP2) {
      sorteioParaProcessar = sorteioComPendentesP2;
      isP1 = false;
      console.log(`⚠️ [post-promo] Processando: ${sorteioParaProcessar.id} (P2)`);
    }

    if (!sorteioParaProcessar) {
      if (pendingP1.length === 0 && pendingP2.length === 0) {
        dlog('sem linhas prontas');
        return { ok: true, processed: 0, sent: 0, note: 'sem linhas prontas', skipped };
      }
      console.log(`✅ [post-promo] Todos os sorteios já foram completamente postados!`);
      return { ok: true, processed: 0, sent: 0, note: 'todos completos', skipped };
    }

    const sock = await getPreferredSock(app);
    if (!sock && !dryRun) {
      return { 
        ok: false, 
        processed: 0,
        sent: 0,
        errors: [{ stage: 'sendMessage', error: 'WhatsApp não conectado' }]
      };
    }

    const sorteioPraProcessar = [sorteioParaProcessar];

    let sent = 0;
    const errors = [];

    for (const p of sorteioPraProcessar) {
      try {
        const totalGrupos = targetJids.length;
        const jaPostados = p.postedSet.size;
        const restantes = totalGrupos - jaPostados;

        console.log(`\n📊 [post-promo] FILA - Sorteio: ${p.id} (${p.kind})`);
        console.log(`   Total de grupos: ${totalGrupos}`);
        console.log(`   Já postados: ${jaPostados}`);
        console.log(`   Restantes: ${restantes}`);

        // 🔥 IGUAL POST-WINNER: Mantém ordem original dos grupos (não embaralha novamente)
        const orderedJids = targetJids;
        
        // 🔥 IGUAL POST-WINNER: Próximo grupo na ordem original
        const proximoGrupo = orderedJids.find(jid => !p.postedSet.has(jid));

        if (!proximoGrupo) {
          console.log(`✅ [post-promo] Todos os grupos já foram postados para ${p.id}`);
          
          // Marca como Postado
          const H_FLAG = isP1 ? H_P1 : H_P2;
          const H_AT = isP1 ? H_P1AT : H_P2AT;
          const postAt = new Date().toISOString();
          
          await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, H_FLAG, 'Postado');
          await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, H_AT, postAt);
          
          console.log(`✅ [post-promo] Marcou sorteio ${p.id} (${p.kind}) como Postado`);
          
          continue;
        }

        const idx = orderedJids.indexOf(proximoGrupo);
        const numeroAtual = idx + 1;

        console.log(`🎯 [post-promo] Próximo grupo: ${numeroAtual}/${totalGrupos} (${restantes} restantes)`);
        console.log(`   JID: ${proximoGrupo.slice(0, 20)}...`);

        try {
          // 🔥 IGUAL POST-WINNER: Dedupe
          const ik = IK(p.id, p.kind, p.whenIso, proximoGrupo);
          const res = await ledger.reserve(ik, { rowId: p.id, kind: p.kind, whenIso: p.whenIso, jid: proximoGrupo });
          
          if (res.status !== 'ok') {
            console.log(`⚠️ [post-promo] Grupo ${numeroAtual}/${totalGrupos} já foi postado (dedupe): ${res.reason}`);
            
            p.postedSet.add(proximoGrupo);
            const H_G = isP1 ? H_P1G : H_P2G;
            await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, H_G, groupsToCell(p.postedSet));
          } else {
            // 🔥 IGUAL POST-WINNER: Sistema de textos diferentes por grupo
            const textList = isP1 
              ? (Array.isArray(beforeTexts) ? beforeTexts : []) 
              : (Array.isArray(dayTexts) ? dayTexts : []);
            
            if (!textList.length) {
              textList.push('🎁 Sorteio {{PRODUTO}}!\n💸 Use o cupom: {{COUPON}}');
            }
            
            const groupTextMap = assignRandomTextsToGroups(textList, orderedJids);
            const tpl = groupTextMap[proximoGrupo] || textList[0];

            const caption = mergeText(tpl, { PRODUTO: p.product, COUPON: couponText });

            // Download imagem
            let imageBuf = null;
            try {
              imageBuf = await downloadToBuffer(p.imgUrl);
            } catch (err) {
              errors.push({ id: p.id, stage: 'downloadImage', error: err?.message || String(err) });
              continue;
            }

            const payload = imageBuf ? { image: imageBuf, caption } : { text: `${caption}\n\n${p.imgUrl}` };
            const opts = BAILEYS_LINK_PREVIEW_OFF ? { linkPreview: false } : undefined;

            if (dryRun) {
              dlog('dry-run => NÃO enviou', { to: proximoGrupo, id: p.id });
              continue;
            }

            // 🚀 POSTA!
            await sock.sendMessage(proximoGrupo, payload, opts);
            await ledger.commit(ik, { message: 'sent' });
            
            sent++;
            console.log(`✅ [post-promo] Grupo ${numeroAtual}/${totalGrupos} postado com sucesso!`);

            // 🔥 IGUAL POST-WINNER: ATUALIZA PLANILHA IMEDIATAMENTE
            p.postedSet.add(proximoGrupo);
            const H_G = isP1 ? H_P1G : H_P2G;
            await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, H_G, groupsToCell(p.postedSet));
            
            const novosPostados = p.postedSet.size;
            const novosRestantes = totalGrupos - novosPostados;
            
            console.log(`📝 [post-promo] Planilha atualizada - Grupos postados: ${novosPostados}/${totalGrupos} (${novosRestantes} restantes)`);

            // 🔥 IGUAL POST-WINNER: SALVA TIMESTAMP DO PRÓXIMO POST
            if (novosPostados < totalGrupos) {
              const nextPostAt = addMinutes(now, GROUP_POST_DELAY_MIN);
              const H_NEXT = isP1 ? H_P1_NEXT : H_P2_NEXT;
              await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, H_NEXT, nextPostAt.toISOString());
              
              const nextPostTime = nextPostAt.toLocaleTimeString('pt-BR');
              console.log(`⏰ [post-promo] Próximo post agendado para: ${nextPostTime} (${GROUP_POST_DELAY_MIN} minutos)`);
              console.log(`⏳ [post-promo] Próxima execução do cron vai verificar e postar grupo ${numeroAtual + 1}/${totalGrupos}`);
            }

            // 🔥 IGUAL POST-WINNER: Se foi o último grupo, marca como Postado
            if (novosPostados === totalGrupos) {
              const H_FLAG = isP1 ? H_P1 : H_P2;
              const H_AT = isP1 ? H_P1AT : H_P2AT;
              const H_NEXT = isP1 ? H_P1_NEXT : H_P2_NEXT;
              const postAt = new Date().toISOString();
              
              await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, H_FLAG, 'Postado');
              await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, H_AT, postAt);
              await updateCellByHeader(sheets, spreadsheetId, tab, headers, p.rowIndex1, H_NEXT, '');
              
              console.log(`🎉 [post-promo] TODOS OS GRUPOS POSTADOS! Sorteio ${p.id} (${p.kind}) completo!`);
            }
          }

        } catch (e) {
          console.error(`❌ [post-promo] Erro ao postar grupo ${numeroAtual}/${totalGrupos}:`, e.message);
          errors.push({
            id: p.id, stage: 'sendMessage', jid: proximoGrupo,
            error: e?.message || String(e)
          });
        }

      } catch (e) {
        errors.push({ id: p.id, stage: 'unknown', error: e?.message || String(e) });
      }
    }

    dlog('tick end', { processed: sorteioPraProcessar.length, sent, errorsCount: errors.length, skippedCount: skipped.length });

    return { ok: true, processed: sorteioPraProcessar.length, sent, errors, skipped, dryRun };

  } finally {
    try { await lock.release(); } catch {}
  }
}

module.exports = { runOnce };
