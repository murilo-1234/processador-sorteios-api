/**
 * Serviço B (bots): multi-números só com bot do ChatGPT.
 * Mantém "sessão forte", QR visível e administração simples.
 * Página: /admin → status + QR + Conectar + Limpar sessão (por número)
 * 
 * VERSÃO CORRIGIDA - Resolve:
 * - Conflito de sessão (stream errored/replaced)
 * - Loop de reconexão infinito
 * - Sessões corrompidas (auto-limpeza)
 * - Conexão sequencial com delay
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const {
  startVivinoReviewsWorker,
  getVivinoWorkerProgress,
  getVivinoWorkerMetrics,
} = require('./vivino_reviews_worker');
const diskCleanup = require('./disk-cleanup');

process.on('uncaughtException', (err) => {
  console.error('[global] uncaughtException:', err && err.message, err && err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[global] unhandledRejection:', reason);
});

// Reuso do seu código existente
const WhatsAppClient = require('../whatsapp-automation/src/services/whatsapp-client');
// ========== AUTO-RESPONDER (mensagem fixa) ==========
const AR_MSG = `📢 Aviso importante!

Meu número de atendimento mudou!
O novo número é: https://wa.me/5548991784533

Por favor, salve o novo contato para continuar recebendo
nossas ofertas, cupons e novidades. 😊

Ainda posso te ajudar por aqui, mas em breve
este número será desativado.

Mais informações: https://www.muriloconsultor.com.br/

Bjos
Murilo Cerqueira`;

const AR_COOLDOWN = 60 * 1000; // 60 segundos
const arSent = new Map(); // jid -> timestamp do último envio

// ---------- Config ----------
const PORT = process.env.PORT || 10000;
const TZ = process.env.TZ || 'America/Sao_Paulo';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS || '';
const WA_SESSION_BASE = process.env.WA_SESSION_BASE || './data/baileys-bots';
const WA_BOTS_ENABLED = String(process.env.WA_BOTS_ENABLED ?? 'true').trim().toLowerCase() === 'true';

// NOVO: Configurações de conexão controlada
const INSTANCE_SPAWN_DELAY_MS = Number(process.env.WA_INSTANCE_SPAWN_DELAY_MS || 3000);
const RECONNECT_BASE_DELAY_MS = Number(process.env.WA_RECONNECT_BASE_DELAY_MS || 5000);
const RECONNECT_MAX_DELAY_MS = Number(process.env.WA_RECONNECT_MAX_DELAY_MS || 120000);
const RECONNECT_MAX_ATTEMPTS = Number(process.env.WA_RECONNECT_MAX_ATTEMPTS || 10);
const RECONNECT_405_BASE_DELAY_MS = Number(process.env.WA_RECONNECT_405_BASE_DELAY_MS || 30000);

// Lista de números (somente os que serão "só-bot")
const WA_INSTANCE_IDS = String(process.env.WA_INSTANCE_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!WA_INSTANCE_IDS.length) {
  if (WA_BOTS_ENABLED) {
    console.error('Defina WA_INSTANCE_IDS com os números que serão conectados (ex: 4891167973,4891784533)');
    process.exit(1);
  }
  console.log('[bots] WA_BOTS_ENABLED=false, instâncias WhatsApp não serão iniciadas.');
}

// ---------- Auth simples opcional ----------
function basicAuth(req, res, next) {
  if (!ADMIN_USER) return next();
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Basic ') ? Buffer.from(hdr.slice(6), 'base64').toString() : '';
  const [u, p] = token.split(':');
  if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="Restricted"');
  return res.status(401).send('auth required');
}

// ---------- Registro de instâncias e QR cache ----------
const instances = new Map(); // id -> { id, client, sessPath, state, reconnectAttempts, lastError, reconnectTimer }
const qrStore = new Map();   // id -> último QR recebido

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'n/a';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function getVivinoProgressSnapshot() {
  const raw = getVivinoWorkerProgress();
  const totalEligible = toNumber(raw.totalEligible);
  const doneEligible = toNumber(raw.doneEligible);
  const pendingEligible = toNumber(raw.pendingEligible);
  const totalReviewsRows = toNumber(raw.totalReviewsRows);
  const doneReviewsDbSum = toNumber(raw.doneReviewsDbSum);
  const sessionWinesDone = toNumber(raw.sessionWinesDone);
  const sessionReviewsFetched = toNumber(raw.sessionReviewsFetched);
  const sessionReviewsRowsDelta = toNumber(raw.sessionReviewsRowsDelta);
  const progressPct = totalEligible > 0 ? (doneEligible / totalEligible) * 100 : 0;
  const batchWinesPerSec = Number(raw?.rates?.batchWinesPerSec || 0);
  const globalWinesPerSec = Number(raw?.rates?.globalWinesPerSec || 0);
  const batch = raw.currentBatch || {};
  const sessionDuplicatesEstimate = Math.max(0, sessionReviewsFetched - sessionReviewsRowsDelta);

  return {
    ...raw,
    totalEligible,
    doneEligible,
    pendingEligible,
    totalReviewsRows,
    doneReviewsDbSum,
    sessionWinesDone,
    sessionReviewsFetched,
    sessionReviewsRowsDelta,
    progressPct,
    rates: {
      batchWinesPerSec: Number.isFinite(batchWinesPerSec) ? batchWinesPerSec : 0,
      globalWinesPerSec: Number.isFinite(globalWinesPerSec) ? globalWinesPerSec : 0,
    },
    currentBatch: {
      target: toNumber(batch.target),
      processed: toNumber(batch.processed),
      ok: toNumber(batch.ok),
      retryLater: toNumber(batch.retryLater),
      pendingBefore: toNumber(batch.pendingBefore),
      pendingAfter: toNumber(batch.pendingAfter),
      startedAt: batch.startedAt || null,
      updatedAt: batch.updatedAt || null,
    },
    derived: {
      progressPct,
      etaHuman: formatDuration(Number(raw.etaSeconds)),
      sessionDuplicatesEstimate,
    },
  };
}

function buildVivinoProgressLines(snapshot) {
  const s = snapshot;
  return [
    `VIVINO: ${s.doneEligible.toLocaleString('pt-BR')} / ${s.totalEligible.toLocaleString('pt-BR')} (${s.derived.progressPct.toFixed(2)}%)`,
    `Pendentes: ${s.pendingEligible.toLocaleString('pt-BR')} | Retry cooldown: ${toNumber(s.retryCooldownCount).toLocaleString('pt-BR')}`,
    `Lote: ${s.currentBatch.processed}/${s.currentBatch.target} | OK=${s.currentBatch.ok} | Retry=${s.currentBatch.retryLater}`,
    `Velocidade: lote=${s.rates.batchWinesPerSec.toFixed(2)} vinhos/s | geral=${s.rates.globalWinesPerSec.toFixed(2)} vinhos/s | ETA=${s.derived.etaHuman}`,
    `Base: reviews_rows=${s.totalReviewsRows.toLocaleString('pt-BR')} | sum_reviews_vinhos=${s.doneReviewsDbSum.toLocaleString('pt-BR')}`,
    `Sessao: +vinhos=${s.sessionWinesDone.toLocaleString('pt-BR')} | reviews_fetch=${s.sessionReviewsFetched.toLocaleString('pt-BR')} | novos_rows=${s.sessionReviewsRowsDelta.toLocaleString('pt-BR')} | repetidos_est=${s.derived.sessionDuplicatesEstimate.toLocaleString('pt-BR')}`,
    `Fase: ${s.phase || 'unknown'} | Ciclo: ${toNumber(s.cycle)} | Atualizado: ${s.updatedAt ? new Date(s.updatedAt).toISOString() : 'n/a'}`,
  ];
}

function toIntInRange(value, minValue, maxValue, fallbackValue) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallbackValue;
  return Math.max(minValue, Math.min(maxValue, n));
}

function formatMaybePct(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)}%` : 'n/a';
}

function buildVivinoMetricsLines(metrics) {
  const m = metrics || {};
  const base = m.base || {};
  const throughput = m.throughput || {};
  const wines = throughput.wines || {};
  const reviews = throughput.reviewsSum || {};
  const cmpHour = (m.comparisons && m.comparisons.hour) || {};
  const cmpDay = (m.comparisons && m.comparisons.day) || {};
  const eta = m.eta || {};
  const job = m.job || {};
  const pending = m.pending || {};
  const worker = m.worker || {};
  const session = worker.session || {};
  const rates = worker.rates || {};
  const batch = worker.currentBatch || {};

  return [
    '======================================================================',
    `VIVINO METRICS | generated_at=${m.generatedAt || 'n/a'} | tz=${m.timezone || 'n/a'}`,
    '======================================================================',
    `BASE: elegiveis ${toNumber(base.winesDoneTotal).toLocaleString('pt-BR')} / ${toNumber(base.winesEligibleTotal).toLocaleString('pt-BR')} (${toNumber(base.progressPct).toFixed(2)}%) | pendentes ${toNumber(base.winesPendingTotal).toLocaleString('pt-BR')} | ineligiveis ${toNumber(base.winesIneligibleTotal).toLocaleString('pt-BR')}`,
    `JOB: antes=${toNumber(job.doneBeforeJob).toLocaleString('pt-BR')} | meta=${toNumber(job.targetToExtract).toLocaleString('pt-BR')} | extraidos=${toNumber(job.extractedThisJob).toLocaleString('pt-BR')} (${toNumber(job.progressPct).toFixed(2)}%) | faltam=${toNumber(job.remainingThisJob).toLocaleString('pt-BR')}`,
    `RITMO JOB: ${toNumber(job.ratePerMinute).toFixed(2)} vinhos/min | ${toNumber(job.ratePerHour).toFixed(2)} vinhos/h | ETA job=${job.etaHuman || 'n/a'} | inicio=${job.startedAt || 'n/a'}`,
    `REVIEWS BASE: rows=${toNumber(base.reviewsRowsTotal).toLocaleString('pt-BR')} | sum_done=${toNumber(base.reviewsSumDoneWines).toLocaleString('pt-BR')} | avg_por_vinho=${toNumber(base.avgReviewsPerDoneWine).toFixed(2)} | coverage=${formatMaybePct(Number(base.reviewsRowsVsSumPct))}`,
    `THROUGHPUT VINHOS: 5m=${toNumber(wines.last5m)} | 15m=${toNumber(wines.last15m)} | 1h=${toNumber(wines.last1h)} | 6h=${toNumber(wines.last6h)} | 24h=${toNumber(wines.last24h)} | 7d=${toNumber(wines.last7d)}`,
    `THROUGHPUT REVIEWS_SUM: 5m=${toNumber(reviews.last5m)} | 15m=${toNumber(reviews.last15m)} | 1h=${toNumber(reviews.last1h)} | 6h=${toNumber(reviews.last6h)} | 24h=${toNumber(reviews.last24h)} | 7d=${toNumber(reviews.last7d)}`,
    `COMPARACAO HORA: atual=${toNumber(cmpHour.current && cmpHour.current.winesDone)} vs anterior=${toNumber(cmpHour.previous && cmpHour.previous.winesDone)} | delta=${toNumber(cmpHour.delta && cmpHour.delta.winesAbs)} | ${formatMaybePct(Number(cmpHour.delta && cmpHour.delta.winesPct))}`,
    `COMPARACAO DIA: atual=${toNumber(cmpDay.current && cmpDay.current.winesDone)} vs anterior=${toNumber(cmpDay.previous && cmpDay.previous.winesDone)} | delta=${toNumber(cmpDay.delta && cmpDay.delta.winesAbs)} | ${formatMaybePct(Number(cmpDay.delta && cmpDay.delta.winesPct))}`,
    `ETA: best=${eta.bestHuman || 'n/a'} | live=${eta.byLiveRateHuman || 'n/a'} | 1h=${eta.byLastHourHuman || 'n/a'} | 24h=${eta.byLast24hHuman || 'n/a'}`,
    `PENDENTES: count=${toNumber(pending.count)} | ratings[min/avg/max]=${toNumber(pending.minRatings)}/${toNumber(pending.avgRatings).toFixed(2)}/${toNumber(pending.maxRatings)}`,
    `WORKER: phase=${worker.phase || 'n/a'} | cycle=${toNumber(worker.cycle)} | cooldown=${toNumber(worker.retryCooldownCount)} | rate_batch=${toNumber(rates.batchWinesPerSec).toFixed(2)} vinhos/s | rate_global=${toNumber(rates.globalWinesPerSec).toFixed(2)} vinhos/s`,
    `SESSAO: +vinhos=${toNumber(session.winesDone)} | reviews_fetch=${toNumber(session.reviewsFetched)} | novos_rows=${toNumber(session.reviewsRowsDelta)} | repetidos_est=${toNumber(session.duplicatesEstimate)}`,
    `LOTE: ${toNumber(batch.processed)}/${toNumber(batch.target)} | ok=${toNumber(batch.ok)} | retry=${toNumber(batch.retryLater)} | pending_before=${toNumber(batch.pendingBefore)} | pending_after=${toNumber(batch.pendingAfter)}`,
    '======================================================================',
  ];
}

// NOVO: Calcula delay com backoff exponencial
function getReconnectDelay(attempts) {
  const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempts);
  return Math.min(delay, RECONNECT_MAX_DELAY_MS);
}

function getReconnectDelayForStatus(statusCode, attempts) {
  if (Number(statusCode) === 405) {
    const delay = RECONNECT_405_BASE_DELAY_MS * Math.pow(2, attempts);
    return Math.min(delay, Math.max(RECONNECT_MAX_DELAY_MS, RECONNECT_405_BASE_DELAY_MS * 8));
  }
  return getReconnectDelay(attempts);
}

// NOVO: Verifica se o erro indica sessão corrompida
function isCorruptedSessionError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('unable to authenticate') ||
         msg.includes('unsupported state') ||
         msg.includes('bad mac') ||
         msg.includes('decryption failed') ||
         msg.includes('invalid key');
}

// NOVO: Verifica se é erro de conflito (outra sessão conectou)
function isConflictError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('conflict') ||
         msg.includes('replaced') ||
         msg.includes('stream errored');
}

// NOVO: Agenda reconexão com controle
function scheduleReconnect(ref, statusCode) {
  // Cancela timer anterior se existir
  if (ref.reconnectTimer) {
    clearTimeout(ref.reconnectTimer);
    ref.reconnectTimer = null;
  }

  // Verifica limite de tentativas
  if (ref.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
    console.log(`[${ref.id}] Limite de ${RECONNECT_MAX_ATTEMPTS} tentativas atingido. Aguardando ação manual.`);
    ref.state = 'waiting_manual';
    return;
  }

  const delay = getReconnectDelayForStatus(statusCode, ref.reconnectAttempts);
  console.log(`[${ref.id}] Reconexão agendada em ${delay/1000}s (tentativa ${ref.reconnectAttempts + 1}/${RECONNECT_MAX_ATTEMPTS})`);
  
  ref.state = 'waiting_reconnect';
  ref.reconnectTimer = setTimeout(async () => {
    ref.reconnectAttempts++;
    await initializeInstance(ref).catch(e => {
      console.error(`[${ref.id}] Erro na reconexão:`, e?.message || e);
    });
  }, delay);
}

// NOVO: Inicializa instância com tratamento de erros melhorado
async function initializeInstance(ref) {
  // Evita inicialização dupla
  if (ref.state === 'connecting') {
    console.log(`[${ref.id}] Já está conectando, ignorando...`);
    return ref;
  }

  ref.state = 'connecting';
  ref.lastError = null;
  console.log(`[${ref.id}] Iniciando conexão...`);

  try {
    await ref.client.initialize();
    
    // Configura listeners de eventos (connection + auto-responder)
    setupEventListeners(ref);

    return ref;
  } catch (e) {
    ref.lastError = e?.message || String(e);
    console.error(`[${ref.id}] Erro na inicialização:`, ref.lastError);

    // Se sessão corrompida, limpa automaticamente
    if (isCorruptedSessionError(e)) {
      console.log(`[${ref.id}] Sessão corrompida detectada. Limpando automaticamente...`);
      await clearAndReinitialize(ref);
      return ref;
    }

    // Para outros erros, agenda reconexão
    ref.state = 'error';
    scheduleReconnect(ref);
    return ref;
  }
}

// NOVO: Limpa sessão corrompida e reinicializa
async function clearAndReinitialize(ref) {
  try {
    qrStore.delete(ref.id);
    await ref.client.clearSession?.();
    ref.reconnectAttempts = 0; // Reset porque é uma nova sessão
    ref.state = 'waiting_qr';
    ref.lastError = 'Sessão limpa. Aguardando escaneamento do QR.';
    console.log(`[${ref.id}] Sessão limpa. Precisa escanear QR novamente.`);
    
    // Tenta inicializar para gerar QR
    await sleep(2000);
    await ref.client.initialize().catch(() => {});
    setupEventListeners(ref);
  } catch (e) {
    console.error(`[${ref.id}] Erro ao limpar sessão:`, e?.message);
    ref.state = 'error';
    ref.lastError = e?.message || String(e);
  }
}

// Configura listeners de eventos do Baileys (connection + auto-responder)
function setupEventListeners(ref) {
  try {
    const sock = ref.client.sock;
    if (!sock?.ev?.on) return;

    // Remove listeners anteriores para evitar duplicação
    sock.ev.removeAllListeners?.('connection.update');
    sock.ev.removeAllListeners?.('messages.upsert');

    // ---- Connection updates ----
    sock.ev.on('connection.update', (u) => {
      if (u?.qr) {
        qrStore.set(ref.id, u.qr);
        ref.state = 'waiting_qr';
      }

      if (u?.connection === 'open') {
        qrStore.delete(ref.id);
        ref.state = 'connected';
        ref.reconnectAttempts = 0;
        ref.lastError = null;
        console.log(`[${ref.id}] ✅ Conectado com sucesso!`);
      }

      if (u?.connection === 'close') {
        const error = u?.lastDisconnect?.error;
        const statusCode = error?.output?.statusCode || error?.code;

        ref.lastError = `Desconectado (código: ${statusCode || 'desconhecido'})`;
        console.log(`[${ref.id}] ❌ ${ref.lastError}`);

        if (statusCode === 401) {
          console.log(`[${ref.id}] Logout detectado. Sessão invalidada.`);
          ref.state = 'logged_out';
          return;
        }

        if (statusCode === 405) {
          console.log(`[${ref.id}] 405 detectado. Forcando backoff maior para evitar tempestade de reconexao.`);
          ref.reconnectAttempts = Math.max(ref.reconnectAttempts, 2);
        }

        if (isConflictError(error)) {
          console.log(`[${ref.id}] Conflito de sessão detectado. Aguardando mais tempo...`);
          ref.reconnectAttempts = Math.max(ref.reconnectAttempts, 3);
        }

        if (isCorruptedSessionError(error)) {
          clearAndReinitialize(ref);
          return;
        }

        ref.state = 'disconnected';
        scheduleReconnect(ref, statusCode);
      }
    });

    // ---- Auto-responder (mensagem fixa) ----
    sock.ev.on('messages.upsert', async (ev) => {
      try {
        // Ignorar histórico (sync inicial)
        if (ev?.type === 'append') return;

        if (!ev?.messages?.length) return;
        const msg = ev.messages[0];
        const jid = msg?.key?.remoteJid;

        // Ignorar: mensagens próprias, grupos, status
        if (!jid) return;
        if (msg?.key?.fromMe) return;
        if (jid.endsWith('@g.us')) return;
        if (jid.endsWith('@newsletter')) return;
        if (jid === 'status@broadcast') return;

        // Cooldown: só responde 1x por pessoa POR INSTÂNCIA a cada 60s
        const cooldownKey = `${ref.id}:${jid}`;
        const now = Date.now();
        const lastSent = arSent.get(cooldownKey) || 0;
        if (now - lastSent < AR_COOLDOWN) return;

        arSent.set(cooldownKey, now);
        await sock.sendMessage(jid, { text: AR_MSG });
        console.log(`[${ref.id}] RESPONDIDO -> ${jid.split('@')[0]}`);
      } catch (e) {
        console.error(`[${ref.id}] auto-responder erro:`, e?.message || e);
      }
    });

    console.log(`[${ref.id}] listeners+autoresponder OK`);

  } catch (e) {
    console.warn(`[${ref.id}] Erro ao configurar listeners:`, e?.message);
  }
}

// Cria instância (modificado para usar novo sistema)
async function spawnInstance(id) {
  const sessPath = path.join(WA_SESSION_BASE, id.replace(/\D/g, ''));
  ensureDir(sessPath);

  const client = new WhatsAppClient();
  client.sessionPath = sessPath;

  const ref = { 
    id, 
    client, 
    sessPath,
    state: 'initializing',
    reconnectAttempts: 0,
    lastError: null,
    reconnectTimer: null
  };
  
  instances.set(id, ref);
  
  await initializeInstance(ref);
  
  return ref;
}

// MODIFICADO: Cria instâncias com delay entre elas
async function startWhatsAppInstances() {
  if (!WA_BOTS_ENABLED) return;

  ensureDir(WA_SESSION_BASE);
  console.log(`[bots] Iniciando ${WA_INSTANCE_IDS.length} instâncias com ${INSTANCE_SPAWN_DELAY_MS}ms de delay entre cada...`);
  
  for (let i = 0; i < WA_INSTANCE_IDS.length; i++) {
    const id = WA_INSTANCE_IDS[i];
    console.log(`[bots] Iniciando instância ${i + 1}/${WA_INSTANCE_IDS.length}: ${id}`);
    
    await spawnInstance(id);
    
    // Delay entre instâncias (exceto na última)
    if (i < WA_INSTANCE_IDS.length - 1) {
      console.log(`[bots] Aguardando ${INSTANCE_SPAWN_DELAY_MS}ms antes da próxima...`);
      await sleep(INSTANCE_SPAWN_DELAY_MS);
    }
  }
  
  console.log(`[bots] Todas as ${WA_INSTANCE_IDS.length} instâncias foram iniciadas.`);
}

startWhatsAppInstances().catch(err => {
  console.error('Falha ao subir instâncias:', err?.message || err);
  process.exit(1);
});

// ---------- App web ----------
const app = express();
app.use(express.json());
if (String(process.env.TRUST_PROXY || '0') === '1') app.set('trust proxy', 1);

// Health público
app.get('/healthz', (req, res) => {
  const connected = Array.from(instances.values()).filter(x => x.state === 'connected').length;
  res.json({
    ok: true,
    tz: TZ,
    instances: Array.from(instances.keys()),
    connected: connected,
    total: instances.size,
    ts: new Date().toISOString(),
  });
});

// status JSON (protegido se ADMIN_* definidos)
app.get('/api/instances', basicAuth, (req, res) => {
  const now = new Date().toISOString();
  const list = Array.from(instances.values()).map(x => {
    const st = (typeof x.client.getConnectionStatus === 'function')
      ? x.client.getConnectionStatus()
      : {};
    return {
      id: x.id,
      connected: x.state === 'connected',
      state: x.state,
      user: st.user || null,
      retry: x.reconnectAttempts || 0,
      maxRetry: RECONNECT_MAX_ATTEMPTS,
      sessionPath: x.sessPath,
      qrCached: qrStore.has(x.id),
      lastError: x.lastError,
    };
  });
  res.json({ ok: true, at: now, instances: list });
});

app.get('/api/vivino/progress', basicAuth, (req, res) => {
  const snapshot = getVivinoProgressSnapshot();
  res.json({
    ok: true,
    at: new Date().toISOString(),
    progress: snapshot,
  });
});

app.get('/api/vivino/progress.txt', basicAuth, (req, res) => {
  const snapshot = getVivinoProgressSnapshot();
  const lines = buildVivinoProgressLines(snapshot);
  res.type('text/plain; charset=utf-8');
  res.send(lines.join('\n'));
});

app.get('/api/vivino/metrics', basicAuth, async (req, res) => {
  try {
    const hourlyHours = toIntInRange(req.query.hourly_hours, 6, 168, 48);
    const dailyDays = toIntInRange(req.query.daily_days, 7, 120, 30);
    const metrics = await getVivinoWorkerMetrics({ hourlyHours, dailyDays });
    if (!metrics || metrics.ok === false) {
      return res.status(503).json({
        ok: false,
        at: new Date().toISOString(),
        error: metrics && metrics.error ? metrics.error : 'metrics indisponiveis',
        metrics: metrics || null,
      });
    }
    return res.json({
      ok: true,
      at: new Date().toISOString(),
      metrics,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      at: new Date().toISOString(),
      error: e?.message || String(e),
    });
  }
});

app.get('/api/vivino/metrics.txt', basicAuth, async (req, res) => {
  try {
    const hourlyHours = toIntInRange(req.query.hourly_hours, 6, 168, 48);
    const dailyDays = toIntInRange(req.query.daily_days, 7, 120, 30);
    const metrics = await getVivinoWorkerMetrics({ hourlyHours, dailyDays });
    const lines = metrics && metrics.ok !== false
      ? buildVivinoMetricsLines(metrics)
      : [
          '======================================================================',
          `VIVINO METRICS indisponivel: ${(metrics && metrics.error) ? metrics.error : 'erro desconhecido'}`,
          '======================================================================',
        ];
    res.type('text/plain; charset=utf-8');
    return res.send(lines.join('\n'));
  } catch (e) {
    res.type('text/plain; charset=utf-8');
    return res.status(500).send(
      [
        '======================================================================',
        `VIVINO METRICS erro: ${e?.message || String(e)}`,
        '======================================================================',
      ].join('\n'),
    );
  }
});

app.get('/admin/vivino', basicAuth, (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-br">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Painel Vivino</title>
  <style>
    :root{
      --bg:#090f1a;
      --bg-soft:#111b2a;
      --card:#162338;
      --line:#2a3f60;
      --text:#e9f0fb;
      --muted:#9eb1cc;
      --ok:#24c36b;
      --warn:#f7b955;
      --err:#ff6a6a;
      --accent:#4cc9f0;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;
      background:
        radial-gradient(1200px 480px at 10% -20%, #1d3557 0%, transparent 55%),
        radial-gradient(900px 420px at 90% -30%, #143a52 0%, transparent 50%),
        var(--bg);
      color:var(--text);
      padding:20px;
    }
    .wrap{max-width:1400px;margin:0 auto}
    .top{
      display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;
      margin-bottom:16px
    }
    .title h1{margin:0;font-size:24px;letter-spacing:.2px}
    .title p{margin:4px 0 0;color:var(--muted);font-size:13px}
    .controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .controls input,.controls button,.controls a{
      border:1px solid var(--line);
      background:var(--bg-soft);
      color:var(--text);
      border-radius:10px;
      padding:8px 10px;
      font-size:13px;
      text-decoration:none;
    }
    .controls button{cursor:pointer}
    .cards{
      display:grid;
      grid-template-columns:repeat(auto-fit,minmax(230px,1fr));
      gap:12px;
      margin-bottom:14px;
    }
    .card{
      background:linear-gradient(180deg,#182841 0%, #142236 100%);
      border:1px solid var(--line);
      border-radius:14px;
      padding:12px;
      box-shadow:0 8px 22px rgba(3,6,12,.28);
    }
    .k{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
    .v{font-size:24px;font-weight:700;margin-top:6px}
    .sub{font-size:12px;color:var(--muted);margin-top:5px}
    .ok{color:var(--ok)}
    .warn{color:var(--warn)}
    .err{color:var(--err)}
    .grid{
      display:grid;
      grid-template-columns:1.3fr .7fr;
      gap:12px;
    }
    .panel{
      background:linear-gradient(180deg,#16243a 0%, #111e31 100%);
      border:1px solid var(--line);
      border-radius:14px;
      padding:12px;
      margin-bottom:12px;
    }
    .panel h2{margin:0 0 10px;font-size:15px}
    .progress-shell{
      width:100%;height:14px;background:#0b1422;border:1px solid var(--line);
      border-radius:999px;overflow:hidden;
    }
    .progress-bar{
      height:100%;
      background:linear-gradient(90deg,#00b4d8 0%, #48cae4 50%, #90e0ef 100%);
      width:0%;
      transition:width .5s ease;
    }
    .cols{
      display:grid;
      grid-template-columns:repeat(3,minmax(0,1fr));
      gap:8px;
      margin-top:10px;
    }
    .mini{
      background:#0f1a2a;border:1px solid #223655;border-radius:10px;padding:8px;
      font-size:12px;color:var(--muted)
    }
    .mini b{display:block;color:var(--text);font-size:15px;margin-top:3px}
    .chart{
      display:flex;
      align-items:flex-end;
      gap:3px;
      height:150px;
      background:#0f1a2a;
      border:1px solid #243a5d;
      border-radius:10px;
      padding:8px 8px 6px;
      overflow-x:auto;
    }
    .bar{
      min-width:10px;
      border-radius:3px 3px 0 0;
      background:linear-gradient(180deg,#4cc9f0 0%, #4361ee 100%);
      opacity:.9;
    }
    .bar.day{
      min-width:16px;
      background:linear-gradient(180deg,#80ed99 0%, #57cc99 100%);
    }
    .legend{font-size:11px;color:var(--muted);margin-top:6px}
    table{
      width:100%;
      border-collapse:collapse;
      font-size:12px;
    }
    th,td{
      text-align:left;
      border-bottom:1px solid #253b5f;
      padding:8px 6px;
      vertical-align:top;
    }
    th{color:#b6c7de;font-weight:600}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    .evt{max-height:380px;overflow:auto}
    .dim{color:var(--muted)}
    .footer{font-size:12px;color:var(--muted);margin-top:8px}
    @media (max-width:1100px){
      .grid{grid-template-columns:1fr}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="title">
        <h1>Painel Vivino Worker</h1>
        <p>Acompanhamento em tempo real com histórico por hora/dia e timeline de eventos</p>
      </div>
      <div class="controls">
        <label class="dim">Horas:
          <input id="hours" type="number" min="6" max="168" value="48" style="width:72px"/>
        </label>
        <label class="dim">Dias:
          <input id="days" type="number" min="7" max="120" value="30" style="width:72px"/>
        </label>
        <button id="apply">Aplicar</button>
        <a href="/api/vivino/metrics" target="_blank">JSON</a>
        <a href="/api/vivino/metrics.txt" target="_blank">TXT</a>
        <a href="/admin">Voltar</a>
      </div>
    </div>

    <div class="cards">
      <div class="card"><div class="k">Progresso Job</div><div id="cJobProgress" class="v">-</div><div id="cJobProgressSub" class="sub">-</div></div>
      <div class="card"><div class="k">Extraidos Neste Job</div><div id="cJobExtracted" class="v">-</div><div id="cJobExtractedSub" class="sub">-</div></div>
      <div class="card"><div class="k">Faltam Neste Job</div><div id="cJobRemaining" class="v">-</div><div id="cJobRemainingSub" class="sub">-</div></div>
      <div class="card"><div class="k">Ja Na Base Antes</div><div id="cBeforeJob" class="v">-</div><div id="cBeforeJobSub" class="sub">-</div></div>
      <div class="card"><div class="k">Ritmo Job</div><div id="cJobRate" class="v">-</div><div id="cJobRateSub" class="sub">-</div></div>
      <div class="card"><div class="k">Ritmo 1h / 24h</div><div id="cWindowRate" class="v">-</div><div id="cWindowRateSub" class="sub">-</div></div>
      <div class="card"><div class="k">ETA Job</div><div id="cJobEta" class="v">-</div><div id="cJobEtaSub" class="sub">-</div></div>
      <div class="card"><div class="k">Base Total</div><div id="cBase" class="v">-</div><div id="cBaseSub" class="sub">-</div></div>
    </div>

    <div class="grid">
      <div>
        <div class="panel">
          <h2>Passo a Passo do Lote</h2>
          <div class="progress-shell"><div id="batchBar" class="progress-bar"></div></div>
          <div class="cols">
            <div class="mini">Lote atual<b id="mBatch">-</b></div>
            <div class="mini">OK / Retry<b id="mOkRetry">-</b></div>
            <div class="mini">Fase / Ciclo<b id="mPhase">-</b></div>
            <div class="mini">Ritmo job<b id="mRateBatch">-</b></div>
            <div class="mini">Ritmo janela<b id="mRateGlobal">-</b></div>
            <div class="mini">Reviews rows<b id="mRows">-</b></div>
          </div>
          <div id="mUpdated" class="footer">Atualizado: -</div>
        </div>

        <div class="panel">
          <h2>Histórico por Hora (vinhos concluídos)</h2>
          <div id="hourlyChart" class="chart"></div>
          <div class="legend">Cada barra representa 1 hora. Janela configurável (6-168h).</div>
        </div>

        <div class="panel">
          <h2>Histórico por Dia (vinhos concluídos)</h2>
          <div id="dailyChart" class="chart"></div>
          <div class="legend">Cada barra representa 1 dia. Janela configurável (7-120d).</div>
        </div>
      </div>

      <div>
        <div class="panel">
          <h2>Top Pendentes por Ratings</h2>
          <div style="overflow:auto;max-height:260px">
            <table>
              <thead><tr><th>ID</th><th>Ratings</th><th>Reviews DB</th></tr></thead>
              <tbody id="pendingRows"></tbody>
            </table>
          </div>
        </div>

        <div class="panel">
          <h2>Eventos Recentes (timeline)</h2>
          <div class="evt">
            <table>
              <thead><tr><th>Hora</th><th>Stage</th><th>Mensagem</th></tr></thead>
              <tbody id="eventRows"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const state = { hourly: 48, daily: 30, timer: null, loading: false };
    const fmt = new Intl.NumberFormat('pt-BR');
    const fmt1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
    const fmt2 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

    function byId(id){ return document.getElementById(id); }
    function toNum(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
    function human(v){ return fmt.format(toNum(v)); }
    function pct(v){ return Number.isFinite(v) ? v.toFixed(2) + '%' : 'n/a'; }
    function dur(seconds){
      const s = Math.floor(toNum(seconds));
      if (!Number.isFinite(s) || s <= 0) return '0s';
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      if (h > 0) return h + 'h ' + m + 'm';
      if (m > 0) return m + 'm ' + sec + 's';
      return sec + 's';
    }

    function cssClassByPhase(phase){
      if (phase === 'fatal_error' || phase === 'error') return 'err';
      if (phase === 'batch_running' || phase === 'batch_done') return 'ok';
      return 'warn';
    }

    function renderBars(containerId, points, key, dayMode){
      const wrap = byId(containerId);
      if (!wrap) return;
      wrap.innerHTML = '';
      const list = Array.isArray(points) ? points : [];
      if (!list.length) return;
      const max = Math.max(...list.map(x => toNum(x[key])), 1);
      for (const p of list) {
        const value = toNum(p[key]);
        const h = Math.max(4, Math.round((value / max) * 130));
        const bar = document.createElement('div');
        bar.className = dayMode ? 'bar day' : 'bar';
        bar.style.height = h + 'px';
        bar.title = (p.bucketStart || '') + ' | ' + key + '=' + value;
        wrap.appendChild(bar);
      }
    }

    function renderPending(rows){
      const body = byId('pendingRows');
      if (!body) return;
      body.innerHTML = '';
      (rows || []).forEach((r) => {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td class="mono">' + String(r.id || '-') + '</td>' +
          '<td>' + human(r.totalRatings) + '</td>' +
          '<td>' + human(r.totalReviewsDb) + '</td>';
        body.appendChild(tr);
      });
    }

    function renderEvents(rows){
      const body = byId('eventRows');
      if (!body) return;
      body.innerHTML = '';
      const list = (rows || []).slice().reverse().slice(0, 120);
      list.forEach((e) => {
        const tr = document.createElement('tr');
        const dt = e.ts ? new Date(e.ts) : null;
        const hh = dt && !Number.isNaN(dt.getTime()) ? dt.toLocaleTimeString('pt-BR') : '-';
        const stage = String(e.stage || '-');
        const msg = String(e.message || '');
        tr.innerHTML = '<td class="mono dim">' + hh + '</td>' +
          '<td class="mono">' + stage + '</td>' +
          '<td>' + msg + '</td>';
        body.appendChild(tr);
      });
    }

    function render(metrics){
      const m = metrics || {};
      const base = m.base || {};
      const job = m.job || {};
      const tp = m.throughput || {};
      const wines = tp.wines || {};
      const eta = m.eta || {};
      const worker = m.worker || {};
      const batch = worker.currentBatch || {};
      const pending = m.pending || {};

      const jobTarget = toNum(job.targetToExtract);
      const jobDone = toNum(job.extractedThisJob);
      const jobRemaining = toNum(job.remainingThisJob);
      const jobBefore = toNum(job.doneBeforeJob);
      const jobRateMin = toNum(job.ratePerMinute);
      const jobRateHour = toNum(job.ratePerHour);

      byId('cJobProgress').textContent = pct(job.progressPct);
      byId('cJobProgressSub').textContent = human(jobDone) + ' / ' + human(jobTarget);

      byId('cJobExtracted').textContent = human(jobDone);
      byId('cJobExtractedSub').textContent = 'meta deste job: ' + human(jobTarget);

      byId('cJobRemaining').textContent = human(jobRemaining);
      byId('cJobRemainingSub').textContent = 'pendentes no job atual';

      byId('cBeforeJob').textContent = human(jobBefore);
      byId('cBeforeJobSub').textContent = 'ja coletados antes desta execucao';

      byId('cJobRate').textContent = fmt2.format(jobRateMin) + '/min';
      byId('cJobRateSub').textContent = fmt2.format(jobRateHour) + '/h no job atual';

      byId('cWindowRate').textContent = human(wines.last1h) + '/h';
      byId('cWindowRateSub').textContent = human(wines.last24h) + '/24h | media ' + fmt2.format(toNum(wines.avgPerHour24h)) + '/h';

      byId('cJobEta').textContent = String(job.etaHuman || 'n/a');
      byId('cJobEtaSub').textContent = 'live global: ' + String(eta.byLiveRateHuman || 'n/a');

      byId('cBase').textContent = human(base.winesDoneTotal) + ' / ' + human(base.winesEligibleTotal);
      byId('cBaseSub').textContent = pct(base.progressPct) + ' | pendentes ' + human(base.winesPendingTotal) + ' | ratings avg ' + fmt2.format(toNum(pending.avgRatings));

      const target = toNum(batch.target);
      const processed = toNum(batch.processed);
      const pctBatch = target > 0 ? (processed / target) * 100 : 0;
      byId('batchBar').style.width = Math.max(0, Math.min(100, pctBatch)) + '%';
      byId('mBatch').textContent = processed + ' / ' + target + ' (' + pct(pctBatch) + ')';
      byId('mOkRetry').textContent = human(batch.ok) + ' / ' + human(batch.retryLater);
      byId('mPhase').textContent = String(worker.phase || 'n/a') + ' | ' + human(worker.cycle);
      byId('mRateBatch').textContent = fmt2.format(jobRateMin) + ' vinhos/min';
      byId('mRateGlobal').textContent = human(wines.last1h) + '/h | ' + human(wines.last24h) + '/24h';
      byId('mRows').textContent = human(base.reviewsRowsTotal) + ' (sum=' + human(base.reviewsSumDoneWines) + ')';
      byId('mUpdated').textContent = 'Atualizado: ' + String(m.generatedAt || '-') + ' | Job: ' + String(job.startedAt || '-') + ' | Elapsed: ' + dur(job.elapsedSeconds);

      renderBars('hourlyChart', m.history && m.history.hourly, 'winesDone', false);
      renderBars('dailyChart', m.history && m.history.daily, 'winesDone', true);
      renderPending(pending.topPendingByRatings);
      renderEvents(m.events);
    }

    async function refresh(){
      if (state.loading) return;
      state.loading = true;
      try {
        const url = '/api/vivino/metrics?hourly_hours=' + encodeURIComponent(state.hourly) +
          '&daily_days=' + encodeURIComponent(state.daily);
        const res = await fetch(url);
        const data = await res.json();
        if (!data || !data.ok || !data.metrics) throw new Error((data && data.error) ? data.error : 'Sem dados');
        render(data.metrics);
      } catch (err) {
        console.error(err);
      } finally {
        state.loading = false;
      }
    }

    function applyConfig(){
      const h = Math.max(6, Math.min(168, toNum(byId('hours').value || 48)));
      const d = Math.max(7, Math.min(120, toNum(byId('days').value || 30)));
      state.hourly = h;
      state.daily = d;
      byId('hours').value = String(h);
      byId('days').value = String(d);
      refresh();
    }

    byId('apply').addEventListener('click', applyConfig);
    window.addEventListener('load', () => {
      refresh();
      state.timer = setInterval(refresh, 3000);
    });
  </script>
</body>
</html>`);
});

// QR em SVG (com auto-refresh se não disponível)
app.get('/qr/:id', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const id = req.params.id;
  const it = instances.get(id);
  if (!it) return res.status(404).send('instância não encontrada');

  try {
    // Tenta pegar QR do cache imediatamente
    let qr = qrStore.get(id) || it.client.getQRCode?.() || null;

    // Se não tem, espera só 3 segundos (não 25)
    if (!qr) {
      await it.client.forceQRGeneration?.().catch(()=>{});
      for (let i = 0; i < 6 && !qr; i++) {
        await sleep(500);
        qr = qrStore.get(id) || it.client.getQRCode?.() || null;
      }
    }

    // Se ainda não tem QR, mostra página que atualiza sozinha
    if (!qr) {
      res.type('text/html');
      return res.send(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="3">
<title>Aguardando QR - ${id}</title>
<style>
  body{font-family:system-ui;background:#0b1020;color:#e6e9ef;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column}
  .loader{border:4px solid #334766;border-top:4px solid #c2ffd2;border-radius:50%;width:40px;height:40px;animation:spin 1s linear infinite;margin-bottom:16px}
  @keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
</style>
</head><body>
<div class="loader"></div>
<p>Aguardando QR para ${id}...</p>
<p style="font-size:12px;color:#99a3b5">Atualizando automaticamente</p>
</body></html>`);
    }

    const svg = await QRCode.toString(qr, { type: 'svg', margin: 1, width: 264 });
    res.type('image/svg+xml');
    return res.send(svg);
  } catch (e) {
    return res.status(500).send(String(e?.message || e));
  }
});

// conectar: reinicia a instância
app.post('/api/:id/connect', basicAuth, async (req, res) => {
  const it = instances.get(req.params.id);
  if (!it) return res.status(404).json({ ok: false, error: 'instância não encontrada' });
  
  try {
    // Cancela qualquer reconexão pendente
    if (it.reconnectTimer) {
      clearTimeout(it.reconnectTimer);
      it.reconnectTimer = null;
    }
    
    // Reset do contador
    it.reconnectAttempts = 0;
    qrStore.delete(it.id);
    
    await initializeInstance(it);
    return res.json({ ok: true, hint: `Abra /qr/${it.id} para escanear` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// limpar sessão (logout "hard") e reabrir para já gerar novo QR
app.post('/api/:id/clear', basicAuth, async (req, res) => {
  const it = instances.get(req.params.id);
  if (!it) return res.status(404).json({ ok: false, error: 'instância não encontrada' });
  
  try {
    // Cancela qualquer reconexão pendente
    if (it.reconnectTimer) {
      clearTimeout(it.reconnectTimer);
      it.reconnectTimer = null;
    }
    
    await clearAndReinitialize(it);
    return res.json({ ok: true, message: 'Sessão limpa. Gere o novo QR em /qr/' + it.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// NOVO: Força reconexão de todas as instâncias desconectadas
app.post('/api/reconnect-all', basicAuth, async (req, res) => {
  const results = [];
  
  for (const [id, it] of instances) {
    if (it.state !== 'connected') {
      it.reconnectAttempts = 0;
      if (it.reconnectTimer) {
        clearTimeout(it.reconnectTimer);
        it.reconnectTimer = null;
      }
      scheduleReconnect(it);
      results.push({ id, action: 'reconnect_scheduled' });
    } else {
      results.push({ id, action: 'already_connected' });
    }
  }
  
  res.json({ ok: true, results });
});

// NOVO: uso de disco por área (sessões + mídia) e espaço livre
app.get('/api/disk/usage', basicAuth, (req, res) => {
  try {
    res.json({ ok: true, ...diskCleanup.getUsage() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// NOVO: limpeza de disco sob demanda (apaga só o que o Baileys recria + mídia antiga)
app.post('/api/disk/cleanup', basicAuth, (req, res) => {
  try {
    const before = diskCleanup.getUsage();
    const result = diskCleanup.runCleanup();
    const after = diskCleanup.getUsage();
    res.json({ ok: true, result, before, after });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// página simples (protegida se ADMIN_* definidos)
app.get(['/','/admin'], basicAuth, async (req, res) => {
  const rows = await (async () => {
    const out = [];
    for (const it of instances.values()) {
      const st = (typeof it.client.getConnectionStatus === 'function')
        ? it.client.getConnectionStatus()
        : {};
      const user = st.user?.id || '';
      
      // NOVO: Badge com mais estados
      let badgeClass = 'down';
      let badgeText = 'Desconectado';
      
      if (it.state === 'connected') {
        badgeClass = 'ok';
        badgeText = 'Conectado';
      } else if (it.state === 'connecting') {
        badgeClass = 'warn';
        badgeText = 'Conectando...';
      } else if (it.state === 'waiting_qr') {
        badgeClass = 'warn';
        badgeText = 'Aguardando QR';
      } else if (it.state === 'waiting_reconnect') {
        badgeClass = 'warn';
        badgeText = `Reconectando (${it.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})`;
      } else if (it.state === 'waiting_manual') {
        badgeClass = 'error';
        badgeText = 'Ação Manual Necessária';
      } else if (it.state === 'logged_out') {
        badgeClass = 'error';
        badgeText = 'Sessão Expirada';
      }
      
      // NOVO: Mostra último erro se houver
      const errorLine = it.lastError 
        ? `<div class="meta error">Erro: ${it.lastError}</div>` 
        : '';
      
      out.push(`
        <div class="card">
          <div class="head">
            <div class="id"># ${it.id}</div>
            <div class="badge ${badgeClass}">${badgeText}</div>
          </div>
          <div class="meta">Sessão: ${it.sessPath}</div>
          <div class="meta">User: ${user || '—'}</div>
          ${errorLine}
          <div class="actions">
            <button onclick="doPost('/api/${it.id}/connect')">Conectar</button>
            <a class="qr" href="/qr/${it.id}" target="_blank">Ver QR</a>
            <button class="danger" onclick="doPost('/api/${it.id}/clear')">Limpar sessão</button>
          </div>
        </div>
      `);
    }
    return out.join('\n');
  })();

  // NOVO: Contagem de status
  const connected = Array.from(instances.values()).filter(x => x.state === 'connected').length;
  const total = instances.size;
  const vivinoSnapshot = getVivinoProgressSnapshot();
  const vivinoLines = buildVivinoProgressLines(vivinoSnapshot).join('\n');
  const vivinoPhase = String(vivinoSnapshot.phase || 'unknown');
  const vivinoBadgeClass = (vivinoPhase === 'fatal_error' || vivinoPhase === 'error')
    ? 'error'
    : (vivinoPhase === 'batch_running' ? 'ok' : 'warn');

  res.send(`<!DOCTYPE html><html lang="pt-br"><head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>WA Bots - Multi</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;background:#0b1020;color:#e6e9ef;margin:0;padding:24px}
    h1{font-size:20px;margin:0 0 8px}
    .summary{font-size:14px;color:#99a3b5;margin-bottom:16px}
    .summary strong{color:#e6e9ef}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
    .card{background:#121a2a;border:1px solid #22304a;border-radius:12px;padding:16px}
    .head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
    .id{font-weight:600}
    .badge{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid #334766}
    .badge.ok{color:#c2ffd2;border-color:#2f7b43;background:#16301c}
    .badge.down{color:#ffd1d1;border-color:#7b2f2f;background:#301616}
    .badge.warn{color:#fff3c2;border-color:#7b6b2f;background:#302c16}
    .badge.error{color:#ff9999;border-color:#993333;background:#331111}
    .meta{font-size:12px;color:#99a3b5;margin:4px 0}
    .meta.error{color:#ff9999}
    .actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
    button,.qr{appearance:none;border:1px solid #334766;background:#1a2438;color:#e6e9ef;padding:8px 12px;border-radius:8px;cursor:pointer;text-decoration:none;font-size:13px}
    button:hover,.qr:hover{background:#22304a}
    .danger{border-color:#7b2f2f}
    .global-actions{margin-bottom:16px;display:flex;gap:8px}
    .vivino-card{margin-bottom:16px}
    #vivino-progress{margin:0;white-space:pre-wrap;font-size:12px;line-height:1.45;color:#cdd6e3;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  </style>
  <script>
    async function doPost(url){
      if(url.includes('/clear')){
        if(!confirm('Tem certeza que deseja limpar a sessao?')) return;
      }
      const r = await fetch(url,{method:'POST'});
      const j = await r.json().catch(()=>({}));
      if(j.ok && (url.includes('/connect') || url.includes('/clear'))){
        const id = url.split('/api/')[1]?.split('/')[0];
        if(id) window.open('/qr/'+id, '_blank');
      }
      location.reload();
    }
    function fmtBytes(n){
      const b = Number(n)||0;
      if(b < 1024) return b+' B';
      if(b < 1048576) return (b/1024).toFixed(1)+' KB';
      if(b < 1073741824) return (b/1048576).toFixed(1)+' MB';
      return (b/1073741824).toFixed(2)+' GB';
    }
    async function refreshDiskUsage(){
      try{
        const r = await fetch('/api/disk/usage');
        const j = await r.json();
        if(!j || !j.ok) return;
        const box = document.getElementById('disk-usage');
        if(!box) return;
        const parts = (j.areas||[]).map(a => a.name+': '+fmtBytes(a.bytes)+' ('+a.files+' arq)');
        let txt = 'Disco — ' + parts.join(' | ');
        if(j.disk && j.disk.total){
          const usado = j.disk.total - j.disk.available;
          txt += ' || Disco total: '+fmtBytes(usado)+' / '+fmtBytes(j.disk.total)+' (livre '+fmtBytes(j.disk.available)+')';
        }
        box.textContent = txt;
      }catch(_){}
    }
    async function limparDisco(){
      if(!confirm('Limpar disco agora? Apaga só cache de sessão (o WhatsApp recria) e mídia antiga. Não desconecta os números.')) return;
      try{
        const r = await fetch('/api/disk/cleanup',{method:'POST'});
        const j = await r.json();
        if(j && j.ok){
          const res = j.result || {};
          alert('Pronto! Liberado: '+(res.totalHuman||'0')+' em '+(res.totalRemoved||0)+' arquivos.\\n(sessão: '+((res.session&&res.session.removed)||0)+' | mídia: '+((res.media&&res.media.removed)||0)+')');
        }else{
          alert('Erro ao limpar: '+((j&&j.error)||'desconhecido'));
        }
      }catch(e){
        alert('Erro ao limpar disco: '+(e&&e.message||e));
      }
      refreshDiskUsage();
    }
    function renderVivinoPanel(p){
      if(!p) return;
      const total = Number(p.totalEligible || 0);
      const done = Number(p.doneEligible || 0);
      const pending = Number(p.pendingEligible || 0);
      const progressPct = total > 0 ? (done / total) * 100 : 0;
      const batch = p.currentBatch || {};
      const rates = p.rates || {};
      const sessionFetched = Number(p.sessionReviewsFetched || 0);
      const sessionRows = Number(p.sessionReviewsRowsDelta || 0);
      const sessionDup = Math.max(0, sessionFetched - sessionRows);
      const lines = [
        'VIVINO: ' + done.toLocaleString('pt-BR') + ' / ' + total.toLocaleString('pt-BR') + ' (' + progressPct.toFixed(2) + '%)',
        'Pendentes: ' + pending.toLocaleString('pt-BR') + ' | Retry cooldown: ' + Number(p.retryCooldownCount || 0).toLocaleString('pt-BR'),
        'Lote: ' + Number(batch.processed || 0) + '/' + Number(batch.target || 0) + ' | OK=' + Number(batch.ok || 0) + ' | Retry=' + Number(batch.retryLater || 0),
        'Velocidade: lote=' + Number(rates.batchWinesPerSec || 0).toFixed(2) + ' vinhos/s | geral=' + Number(rates.globalWinesPerSec || 0).toFixed(2) + ' vinhos/s | ETA=' + String((p.derived && p.derived.etaHuman) || 'n/a'),
        'Base: reviews_rows=' + Number(p.totalReviewsRows || 0).toLocaleString('pt-BR') + ' | sum_reviews_vinhos=' + Number(p.doneReviewsDbSum || 0).toLocaleString('pt-BR'),
        'Sessao: +vinhos=' + Number(p.sessionWinesDone || 0).toLocaleString('pt-BR') + ' | reviews_fetch=' + sessionFetched.toLocaleString('pt-BR') + ' | novos_rows=' + sessionRows.toLocaleString('pt-BR') + ' | repetidos_est=' + sessionDup.toLocaleString('pt-BR'),
        'Fase: ' + String(p.phase || 'unknown') + ' | Ciclo: ' + Number(p.cycle || 0) + ' | Atualizado: ' + (p.updatedAt ? new Date(p.updatedAt).toISOString() : 'n/a'),
      ];
      const box = document.getElementById('vivino-progress');
      if (box) box.textContent = lines.join('\\n');
      const badge = document.getElementById('vivino-badge');
      if (badge) {
        const phase = String(p.phase || 'unknown');
        let klass = 'warn';
        if (phase === 'fatal_error' || phase === 'error') klass = 'error';
        if (phase === 'batch_running') klass = 'ok';
        badge.className = 'badge ' + klass;
        badge.textContent = phase;
      }
    }
    async function refreshVivino(){
      try {
        const r = await fetch('/api/vivino/progress');
        if(!r.ok) return;
        const j = await r.json();
        if (j && j.progress) renderVivinoPanel(j.progress);
      } catch (_) {}
    }
    window.addEventListener('load', () => {
      refreshVivino();
      refreshDiskUsage();
      setInterval(refreshVivino, 2000);
      setInterval(()=>location.reload(), 15000);
    });
  </script>
  </head><body>
    <h1>WhatsApp Bots - Multi-instancia</h1>
    <div class="summary">
      <strong>${connected}</strong> de <strong>${total}</strong> conectados
    </div>
    <div class="global-actions">
      <button onclick="doPost('/api/reconnect-all')">Reconectar Todos Desconectados</button>
      <button class="danger" onclick="limparDisco()">🧹 Limpar disco agora</button>
      <a class="qr" href="/admin/vivino" target="_blank">Painel Vivino</a>
    </div>
    <div class="summary" id="disk-usage">Disco: carregando…</div>
    <div class="card vivino-card">
      <div class="head">
        <div class="id">Vivino Worker</div>
        <div id="vivino-badge" class="badge ${vivinoBadgeClass}">${vivinoPhase}</div>
      </div>
      <pre id="vivino-progress">${vivinoLines}</pre>
      <div class="actions">
        <a class="qr" href="/api/vivino/progress" target="_blank">JSON progresso</a>
        <a class="qr" href="/api/vivino/progress.txt" target="_blank">TXT progresso</a>
        <a class="qr" href="/api/vivino/metrics" target="_blank">JSON metrics</a>
        <a class="qr" href="/api/vivino/metrics.txt" target="_blank">TXT metrics</a>
      </div>
    </div>
    <div class="grid">
      ${rows}
    </div>
  </body></html>`);
});

app.listen(PORT, () => {
  const instancesInfo = WA_BOTS_ENABLED ? WA_INSTANCE_IDS.join(',') : '(disabled)';
  console.log(`[bots] online on :${PORT} TZ=${TZ} wa_enabled=${WA_BOTS_ENABLED} instances=${instancesInfo}`);
  startVivinoReviewsWorker().catch((e) => {
    console.error('[vivino-worker] falha ao iniciar:', e?.message || e);
  });
  diskCleanup.startAutoCleanup();
});

