const { Pool } = require('pg');
const { ProxyAgent } = require('undici');

function envString(name, fallback = '') {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const trimmed = String(raw).trim();
  if (!trimmed) return fallback;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function looksLikeProxyPlaceholder(value) {
  if (!value) return false;
  return /:\/\/(?:USER|USERNAME):(?:PASS|PASSWORD)@/i.test(value);
}

const VIVINO_BASE_URL = envString('VIVINO_BASE_URL', 'https://www.vivino.com');
const EXPLICIT_VIVINO_DATABASE_URL = envString('VIVINO_DATABASE_URL', '');
const FALLBACK_DATABASE_URL = envString('DATABASE_URL', '');
const REQUIRE_EXPLICIT_VIVINO_DATABASE_URL = String(
  process.env.VIVINO_REQUIRE_EXPLICIT_DATABASE_URL || 'true',
).trim().toLowerCase() === 'true';
const VIVINO_DATABASE_URL = EXPLICIT_VIVINO_DATABASE_URL
  || (REQUIRE_EXPLICIT_VIVINO_DATABASE_URL ? '' : FALLBACK_DATABASE_URL);
const DATABASE_SOURCE = EXPLICIT_VIVINO_DATABASE_URL
  ? 'VIVINO_DATABASE_URL'
  : (VIVINO_DATABASE_URL ? 'DATABASE_URL' : 'missing');
const BROKER_BASE_URL = envString('VIVINO_BROKER_URL', '').replace(/\/+$/, '');
const BROKER_TOKEN = envString('VIVINO_BROKER_TOKEN', '');
const BROKER_TIMEOUT_MS = Number(process.env.VIVINO_BROKER_TIMEOUT_MS || 60000);
const BROKER_STATS_TIMEOUT_MS = Number(
  process.env.VIVINO_BROKER_STATS_TIMEOUT_MS || Math.max(BROKER_TIMEOUT_MS, 90000),
);
const BROKER_RETRIES = Math.max(1, Number(process.env.VIVINO_BROKER_RETRIES || 3));
const BROKER_RETRY_BASE_MS = Number(process.env.VIVINO_BROKER_RETRY_BASE_MS || 1500);
const BROKER_RECOVERY_SLEEP_MS = Number(process.env.VIVINO_BROKER_RECOVERY_SLEEP_MS || 10000);
const BROKER_ENABLED = Boolean(BROKER_BASE_URL);
const STORAGE_MODE = BROKER_ENABLED ? 'broker' : 'database';
const WORKER_ENABLED = String(process.env.VIVINO_REVIEWS_WORKER_ENABLED || 'true') === 'true';
const WORKERS = Number(process.env.VIVINO_REVIEWS_WORKERS || 5);
const BATCH_SIZE = Number(process.env.VIVINO_REVIEWS_BATCH_SIZE || 500);
const MIN_RATINGS = Number(process.env.VIVINO_REVIEWS_MIN_RATINGS || 0);
const MAX_PAGES = Number(process.env.VIVINO_REVIEWS_MAX_PAGES || 2);
const PER_PAGE = Number(process.env.VIVINO_REVIEWS_PER_PAGE || 50);
const MAX_REVIEWS_PER_WINE = MAX_PAGES * PER_PAGE;
const MAX_RETRIES = Number(process.env.VIVINO_REVIEWS_MAX_RETRIES || 5);
const REQUEST_TIMEOUT_MS = Number(process.env.VIVINO_REVIEWS_REQUEST_TIMEOUT_MS || 30000);
const SLEEP_BETWEEN_BATCH_MS = Number(process.env.VIVINO_REVIEWS_SLEEP_BETWEEN_BATCH_MS || 5000);
const SLEEP_WHEN_EMPTY_MS = Number(process.env.VIVINO_REVIEWS_SLEEP_WHEN_EMPTY_MS || 120000);
const SLEEP_PER_WINE_MS = Number(process.env.VIVINO_REVIEWS_SLEEP_PER_WINE_MS || 150);
const RETRY_429_MS = Number(process.env.VIVINO_REVIEWS_RETRY_429_MS || 30000);
const RETRY_503_MS = Number(process.env.VIVINO_REVIEWS_RETRY_503_MS || 15000);
const RETRY_WINE_COOLDOWN_MS = Number(process.env.VIVINO_REVIEWS_RETRY_WINE_COOLDOWN_MS || 900000);
const RETRY_SELECTION_MULTIPLIER = Number(process.env.VIVINO_REVIEWS_RETRY_SELECTION_MULTIPLIER || 10);
const PROGRESS_LOG_EVERY = Number(process.env.VIVINO_PROGRESS_LOG_EVERY || 10);
const PROGRESS_LOG_INTERVAL_MS = Number(process.env.VIVINO_PROGRESS_LOG_INTERVAL_MS || 5000);
const PROXY_ENABLED = String(
  process.env.VIVINO_PROXY_ENABLED ?? process.env.PROXY_ENABLED ?? 'false',
).trim().toLowerCase() === 'true';
const PROXY_URL = envString('VIVINO_PROXY_URL', envString('PROXY_URL', ''));
const PROXY_HOST = envString('VIVINO_PROXY_HOST', envString('PROXY_HOST', ''));
const PROXY_PORT = envString('VIVINO_PROXY_PORT', envString('PROXY_PORT', ''));
const PROXY_USER = envString('VIVINO_PROXY_USER', envString('PROXY_USER', ''));
const PROXY_PASS = envString('VIVINO_PROXY_PASS', envString('PROXY_PASS', ''));
const STEEL_ENABLED = String(process.env.VIVINO_STEEL_ENABLED || 'false').trim().toLowerCase() === 'true';
const STEEL_API_KEY = envString('VIVINO_STEEL_API_KEY', envString('STEEL_API_KEY', ''));
const STEEL_WS_ENDPOINT = envString('VIVINO_STEEL_WS_ENDPOINT', 'wss://connect.steel.dev');
const STEEL_TIMEOUT_MS = Number(process.env.VIVINO_STEEL_TIMEOUT_MS || 45000);
const STEEL_MAX_REQUESTS_PER_SESSION = Number(process.env.VIVINO_STEEL_MAX_REQUESTS_PER_SESSION || 25);
const METRICS_HOURLY_HOURS = Number(process.env.VIVINO_METRICS_HOURLY_HOURS || 48);
const METRICS_DAILY_DAYS = Number(process.env.VIVINO_METRICS_DAILY_DAYS || 30);
const EVENTS_MAX = Number(process.env.VIVINO_EVENTS_MAX || 300);
const ESTIMATED_RATING_GLOBAL_MEAN = 3.5;
const ESTIMATED_RATING_DUMMY_WEIGHT = 3.0;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

let started = false;
let vivinoDispatcher = null;
let steelBrowser = null;
let steelContext = null;
let steelPage = null;
let steelRequestCount = 0;
let steelLock = Promise.resolve();
let workerPool = null;
let metricsPool = null;
const retryLaterUntilByWine = new Map();
const workerEvents = [];
const workerProgress = {
  enabled: WORKER_ENABLED,
  started: false,
  startedAt: null,
  updatedAt: null,
  phase: 'idle',
  cycle: 0,
  workers: WORKERS,
  batchSize: BATCH_SIZE,
  maxPages: MAX_PAGES,
  totalEligible: 0,
  doneEligible: 0,
  pendingEligible: 0,
  totalReviewsRows: 0,
  doneReviewsDbSum: 0,
  sessionWinesDone: 0,
  sessionReviewsFetched: 0,
  sessionReviewsRowsDelta: 0,
  sessionBaseDoneEligible: 0,
  sessionBasePendingEligible: 0,
  sessionBaseReviewsRows: 0,
  currentBatch: {
    target: 0,
    processed: 0,
    ok: 0,
    retryLater: 0,
    pendingBefore: 0,
    pendingAfter: 0,
    startedAt: null,
    updatedAt: null,
  },
  rates: {
    batchWinesPerSec: 0,
    globalWinesPerSec: 0,
  },
  etaSeconds: null,
  lastError: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function pushWorkerEvent(level, stage, message, data = null) {
  const event = {
    ts: nowIso(),
    level: String(level || 'info'),
    stage: String(stage || 'general'),
    message: String(message || ''),
    data: data && typeof data === 'object' ? data : null,
  };
  workerEvents.push(event);
  while (workerEvents.length > Math.max(50, EVENTS_MAX)) {
    workerEvents.shift();
  }
}

function getVivinoWorkerEvents(limit = 100) {
  const n = clampIntRange(limit, 10, Math.max(50, EVENTS_MAX));
  return workerEvents.slice(-n);
}

function clampNonNegative(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function toIntegerOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getDatabaseConfigError() {
  if (BROKER_ENABLED) {
    if (!BROKER_TOKEN) return 'VIVINO_BROKER_TOKEN ausente';
    return null;
  }
  if (VIVINO_DATABASE_URL) return null;
  if (REQUIRE_EXPLICIT_VIVINO_DATABASE_URL) return 'VIVINO_DATABASE_URL ausente';
  return 'VIVINO_DATABASE_URL/DATABASE_URL ausente';
}

function describeDatabaseTarget(connectionString) {
  const info = {
    source: DATABASE_SOURCE,
    explicitRequired: REQUIRE_EXPLICIT_VIVINO_DATABASE_URL,
    configured: Boolean(connectionString),
    host: null,
    port: null,
    database: null,
    parseError: false,
  };
  if (!connectionString) return info;
  try {
    const parsed = new URL(connectionString);
    info.host = parsed.hostname || null;
    info.port = parsed.port ? Number(parsed.port) : null;
    info.database = (parsed.pathname || '').replace(/^\/+/, '') || null;
    return info;
  } catch (_) {
    info.parseError = true;
    return info;
  }
}

function describeBrokerTarget() {
  return {
    enabled: BROKER_ENABLED,
    configured: BROKER_ENABLED,
    url: BROKER_BASE_URL || null,
    hasToken: Boolean(BROKER_TOKEN),
  };
}

function shouldRetryBrokerStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isTransientBrokerError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  const msg = String(err.message || err);
  return /aborted|timeout|timed out|fetch failed|socket hang up|econnreset|econnrefused|ehostunreach|enotfound|etimedout/i.test(msg);
}

function brokerRetryDelayMs(attempt) {
  const exp = Math.max(0, attempt - 1);
  return Math.min(15000, Math.max(500, BROKER_RETRY_BASE_MS * (2 ** exp)));
}

async function brokerRequest(path, options = {}) {
  if (!BROKER_ENABLED) {
    throw new Error('broker desabilitado');
  }
  if (!BROKER_TOKEN) {
    throw new Error('VIVINO_BROKER_TOKEN ausente');
  }

  const method = String(options.method || 'GET').toUpperCase();
  const url = path.startsWith('http') ? path : `${BROKER_BASE_URL}${path}`;
  const headers = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${BROKER_TOKEN}`,
  };
  if (options.body != null) {
    headers['Content-Type'] = 'application/json';
  }
  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs || BROKER_TIMEOUT_MS),
  );
  const maxAttempts = Math.max(
    1,
    Number(options.maxAttempts || (method === 'GET' ? BROKER_RETRIES : Math.min(2, BROKER_RETRIES))),
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: options.body != null ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {
        data = null;
      }
      if (!response.ok || (data && data.ok === false)) {
        const err = new Error(`broker ${method} ${path} falhou: ${response.status} ${(data && data.error) || text || 'erro'}`);
        err.status = response.status;
        err.retryable = shouldRetryBrokerStatus(response.status);
        throw err;
      }
      return data || {};
    } catch (err) {
      const retryable = Boolean(err && err.retryable) || isTransientBrokerError(err);
      if (attempt < maxAttempts && retryable) {
        const waitMs = brokerRetryDelayMs(attempt);
        const msg = String(err && err.message ? err.message : err);
        console.warn(
          `[vivino-worker] broker retry ${attempt}/${maxAttempts - 1} em ${method} ${path}: ${msg} | aguardando ${waitMs}ms`,
        );
        await sleep(waitMs);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`broker ${method} ${path} excedeu tentativas`);
}

async function getBrokerPendingWineIds(limit) {
  const data = await brokerRequest(
    `/api/vivino/broker/next-batch?limit=${encodeURIComponent(limit)}&min_ratings=${encodeURIComponent(MIN_RATINGS)}`,
  );
  return Array.isArray(data.ids) ? data.ids.map((id) => Number(id)) : [];
}

async function getBrokerGlobalProgressStats() {
  const data = await brokerRequest(
    `/api/vivino/broker/stats?min_ratings=${encodeURIComponent(MIN_RATINGS)}`,
    {
      timeoutMs: BROKER_STATS_TIMEOUT_MS,
      maxAttempts: Math.max(2, BROKER_RETRIES),
    },
  );
  const base = data.base || {};
  return {
    totalEligible: Number(base.totalEligible || 0),
    doneEligible: Number(base.doneEligible || 0),
    pendingEligible: Number(base.pendingEligible || 0),
    doneReviewsDbSum: Number(base.doneReviewsDbSum || 0),
    totalReviewsRows: Number(base.reviewsRowsTotal || 0),
  };
}

async function brokerPersistCollectedWine(wineId, totalReviews, reviews) {
  return brokerRequest('/api/vivino/broker/reviews', {
    method: 'POST',
    body: {
      wineId,
      totalReviews,
      reviews,
    },
  });
}

async function getBrokerMetricsSnapshot(options = {}) {
  const hourlyHours = clampIntRange(
    options && options.hourlyHours != null ? options.hourlyHours : METRICS_HOURLY_HOURS,
    6,
    168,
  );
  const dailyDays = clampIntRange(
    options && options.dailyDays != null ? options.dailyDays : METRICS_DAILY_DAYS,
    7,
    120,
  );
  return brokerRequest(
    `/api/vivino/broker/metrics?min_ratings=${encodeURIComponent(MIN_RATINGS)}&hourly_hours=${encodeURIComponent(hourlyHours)}&daily_days=${encodeURIComponent(dailyDays)}`,
    {
      timeoutMs: BROKER_STATS_TIMEOUT_MS,
      maxAttempts: Math.max(2, BROKER_RETRIES),
    },
  );
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

function setupProxyIfEnabled() {
  console.log(`[vivino-worker] proxy_enabled=${PROXY_ENABLED}`);
  if (!PROXY_ENABLED) return;

  let proxy = PROXY_URL;
  if (looksLikeProxyPlaceholder(proxy) && PROXY_HOST && PROXY_PORT) {
    proxy = '';
  }
  if (!proxy && PROXY_HOST && PROXY_PORT) {
    if (PROXY_USER || PROXY_PASS) {
      const user = encodeURIComponent(PROXY_USER);
      const pass = encodeURIComponent(PROXY_PASS);
      proxy = `http://${user}:${pass}@${PROXY_HOST}:${PROXY_PORT}`;
    } else {
      proxy = `http://${PROXY_HOST}:${PROXY_PORT}`;
    }
  }

  if (!proxy) {
    console.log('[vivino-worker] VIVINO_PROXY_ENABLED=true, mas proxy nao configurado. seguindo sem proxy.');
    return;
  }

  vivinoDispatcher = new ProxyAgent(proxy);
  const masked = proxy.replace(/\/\/([^:@]+):([^@]+)@/, '//***:***@');
  console.log(`[vivino-worker] proxy ativo para requests Vivino (${masked})`);
}

function headers() {
  return {
    'Accept': 'application/json',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://www.vivino.com/explore',
    'X-Requested-With': 'XMLHttpRequest',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
  };
}

async function fetchJsonWithRetry(url) {
  let backoff = RETRY_429_MS;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'GET',
        dispatcher: vivinoDispatcher || undefined,
        headers: headers(),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 200) {
        const data = await res.json();
        return { ok: true, status: 200, data };
      }

      if (res.status === 429) {
        console.log(`[vivino-worker] 429 em ${url} (tentativa ${attempt}/${MAX_RETRIES})`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 300000);
        continue;
      }

      if (res.status === 503) {
        console.log(`[vivino-worker] 503 em ${url} (tentativa ${attempt}/${MAX_RETRIES})`);
        await sleep(RETRY_503_MS);
        continue;
      }

      if (res.status === 401 || res.status === 403 || res.status === 408 || res.status >= 500) {
        console.log(`[vivino-worker] status=${res.status} em ${url} (tentativa ${attempt}/${MAX_RETRIES})`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 300000);
        continue;
      }

      // Erros permanentes, nao insistir.
      return { ok: false, transient: false, status: res.status };
    } catch (err) {
      clearTimeout(timer);
      const msg = String(err && err.message ? err.message : err);
      console.log(`[vivino-worker] erro request ${url} (tentativa ${attempt}/${MAX_RETRIES}): ${msg}`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 300000);
    }
  }

  if (STEEL_ENABLED && STEEL_API_KEY) {
    console.log(`[vivino-worker] fallback Steel.dev acionado para ${url}`);
    pushWorkerEvent('warn', 'steel_fallback', 'Fallback Steel.dev acionado', { url });
    return fetchJsonViaSteel(url);
  }

  return { ok: false, transient: true, status: 0 };
}

async function withSteelLock(task) {
  const previous = steelLock;
  let release;
  steelLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
  }
}

async function closeSteelBrowser() {
  if (steelPage) {
    try { await steelPage.close(); } catch (_) {}
    steelPage = null;
  }
  if (steelContext) {
    try { await steelContext.close(); } catch (_) {}
    steelContext = null;
  }
  if (steelBrowser) {
    try { await steelBrowser.close(); } catch (_) {}
    steelBrowser = null;
  }
  steelRequestCount = 0;
}

async function ensureSteelPage() {
  if (!STEEL_ENABLED || !STEEL_API_KEY) return null;

  if (steelPage && !steelPage.isClosed() && steelRequestCount < STEEL_MAX_REQUESTS_PER_SESSION) {
    return steelPage;
  }

  await closeSteelBrowser();

  const playwright = require('playwright-core');
  const wsUrl = `${STEEL_WS_ENDPOINT}?apiKey=${encodeURIComponent(STEEL_API_KEY)}`;
  steelBrowser = await playwright.chromium.connectOverCDP(wsUrl);
  steelContext = steelBrowser.contexts()[0] || await steelBrowser.newContext({
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    viewport: { width: 1366, height: 768 },
  });
  steelPage = await steelContext.newPage();
  steelPage.setDefaultNavigationTimeout(STEEL_TIMEOUT_MS);
  steelPage.setDefaultTimeout(STEEL_TIMEOUT_MS);
  await steelPage.setExtraHTTPHeaders(headers());

  // Warm up a real session on Vivino before API calls.
  await steelPage.goto(VIVINO_BASE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: STEEL_TIMEOUT_MS,
  }).catch(() => {});

  steelRequestCount = 0;
  return steelPage;
}

async function fetchJsonViaSteel(url) {
  return withSteelLock(async () => {
    const page = await ensureSteelPage();
    if (!page || !steelContext) return { ok: false, transient: true, status: 0 };

    const parseJsonText = (text) => {
      try {
        return { ok: true, data: JSON.parse(text) };
      } catch (_) {
        return { ok: false, data: null };
      }
    };

    const logPayloadPreview = (prefix, text) => {
      const preview = String(text || '').slice(0, 220).replace(/\s+/g, ' ');
      console.log(`${prefix}: ${preview}`);
    };

    try {
      const response = await steelContext.request.get(url, {
        headers: headers(),
        timeout: STEEL_TIMEOUT_MS,
      });
      const status = response.status();
      const text = await response.text();
      steelRequestCount += 1;

      if (status === 200) {
        const parsed = parseJsonText(text);
        if (parsed.ok) {
          console.log(`[vivino-worker] Steel request_context OK em ${url}`);
          pushWorkerEvent('info', 'steel_request_context', 'Steel request_context OK', { url, status });
          return { ok: true, status, data: parsed.data, via: 'steel_request_context' };
        }
        logPayloadPreview(`[vivino-worker] Steel request_context payload invalido em ${url}`, text);
      }

      try {
        const browserFetch = await page.evaluate(async (targetUrl) => {
          const res = await fetch(targetUrl, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
            },
          });
          const body = await res.text();
          return { status: res.status, body };
        }, url);

        steelRequestCount += 1;

        if (browserFetch.status === 200) {
          const parsed = parseJsonText(browserFetch.body);
          if (parsed.ok) {
            console.log(`[vivino-worker] Steel page_fetch OK em ${url}`);
            pushWorkerEvent('info', 'steel_page_fetch', 'Steel page_fetch OK', { url, status: browserFetch.status });
            return { ok: true, status: browserFetch.status, data: parsed.data, via: 'steel_page_fetch' };
          }
          logPayloadPreview(`[vivino-worker] Steel page_fetch payload invalido em ${url}`, browserFetch.body);
        } else {
          console.log(`[vivino-worker] Steel page_fetch status=${browserFetch.status} em ${url}`);
        }
      } catch (fallbackErr) {
        const fallbackMsg = String(fallbackErr && fallbackErr.message ? fallbackErr.message : fallbackErr);
        console.log(`[vivino-worker] Steel page_fetch erro em ${url}: ${fallbackMsg}`);
      }

      console.log(`[vivino-worker] Steel request_context status=${status} em ${url}`);
      pushWorkerEvent('warn', 'steel_status', 'Steel retornou status sem sucesso', { url, status });
      return { ok: false, transient: true, status };
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      console.log(`[vivino-worker] erro Steel.dev em ${url}: ${msg}`);
      pushWorkerEvent('error', 'steel_error', 'Erro no Steel.dev', { url, message: msg });
      await closeSteelBrowser();
      return { ok: false, transient: true, status: 0 };
    }
  });
}

function parseReview(item, wineId) {
  const user = item && item.user ? item.user : {};
  const userStats = user && user.statistics ? user.statistics : {};
  const vintage = item && item.vintage ? item.vintage : {};
  const activity = item && item.activity ? item.activity : {};
  const activityStats = activity && activity.statistics ? activity.statistics : {};

  let createdAt = null;
  if (item && item.created_at) {
    const d = new Date(item.created_at);
    if (!Number.isNaN(d.getTime())) createdAt = d.toISOString();
  }

  const vintageYear = Number.isInteger(vintage.year) ? vintage.year : null;

  return {
    id: toIntegerOrNull(item && item.id),
    vinho_id: toIntegerOrNull(wineId),
    rating: toNumberOrNull(item && item.rating),
    nota_texto: (item.note || '').replace(/\x00/g, ''),
    idioma: (item.language || '').replace(/\x00/g, ''),
    usuario_id: toIntegerOrNull(user.id),
    usuario_nome: ((user.alias || user.seo_name || '') || '').replace(/\x00/g, ''),
    safra_avaliada: vintageYear,
    criado_em: createdAt,
    usuario_total_ratings: toIntegerOrNull(userStats.ratings_count),
    usuario_total_reviews: toIntegerOrNull(userStats.reviews_count),
    usuario_followers: toIntegerOrNull(userStats.followers_count),
    usuario_followings: toIntegerOrNull(userStats.followings_count),
    usuario_ratings_sum: toIntegerOrNull(userStats.ratings_sum),
    usuario_seo_name: user.seo_name ?? null,
    usuario_is_premium: user.is_premium ?? null,
    usuario_idioma: user.language ?? null,
    review_likes: toIntegerOrNull(activityStats.likes_count),
    review_comments: toIntegerOrNull(activityStats.comments_count),
  };
}

async function upsertReview(client, r) {
  const sql = `
    INSERT INTO vivino_reviews (
      id, vinho_id, rating, nota_texto, idioma, usuario_id, usuario_nome, safra_avaliada, criado_em,
      usuario_total_ratings, usuario_total_reviews, usuario_followers, usuario_followings, usuario_ratings_sum,
      usuario_seo_name, usuario_is_premium, usuario_idioma, review_likes, review_comments
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,
      $10,$11,$12,$13,$14,$15,$16,$17,$18,$19
    )
    ON CONFLICT (id) DO UPDATE SET
      rating = COALESCE(EXCLUDED.rating, vivino_reviews.rating),
      nota_texto = COALESCE(EXCLUDED.nota_texto, vivino_reviews.nota_texto),
      idioma = COALESCE(EXCLUDED.idioma, vivino_reviews.idioma),
      usuario_nome = COALESCE(EXCLUDED.usuario_nome, vivino_reviews.usuario_nome),
      usuario_total_ratings = COALESCE(EXCLUDED.usuario_total_ratings, vivino_reviews.usuario_total_ratings),
      usuario_total_reviews = COALESCE(EXCLUDED.usuario_total_reviews, vivino_reviews.usuario_total_reviews),
      usuario_followers = COALESCE(EXCLUDED.usuario_followers, vivino_reviews.usuario_followers),
      usuario_followings = COALESCE(EXCLUDED.usuario_followings, vivino_reviews.usuario_followings),
      usuario_ratings_sum = COALESCE(EXCLUDED.usuario_ratings_sum, vivino_reviews.usuario_ratings_sum),
      usuario_seo_name = COALESCE(EXCLUDED.usuario_seo_name, vivino_reviews.usuario_seo_name),
      usuario_is_premium = COALESCE(EXCLUDED.usuario_is_premium, vivino_reviews.usuario_is_premium),
      usuario_idioma = COALESCE(EXCLUDED.usuario_idioma, vivino_reviews.usuario_idioma),
      review_likes = COALESCE(EXCLUDED.review_likes, vivino_reviews.review_likes),
      review_comments = COALESCE(EXCLUDED.review_comments, vivino_reviews.review_comments)
  `;

  const args = [
    r.id, r.vinho_id, r.rating, r.nota_texto, r.idioma, r.usuario_id, r.usuario_nome, r.safra_avaliada, r.criado_em,
    r.usuario_total_ratings, r.usuario_total_reviews, r.usuario_followers, r.usuario_followings, r.usuario_ratings_sum,
    r.usuario_seo_name, r.usuario_is_premium, r.usuario_idioma, r.review_likes, r.review_comments,
  ];

  await client.query(sql, args);
}

async function markWineDone(client, wineId, totalReviews) {
  await client.query(
    `UPDATE vivino_vinhos
     SET reviews_coletados = TRUE,
         total_reviews_db = $2,
         reviews_atualizado_em = NOW(),
         atualizado_em = NOW()
     WHERE id = $1`,
    [wineId, totalReviews],
  );
}

async function recalculateEstimatedRating(client, wineId) {
  const stats = await client.query(
    `SELECT
       COALESCE(
         SUM(
           rating::double precision
           * GREATEST(
             1.0,
             SQRT(GREATEST(COALESCE(usuario_total_ratings, 0), 0)::double precision)
           )
         ),
         0.0
       ) AS weighted_sum,
       COALESCE(
         SUM(
           GREATEST(
             1.0,
             SQRT(GREATEST(COALESCE(usuario_total_ratings, 0), 0)::double precision)
           )
         ),
         0.0
       ) AS weights
     FROM vivino_reviews
     WHERE vinho_id = $1
       AND rating IS NOT NULL`,
    [wineId],
  );

  const weightedSum = Number(stats.rows[0] && stats.rows[0].weighted_sum);
  const weights = Number(stats.rows[0] && stats.rows[0].weights);
  if (!Number.isFinite(weightedSum) || !Number.isFinite(weights) || weights <= 0) {
    return null;
  }

  const weightedAverage = weightedSum / weights;
  const estimated = (
    (weights / (weights + ESTIMATED_RATING_DUMMY_WEIGHT)) * weightedAverage
    + (ESTIMATED_RATING_DUMMY_WEIGHT / (weights + ESTIMATED_RATING_DUMMY_WEIGHT)) * ESTIMATED_RATING_GLOBAL_MEAN
  );
  const rounded = Math.round(estimated * 100) / 100;

  await client.query(
    `UPDATE vivino_vinhos
     SET nota_estimada = $2
     WHERE id = $1`,
    [wineId, rounded],
  );
  return rounded;
}

async function tryRecalculateEstimatedRating(client, wineId) {
  try {
    return await recalculateEstimatedRating(client, wineId);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    console.log(`[vivino-worker] erro nota_estimada wine=${wineId}: ${msg}`);
    pushWorkerEvent('warn', 'estimated_rating_error', 'Falha ao recalcular nota_estimada', {
      wineId: Number(wineId),
      message: msg,
    });
    return null;
  }
}

async function getPendingWineIds(pool, limit) {
  if (BROKER_ENABLED) {
    return getBrokerPendingWineIds(limit);
  }
  const sql = `
    SELECT id
    FROM vivino_vinhos
    WHERE reviews_coletados = FALSE
      AND total_ratings >= $1
    ORDER BY total_ratings DESC
    LIMIT $2
  `;
  const r = await pool.query(sql, [MIN_RATINGS, limit]);
  return r.rows.map((x) => x.id);
}

function markWineRetryLater(wineId) {
  retryLaterUntilByWine.set(Number(wineId), Date.now() + RETRY_WINE_COOLDOWN_MS);
}

function cleanupRetryLaterMap(nowMs) {
  for (const [wineId, until] of retryLaterUntilByWine.entries()) {
    if (until <= nowMs) retryLaterUntilByWine.delete(wineId);
  }
}

function buildBatchWithRetryCooldown(candidateIds, batchSize, nowMs) {
  const selected = [];
  let skipped = 0;

  for (const wineId of candidateIds) {
    const until = retryLaterUntilByWine.get(Number(wineId)) || 0;
    if (until > nowMs) {
      skipped += 1;
      continue;
    }
    selected.push(wineId);
    if (selected.length >= batchSize) break;
  }

  return { selected, skipped };
}

async function getPendingCount(pool) {
  if (BROKER_ENABLED) {
    const stats = await getBrokerGlobalProgressStats();
    return Number(stats.pendingEligible || 0);
  }
  const r = await pool.query(
    `SELECT COUNT(*)::bigint AS n
     FROM vivino_vinhos
     WHERE reviews_coletados = FALSE
       AND total_ratings >= $1`,
    [MIN_RATINGS],
  );
  return Number(r.rows[0].n || 0);
}

async function getGlobalProgressStats(pool) {
  if (BROKER_ENABLED) {
    return getBrokerGlobalProgressStats();
  }
  const vinhoStats = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE total_ratings >= $1)::bigint AS total_eligible,
       COUNT(*) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = TRUE)::bigint AS done_eligible,
       COUNT(*) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = FALSE)::bigint AS pending_eligible,
       COALESCE(SUM(total_reviews_db) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = TRUE), 0)::bigint AS done_reviews_sum
     FROM vivino_vinhos`,
    [MIN_RATINGS],
  );
  const reviewsStats = await pool.query(
    `SELECT COUNT(*)::bigint AS reviews_rows FROM vivino_reviews`,
  );

  const row = vinhoStats.rows[0] || {};
  const rowReviews = reviewsStats.rows[0] || {};
  return {
    totalEligible: Number(row.total_eligible || 0),
    doneEligible: Number(row.done_eligible || 0),
    pendingEligible: Number(row.pending_eligible || 0),
    doneReviewsDbSum: Number(row.done_reviews_sum || 0),
    totalReviewsRows: Number(rowReviews.reviews_rows || 0),
  };
}

function applyGlobalProgressStats(stats) {
  workerProgress.totalEligible = Number(stats.totalEligible || 0);
  workerProgress.doneEligible = Number(stats.doneEligible || 0);
  workerProgress.pendingEligible = Number(stats.pendingEligible || 0);
  workerProgress.totalReviewsRows = Number(stats.totalReviewsRows || 0);
  workerProgress.doneReviewsDbSum = Number(stats.doneReviewsDbSum || 0);
  workerProgress.sessionWinesDone = clampNonNegative(workerProgress.doneEligible - workerProgress.sessionBaseDoneEligible);
  workerProgress.sessionReviewsRowsDelta = clampNonNegative(workerProgress.totalReviewsRows - workerProgress.sessionBaseReviewsRows);
}

function buildProgressSnapshot(overrides = {}) {
  return {
    totalEligible: Number.isFinite(Number(overrides.totalEligible))
      ? Number(overrides.totalEligible)
      : Number(workerProgress.totalEligible || 0),
    doneEligible: Number.isFinite(Number(overrides.doneEligible))
      ? Number(overrides.doneEligible)
      : Number(workerProgress.doneEligible || 0),
    pendingEligible: Number.isFinite(Number(overrides.pendingEligible))
      ? Number(overrides.pendingEligible)
      : Number(workerProgress.pendingEligible || 0),
    totalReviewsRows: Number.isFinite(Number(overrides.totalReviewsRows))
      ? Number(overrides.totalReviewsRows)
      : Number(workerProgress.totalReviewsRows || 0),
    doneReviewsDbSum: Number.isFinite(Number(overrides.doneReviewsDbSum))
      ? Number(overrides.doneReviewsDbSum)
      : Number(workerProgress.doneReviewsDbSum || 0),
  };
}

async function refreshGlobalProgress(pool, options = {}) {
  const stage = String(options.stage || 'progress_refresh');
  const required = Boolean(options.required);
  try {
    const stats = await getGlobalProgressStats(pool);
    applyGlobalProgressStats(stats);
    return stats;
  } catch (err) {
    if (required) throw err;
    const msg = String(err && err.message ? err.message : err);
    const snapshot = buildProgressSnapshot(options.fallback || {});
    applyGlobalProgressStats(snapshot);
    workerProgress.updatedAt = Date.now();
    console.warn(`[vivino-worker] refresh de progresso falhou em ${stage}: ${msg}`);
    pushWorkerEvent('warn', stage, 'Falha ao atualizar progresso; usando snapshot local', {
      message: msg,
      fallback: snapshot,
    });
    return snapshot;
  }
}

function updateRatesAndEta() {
  const now = Date.now();
  const sessionElapsedSec = clampNonNegative((now - Number(workerProgress.startedAt || now)) / 1000);
  const batchElapsedSec = clampNonNegative((now - Number(workerProgress.currentBatch.startedAt || now)) / 1000);

  workerProgress.rates.globalWinesPerSec = sessionElapsedSec > 0
    ? workerProgress.sessionWinesDone / sessionElapsedSec
    : 0;
  workerProgress.rates.batchWinesPerSec = batchElapsedSec > 0
    ? workerProgress.currentBatch.processed / batchElapsedSec
    : 0;

  const etaByGlobal = workerProgress.rates.globalWinesPerSec > 0
    ? workerProgress.pendingEligible / workerProgress.rates.globalWinesPerSec
    : null;
  const etaByBatch = workerProgress.rates.batchWinesPerSec > 0
    ? workerProgress.pendingEligible / workerProgress.rates.batchWinesPerSec
    : null;

  workerProgress.etaSeconds = Number.isFinite(etaByGlobal) && etaByGlobal > 0
    ? etaByGlobal
    : etaByBatch;
}

function logProgressDashboard(extra = {}) {
  const pct = workerProgress.totalEligible > 0
    ? Math.floor((workerProgress.doneEligible / workerProgress.totalEligible) * 100)
    : 0;
  const batch = workerProgress.currentBatch;
  const batchPct = batch.target > 0
    ? Math.floor((batch.processed / batch.target) * 100)
    : 0;
  const batchEta = batch.target > batch.processed && workerProgress.rates.batchWinesPerSec > 0
    ? (batch.target - batch.processed) / workerProgress.rates.batchWinesPerSec
    : null;

  console.log('[vivino-worker] ======================================================================');
  console.log(
    `[vivino-worker] PROGRESSO - ${workerProgress.doneEligible.toLocaleString('pt-BR')} / ${workerProgress.totalEligible.toLocaleString('pt-BR')} (${pct}%)`,
  );
  console.log(
    `[vivino-worker]   Pendentes: ${workerProgress.pendingEligible.toLocaleString('pt-BR')} | RetryCooldown: ${retryLaterUntilByWine.size.toLocaleString('pt-BR')}`,
  );
  console.log(
    `[vivino-worker]   Reviews na base: ${workerProgress.totalReviewsRows.toLocaleString('pt-BR')} | Reviews acumuladas (sum): ${workerProgress.doneReviewsDbSum.toLocaleString('pt-BR')}`,
  );
  console.log(
    `[vivino-worker]   Sessao: +${workerProgress.sessionWinesDone.toLocaleString('pt-BR')} vinhos | +${workerProgress.sessionReviewsFetched.toLocaleString('pt-BR')} reviews_fetch`,
  );
  console.log(
    `[vivino-worker]   Lote atual: ${batch.processed}/${batch.target} (${batchPct}%) | OK=${batch.ok} | Retry=${batch.retryLater} | ETA lote=${formatDuration(batchEta)}`,
  );
  console.log(
    `[vivino-worker]   Velocidade: lote=${workerProgress.rates.batchWinesPerSec.toFixed(2)} vinhos/s | geral=${workerProgress.rates.globalWinesPerSec.toFixed(2)} vinhos/s | ETA total=${formatDuration(workerProgress.etaSeconds)}`,
  );
  if (extra && extra.message) {
    console.log(`[vivino-worker]   ${extra.message}`);
  }
  console.log('[vivino-worker] ======================================================================');
  pushWorkerEvent('info', extra.stage || 'dashboard', extra.message || 'dashboard atualizado', {
    phase: workerProgress.phase,
    cycle: workerProgress.cycle,
    totalEligible: workerProgress.totalEligible,
    doneEligible: workerProgress.doneEligible,
    pendingEligible: workerProgress.pendingEligible,
    batch: {
      target: batch.target,
      processed: batch.processed,
      ok: batch.ok,
      retryLater: batch.retryLater,
    },
    rates: {
      batchWinesPerSec: workerProgress.rates.batchWinesPerSec,
      globalWinesPerSec: workerProgress.rates.globalWinesPerSec,
    },
    etaSeconds: workerProgress.etaSeconds,
  });
}

function getVivinoWorkerProgress() {
  return {
    ...workerProgress,
    storageMode: STORAGE_MODE,
    broker: BROKER_ENABLED ? describeBrokerTarget() : null,
    database: describeDatabaseTarget(VIVINO_DATABASE_URL),
    retryCooldownCount: retryLaterUntilByWine.size,
    now: nowIso(),
  };
}

function toMetricNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function pctChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

function estimateEtaSeconds(pendingCount, completedInWindow, windowSeconds) {
  if (!Number.isFinite(pendingCount) || pendingCount <= 0) return 0;
  if (!Number.isFinite(completedInWindow) || completedInWindow <= 0) return null;
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return null;
  const rate = completedInWindow / windowSeconds;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return pendingCount / rate;
}

function clampIntRange(value, minValue, maxValue) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return minValue;
  return Math.max(minValue, Math.min(maxValue, n));
}

function getPoolConfig(maxConnections) {
  return {
    connectionString: VIVINO_DATABASE_URL,
    max: maxConnections,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  };
}

function getMetricsPool() {
  if (workerPool) return workerPool;
  if (metricsPool) return metricsPool;
  if (!VIVINO_DATABASE_URL) return null;
  metricsPool = new Pool(getPoolConfig(3));
  metricsPool.on('error', (err) => {
    const msg = String(err && err.message ? err.message : err);
    console.error('[vivino-worker] erro no metrics pool:', msg);
  });
  return metricsPool;
}

async function getVivinoWorkerMetrics(options = {}) {
  const hourlyHours = clampIntRange(
    options && options.hourlyHours != null ? options.hourlyHours : METRICS_HOURLY_HOURS,
    6,
    168,
  );
  const dailyDays = clampIntRange(
    options && options.dailyDays != null ? options.dailyDays : METRICS_DAILY_DAYS,
    7,
    120,
  );

  if (BROKER_ENABLED) {
    try {
      const brokerMetrics = await getBrokerMetricsSnapshot({ hourlyHours, dailyDays });
      const progress = getVivinoWorkerProgress();
      const winesPending = toMetricNumber(brokerMetrics?.base?.winesPendingTotal);
      const winesDone = toMetricNumber(brokerMetrics?.base?.winesDoneTotal);
      const lastHourWines = toMetricNumber(brokerMetrics?.throughput?.wines?.last1h);
      const last24hWines = toMetricNumber(brokerMetrics?.throughput?.wines?.last24h);
      const jobStartedAtMs = Number(progress?.startedAt || 0);
      const jobStartedAt = jobStartedAtMs > 0 ? toIsoOrNull(jobStartedAtMs) : null;
      const jobElapsedSeconds = jobStartedAtMs > 0
        ? clampNonNegative((Date.now() - jobStartedAtMs) / 1000)
        : 0;
      const jobDoneBefore = toMetricNumber(progress?.sessionBaseDoneEligible);
      const jobExtractedSession = toMetricNumber(progress?.sessionWinesDone);
      const jobExtractedThisJob = jobExtractedSession > 0
        ? jobExtractedSession
        : clampNonNegative(winesDone - jobDoneBefore);
      const jobTargetRaw = toMetricNumber(progress?.sessionBasePendingEligible);
      const jobTargetToExtract = jobTargetRaw > 0
        ? jobTargetRaw
        : clampNonNegative(jobExtractedThisJob + winesPending);
      const jobRemainingThisJob = Math.max(0, jobTargetToExtract - jobExtractedThisJob);
      const jobProgressPct = jobTargetToExtract > 0
        ? (jobExtractedThisJob / jobTargetToExtract) * 100
        : (jobRemainingThisJob <= 0 ? 100 : 0);
      const jobRatePerSecond = jobElapsedSeconds > 0
        ? (jobExtractedThisJob / jobElapsedSeconds)
        : 0;
      const jobEtaSeconds = jobRemainingThisJob > 0 && jobRatePerSecond > 0
        ? (jobRemainingThisJob / jobRatePerSecond)
        : (jobRemainingThisJob <= 0 ? 0 : null);
      const liveGlobalRate = Number(progress?.rates?.globalWinesPerSec || 0);
      const etaByLiveRateSeconds = liveGlobalRate > 0 ? (winesPending / liveGlobalRate) : null;
      const etaByLastHourSeconds = estimateEtaSeconds(winesPending, lastHourWines, 3600);
      const etaByLast24hSeconds = estimateEtaSeconds(winesPending, last24hWines, 86400);
      const etaBestSeconds = etaByLiveRateSeconds || etaByLastHourSeconds || etaByLast24hSeconds || null;

      return {
        ok: true,
        generatedAt: brokerMetrics.generatedAt || nowIso(),
        timezone: brokerMetrics.timezone || process.env.TZ || 'UTC',
        config: {
          minRatings: MIN_RATINGS,
          workers: WORKERS,
          batchSize: BATCH_SIZE,
          maxPages: MAX_PAGES,
          perPage: PER_PAGE,
          maxReviewsPerWine: MAX_REVIEWS_PER_WINE,
          hourlyHistoryHours: hourlyHours,
          dailyHistoryDays: dailyDays,
        },
        database: describeDatabaseTarget(VIVINO_DATABASE_URL),
        broker: describeBrokerTarget(),
        base: brokerMetrics.base || {},
        job: {
          started: Boolean(progress?.started),
          startedAt: jobStartedAt,
          elapsedSeconds: jobElapsedSeconds,
          elapsedHuman: formatDuration(jobElapsedSeconds),
          doneBeforeJob: jobDoneBefore,
          targetToExtract: jobTargetToExtract,
          extractedThisJob: jobExtractedThisJob,
          remainingThisJob: jobRemainingThisJob,
          progressPct: jobProgressPct,
          ratePerSecond: jobRatePerSecond,
          ratePerMinute: jobRatePerSecond * 60,
          ratePerHour: jobRatePerSecond * 3600,
          etaSeconds: jobEtaSeconds,
          etaHuman: formatDuration(jobEtaSeconds),
        },
        throughput: brokerMetrics.throughput || {},
        comparisons: brokerMetrics.comparisons || {},
        pending: brokerMetrics.pending || {
          count: winesPending,
          minRatings: 0,
          maxRatings: 0,
          avgRatings: 0,
          topPendingByRatings: [],
        },
        eta: {
          pendingWines: winesPending,
          byLiveRateSeconds: etaByLiveRateSeconds,
          byLastHourSeconds: etaByLastHourSeconds,
          byLast24hSeconds: etaByLast24hSeconds,
          bestSeconds: etaBestSeconds,
          byLiveRateHuman: formatDuration(etaByLiveRateSeconds),
          byLastHourHuman: formatDuration(etaByLastHourSeconds),
          byLast24hHuman: formatDuration(etaByLast24hSeconds),
          bestHuman: formatDuration(etaBestSeconds),
        },
        worker: {
          enabled: Boolean(progress.enabled),
          started: Boolean(progress.started),
          startedAt: progress.startedAt ? toIsoOrNull(progress.startedAt) : null,
          updatedAt: progress.updatedAt ? toIsoOrNull(progress.updatedAt) : null,
          phase: progress.phase || 'idle',
          cycle: toMetricNumber(progress.cycle),
          retryCooldownCount: toMetricNumber(progress.retryCooldownCount),
          rates: {
            batchWinesPerSec: toMetricNumber(progress?.rates?.batchWinesPerSec),
            globalWinesPerSec: toMetricNumber(progress?.rates?.globalWinesPerSec),
          },
          session: {
            winesDone: toMetricNumber(progress.sessionWinesDone),
            reviewsFetched: toMetricNumber(progress.sessionReviewsFetched),
            reviewsRowsDelta: toMetricNumber(progress.sessionReviewsRowsDelta),
            duplicatesEstimate: Math.max(
              0,
              toMetricNumber(progress.sessionReviewsFetched) - toMetricNumber(progress.sessionReviewsRowsDelta),
            ),
          },
          currentBatch: {
            target: toMetricNumber(progress?.currentBatch?.target),
            processed: toMetricNumber(progress?.currentBatch?.processed),
            ok: toMetricNumber(progress?.currentBatch?.ok),
            retryLater: toMetricNumber(progress?.currentBatch?.retryLater),
            pendingBefore: toMetricNumber(progress?.currentBatch?.pendingBefore),
            pendingAfter: toMetricNumber(progress?.currentBatch?.pendingAfter),
            startedAt: progress?.currentBatch?.startedAt ? toIsoOrNull(progress.currentBatch.startedAt) : null,
            updatedAt: progress?.currentBatch?.updatedAt ? toIsoOrNull(progress.currentBatch.updatedAt) : null,
          },
          lastError: progress.lastError || null,
        },
        history: brokerMetrics.history || { hourly: [], daily: [] },
        events: getVivinoWorkerEvents(200),
      };
    } catch (err) {
      return {
        ok: false,
        generatedAt: nowIso(),
        error: String(err && err.message ? err.message : err),
        database: describeDatabaseTarget(VIVINO_DATABASE_URL),
        broker: describeBrokerTarget(),
        worker: getVivinoWorkerProgress(),
        events: getVivinoWorkerEvents(200),
      };
    }
  }

  const pool = getMetricsPool();
  if (!pool) {
    const dbConfigError = getDatabaseConfigError();
    return {
      ok: false,
      generatedAt: nowIso(),
      error: dbConfigError || 'Banco Vivino nao configurado',
      database: describeDatabaseTarget(VIVINO_DATABASE_URL),
      broker: describeBrokerTarget(),
      worker: getVivinoWorkerProgress(),
      events: getVivinoWorkerEvents(200),
    };
  }

  const summarySql = `
    SELECT
      COUNT(*)::bigint AS wines_total,
      COUNT(*) FILTER (WHERE total_ratings >= $1)::bigint AS wines_eligible_total,
      COUNT(*) FILTER (WHERE total_ratings < $1)::bigint AS wines_ineligible_total,
      COUNT(*) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = TRUE)::bigint AS wines_done_total,
      COUNT(*) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = FALSE)::bigint AS wines_pending_total,
      COALESCE(SUM(total_reviews_db) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = TRUE), 0)::bigint AS reviews_sum_done,
      COUNT(*) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = TRUE AND reviews_atualizado_em >= NOW() - INTERVAL '5 minutes')::bigint AS wines_5m,
      COUNT(*) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = TRUE AND reviews_atualizado_em >= NOW() - INTERVAL '15 minutes')::bigint AS wines_15m,
      COUNT(*) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = TRUE AND reviews_atualizado_em >= NOW() - INTERVAL '1 hour')::bigint AS wines_1h,
      COUNT(*) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = TRUE AND reviews_atualizado_em >= NOW() - INTERVAL '6 hours')::bigint AS wines_6h,
      COUNT(*) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = TRUE AND reviews_atualizado_em >= NOW() - INTERVAL '24 hours')::bigint AS wines_24h,
      COUNT(*) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = TRUE AND reviews_atualizado_em >= NOW() - INTERVAL '7 days')::bigint AS wines_7d,
      COALESCE(SUM(total_reviews_db) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = TRUE AND reviews_atualizado_em >= NOW() - INTERVAL '5 minutes'), 0)::bigint AS reviews_5m,
      COALESCE(SUM(total_reviews_db) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = TRUE AND reviews_atualizado_em >= NOW() - INTERVAL '15 minutes'), 0)::bigint AS reviews_15m,
      COALESCE(SUM(total_reviews_db) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = TRUE AND reviews_atualizado_em >= NOW() - INTERVAL '1 hour'), 0)::bigint AS reviews_1h,
      COALESCE(SUM(total_reviews_db) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = TRUE AND reviews_atualizado_em >= NOW() - INTERVAL '6 hours'), 0)::bigint AS reviews_6h,
      COALESCE(SUM(total_reviews_db) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = TRUE AND reviews_atualizado_em >= NOW() - INTERVAL '24 hours'), 0)::bigint AS reviews_24h,
      COALESCE(SUM(total_reviews_db) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = TRUE AND reviews_atualizado_em >= NOW() - INTERVAL '7 days'), 0)::bigint AS reviews_7d,
      COUNT(*) FILTER (
        WHERE total_ratings >= $1
          AND reviews_coletados = TRUE
          AND reviews_atualizado_em >= date_trunc('hour', NOW())
          AND reviews_atualizado_em < date_trunc('hour', NOW()) + INTERVAL '1 hour'
      )::bigint AS wines_current_hour,
      COUNT(*) FILTER (
        WHERE total_ratings >= $1
          AND reviews_coletados = TRUE
          AND reviews_atualizado_em >= date_trunc('hour', NOW()) - INTERVAL '1 hour'
          AND reviews_atualizado_em < date_trunc('hour', NOW())
      )::bigint AS wines_previous_hour,
      COALESCE(SUM(total_reviews_db) FILTER (
        WHERE total_ratings >= $1
          AND reviews_coletados = TRUE
          AND reviews_atualizado_em >= date_trunc('hour', NOW())
          AND reviews_atualizado_em < date_trunc('hour', NOW()) + INTERVAL '1 hour'
      ), 0)::bigint AS reviews_current_hour,
      COALESCE(SUM(total_reviews_db) FILTER (
        WHERE total_ratings >= $1
          AND reviews_coletados = TRUE
          AND reviews_atualizado_em >= date_trunc('hour', NOW()) - INTERVAL '1 hour'
          AND reviews_atualizado_em < date_trunc('hour', NOW())
      ), 0)::bigint AS reviews_previous_hour,
      COUNT(*) FILTER (
        WHERE total_ratings >= $1
          AND reviews_coletados = TRUE
          AND reviews_atualizado_em >= date_trunc('day', NOW())
          AND reviews_atualizado_em < date_trunc('day', NOW()) + INTERVAL '1 day'
      )::bigint AS wines_current_day,
      COUNT(*) FILTER (
        WHERE total_ratings >= $1
          AND reviews_coletados = TRUE
          AND reviews_atualizado_em >= date_trunc('day', NOW()) - INTERVAL '1 day'
          AND reviews_atualizado_em < date_trunc('day', NOW())
      )::bigint AS wines_previous_day,
      COALESCE(SUM(total_reviews_db) FILTER (
        WHERE total_ratings >= $1
          AND reviews_coletados = TRUE
          AND reviews_atualizado_em >= date_trunc('day', NOW())
          AND reviews_atualizado_em < date_trunc('day', NOW()) + INTERVAL '1 day'
      ), 0)::bigint AS reviews_current_day,
      COALESCE(SUM(total_reviews_db) FILTER (
        WHERE total_ratings >= $1
          AND reviews_coletados = TRUE
          AND reviews_atualizado_em >= date_trunc('day', NOW()) - INTERVAL '1 day'
          AND reviews_atualizado_em < date_trunc('day', NOW())
      ), 0)::bigint AS reviews_previous_day,
      MIN(reviews_atualizado_em) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = TRUE) AS first_done_at,
      MAX(reviews_atualizado_em) FILTER (WHERE total_ratings >= $1 AND reviews_coletados = TRUE) AS last_done_at
    FROM vivino_vinhos
  `;

  const reviewsRowsSql = `SELECT COUNT(*)::bigint AS reviews_rows_total FROM vivino_reviews`;

  const pendingStatsSql = `
    SELECT
      COUNT(*)::bigint AS pending_count,
      COALESCE(MIN(total_ratings), 0)::bigint AS pending_min_ratings,
      COALESCE(MAX(total_ratings), 0)::bigint AS pending_max_ratings,
      COALESCE(AVG(total_ratings), 0)::numeric(20,4) AS pending_avg_ratings
    FROM vivino_vinhos
    WHERE total_ratings >= $1
      AND reviews_coletados = FALSE
  `;

  const topPendingSql = `
    SELECT id, total_ratings, total_reviews_db
    FROM vivino_vinhos
    WHERE total_ratings >= $1
      AND reviews_coletados = FALSE
    ORDER BY total_ratings DESC, id DESC
    LIMIT 10
  `;

  const hourlyHistorySql = `
    WITH bounds AS (
      SELECT
        date_trunc('hour', NOW()) AS hour_end,
        date_trunc('hour', NOW()) - (($1::int - 1) * INTERVAL '1 hour') AS hour_start
    ),
    series AS (
      SELECT generate_series(bounds.hour_start, bounds.hour_end, INTERVAL '1 hour') AS bucket
      FROM bounds
    ),
    agg AS (
      SELECT
        date_trunc('hour', reviews_atualizado_em) AS bucket,
        COUNT(*)::bigint AS wines_done,
        COALESCE(SUM(total_reviews_db), 0)::bigint AS reviews_sum
      FROM vivino_vinhos, bounds
      WHERE total_ratings >= $2
        AND reviews_coletados = TRUE
        AND reviews_atualizado_em >= bounds.hour_start
        AND reviews_atualizado_em < bounds.hour_end + INTERVAL '1 hour'
      GROUP BY 1
    )
    SELECT
      series.bucket,
      COALESCE(agg.wines_done, 0)::bigint AS wines_done,
      COALESCE(agg.reviews_sum, 0)::bigint AS reviews_sum
    FROM series
    LEFT JOIN agg ON agg.bucket = series.bucket
    ORDER BY series.bucket ASC
  `;

  const dailyHistorySql = `
    WITH bounds AS (
      SELECT
        date_trunc('day', NOW()) AS day_end,
        date_trunc('day', NOW()) - (($1::int - 1) * INTERVAL '1 day') AS day_start
    ),
    series AS (
      SELECT generate_series(bounds.day_start, bounds.day_end, INTERVAL '1 day') AS bucket
      FROM bounds
    ),
    agg AS (
      SELECT
        date_trunc('day', reviews_atualizado_em) AS bucket,
        COUNT(*)::bigint AS wines_done,
        COALESCE(SUM(total_reviews_db), 0)::bigint AS reviews_sum
      FROM vivino_vinhos, bounds
      WHERE total_ratings >= $2
        AND reviews_coletados = TRUE
        AND reviews_atualizado_em >= bounds.day_start
        AND reviews_atualizado_em < bounds.day_end + INTERVAL '1 day'
      GROUP BY 1
    )
    SELECT
      series.bucket,
      COALESCE(agg.wines_done, 0)::bigint AS wines_done,
      COALESCE(agg.reviews_sum, 0)::bigint AS reviews_sum
    FROM series
    LEFT JOIN agg ON agg.bucket = series.bucket
    ORDER BY series.bucket ASC
  `;

  const [summaryResult, reviewsRowsResult, pendingStatsResult, topPendingResult, hourlyHistoryResult, dailyHistoryResult] = await Promise.all([
    pool.query(summarySql, [MIN_RATINGS]),
    pool.query(reviewsRowsSql),
    pool.query(pendingStatsSql, [MIN_RATINGS]),
    pool.query(topPendingSql, [MIN_RATINGS]),
    pool.query(hourlyHistorySql, [hourlyHours, MIN_RATINGS]),
    pool.query(dailyHistorySql, [dailyDays, MIN_RATINGS]),
  ]);

  const summary = summaryResult.rows[0] || {};
  const reviewsRows = reviewsRowsResult.rows[0] || {};
  const pendingStats = pendingStatsResult.rows[0] || {};
  const progress = getVivinoWorkerProgress();

  const winesPending = toMetricNumber(summary.wines_pending_total);
  const winesDone = toMetricNumber(summary.wines_done_total);
  const reviewsRowsTotal = toMetricNumber(reviewsRows.reviews_rows_total);
  const reviewsSumDone = toMetricNumber(summary.reviews_sum_done);
  const avgReviewsPerDoneWine = winesDone > 0 ? (reviewsSumDone / winesDone) : 0;

  const winesCurrentHour = toMetricNumber(summary.wines_current_hour);
  const winesPreviousHour = toMetricNumber(summary.wines_previous_hour);
  const winesCurrentDay = toMetricNumber(summary.wines_current_day);
  const winesPreviousDay = toMetricNumber(summary.wines_previous_day);
  const reviewsCurrentHour = toMetricNumber(summary.reviews_current_hour);
  const reviewsPreviousHour = toMetricNumber(summary.reviews_previous_hour);
  const reviewsCurrentDay = toMetricNumber(summary.reviews_current_day);
  const reviewsPreviousDay = toMetricNumber(summary.reviews_previous_day);

  const liveGlobalRate = Number(progress && progress.rates ? progress.rates.globalWinesPerSec : 0);
  const etaByLiveRateSeconds = liveGlobalRate > 0 ? (winesPending / liveGlobalRate) : null;
  const etaByLastHourSeconds = estimateEtaSeconds(winesPending, toMetricNumber(summary.wines_1h), 3600);
  const etaByLast24hSeconds = estimateEtaSeconds(winesPending, toMetricNumber(summary.wines_24h), 86400);
  const etaBestSeconds = etaByLiveRateSeconds || etaByLastHourSeconds || etaByLast24hSeconds || null;

  const hourlyHistory = hourlyHistoryResult.rows.map((row) => ({
    bucketStart: toIsoOrNull(row.bucket),
    winesDone: toMetricNumber(row.wines_done),
    reviewsSum: toMetricNumber(row.reviews_sum),
  }));

  const dailyHistory = dailyHistoryResult.rows.map((row) => ({
    bucketStart: toIsoOrNull(row.bucket),
    winesDone: toMetricNumber(row.wines_done),
    reviewsSum: toMetricNumber(row.reviews_sum),
  }));

  const topPending = topPendingResult.rows.map((row) => ({
    id: toMetricNumber(row.id),
    totalRatings: toMetricNumber(row.total_ratings),
    totalReviewsDb: toMetricNumber(row.total_reviews_db),
  }));

  const jobStartedAtMs = Number(progress?.startedAt || 0);
  const jobStartedAt = jobStartedAtMs > 0 ? toIsoOrNull(jobStartedAtMs) : null;
  const jobElapsedSeconds = jobStartedAtMs > 0
    ? clampNonNegative((Date.now() - jobStartedAtMs) / 1000)
    : 0;
  const jobDoneBefore = toMetricNumber(progress?.sessionBaseDoneEligible);
  const jobExtractedSession = toMetricNumber(progress?.sessionWinesDone);
  const jobExtractedThisJob = jobExtractedSession > 0
    ? jobExtractedSession
    : clampNonNegative(winesDone - jobDoneBefore);
  const jobTargetRaw = toMetricNumber(progress?.sessionBasePendingEligible);
  const jobTargetToExtract = jobTargetRaw > 0
    ? jobTargetRaw
    : clampNonNegative(jobExtractedThisJob + winesPending);
  const jobRemainingThisJob = Math.max(0, jobTargetToExtract - jobExtractedThisJob);
  const jobProgressPct = jobTargetToExtract > 0
    ? (jobExtractedThisJob / jobTargetToExtract) * 100
    : (jobRemainingThisJob <= 0 ? 100 : 0);
  const jobRatePerSecond = jobElapsedSeconds > 0
    ? (jobExtractedThisJob / jobElapsedSeconds)
    : 0;
  const jobRatePerMinute = jobRatePerSecond * 60;
  const jobRatePerHour = jobRatePerSecond * 3600;
  const jobEtaSeconds = jobRemainingThisJob > 0 && jobRatePerSecond > 0
    ? (jobRemainingThisJob / jobRatePerSecond)
    : (jobRemainingThisJob <= 0 ? 0 : null);

  return {
    ok: true,
    generatedAt: nowIso(),
    timezone: process.env.TZ || 'UTC',
    config: {
      minRatings: MIN_RATINGS,
      workers: WORKERS,
      batchSize: BATCH_SIZE,
      maxPages: MAX_PAGES,
      perPage: PER_PAGE,
      maxReviewsPerWine: MAX_REVIEWS_PER_WINE,
      hourlyHistoryHours: hourlyHours,
      dailyHistoryDays: dailyDays,
    },
    database: describeDatabaseTarget(VIVINO_DATABASE_URL),
    base: {
      winesTotal: toMetricNumber(summary.wines_total),
      winesEligibleTotal: toMetricNumber(summary.wines_eligible_total),
      winesIneligibleTotal: toMetricNumber(summary.wines_ineligible_total),
      winesDoneTotal: winesDone,
      winesPendingTotal: winesPending,
      progressPct: toMetricNumber(summary.wines_eligible_total) > 0
        ? (winesDone / toMetricNumber(summary.wines_eligible_total)) * 100
        : 0,
      reviewsRowsTotal,
      reviewsSumDoneWines: reviewsSumDone,
      avgReviewsPerDoneWine,
      reviewsRowsVsSumPct: reviewsSumDone > 0 ? (reviewsRowsTotal / reviewsSumDone) * 100 : null,
      firstDoneAt: toIsoOrNull(summary.first_done_at),
      lastDoneAt: toIsoOrNull(summary.last_done_at),
    },
    job: {
      started: Boolean(progress?.started),
      startedAt: jobStartedAt,
      elapsedSeconds: jobElapsedSeconds,
      elapsedHuman: formatDuration(jobElapsedSeconds),
      doneBeforeJob: jobDoneBefore,
      targetToExtract: jobTargetToExtract,
      extractedThisJob: jobExtractedThisJob,
      remainingThisJob: jobRemainingThisJob,
      progressPct: jobProgressPct,
      ratePerSecond: jobRatePerSecond,
      ratePerMinute: jobRatePerMinute,
      ratePerHour: jobRatePerHour,
      etaSeconds: jobEtaSeconds,
      etaHuman: formatDuration(jobEtaSeconds),
    },
    throughput: {
      wines: {
        last5m: toMetricNumber(summary.wines_5m),
        last15m: toMetricNumber(summary.wines_15m),
        last1h: toMetricNumber(summary.wines_1h),
        last6h: toMetricNumber(summary.wines_6h),
        last24h: toMetricNumber(summary.wines_24h),
        last7d: toMetricNumber(summary.wines_7d),
        avgPerHour24h: toMetricNumber(summary.wines_24h) / 24,
        avgPerDay7d: toMetricNumber(summary.wines_7d) / 7,
      },
      reviewsSum: {
        last5m: toMetricNumber(summary.reviews_5m),
        last15m: toMetricNumber(summary.reviews_15m),
        last1h: toMetricNumber(summary.reviews_1h),
        last6h: toMetricNumber(summary.reviews_6h),
        last24h: toMetricNumber(summary.reviews_24h),
        last7d: toMetricNumber(summary.reviews_7d),
        avgPerHour24h: toMetricNumber(summary.reviews_24h) / 24,
        avgPerDay7d: toMetricNumber(summary.reviews_7d) / 7,
      },
    },
    comparisons: {
      hour: {
        current: { winesDone: winesCurrentHour, reviewsSum: reviewsCurrentHour },
        previous: { winesDone: winesPreviousHour, reviewsSum: reviewsPreviousHour },
        delta: {
          winesAbs: winesCurrentHour - winesPreviousHour,
          winesPct: pctChange(winesCurrentHour, winesPreviousHour),
          reviewsAbs: reviewsCurrentHour - reviewsPreviousHour,
          reviewsPct: pctChange(reviewsCurrentHour, reviewsPreviousHour),
        },
      },
      day: {
        current: { winesDone: winesCurrentDay, reviewsSum: reviewsCurrentDay },
        previous: { winesDone: winesPreviousDay, reviewsSum: reviewsPreviousDay },
        delta: {
          winesAbs: winesCurrentDay - winesPreviousDay,
          winesPct: pctChange(winesCurrentDay, winesPreviousDay),
          reviewsAbs: reviewsCurrentDay - reviewsPreviousDay,
          reviewsPct: pctChange(reviewsCurrentDay, reviewsPreviousDay),
        },
      },
    },
    pending: {
      count: toMetricNumber(pendingStats.pending_count),
      minRatings: toMetricNumber(pendingStats.pending_min_ratings),
      maxRatings: toMetricNumber(pendingStats.pending_max_ratings),
      avgRatings: toMetricNumber(pendingStats.pending_avg_ratings),
      topPendingByRatings: topPending,
    },
    eta: {
      pendingWines: winesPending,
      byLiveRateSeconds: etaByLiveRateSeconds,
      byLastHourSeconds: etaByLastHourSeconds,
      byLast24hSeconds: etaByLast24hSeconds,
      bestSeconds: etaBestSeconds,
      byLiveRateHuman: formatDuration(etaByLiveRateSeconds),
      byLastHourHuman: formatDuration(etaByLastHourSeconds),
      byLast24hHuman: formatDuration(etaByLast24hSeconds),
      bestHuman: formatDuration(etaBestSeconds),
    },
    worker: {
      enabled: Boolean(progress.enabled),
      started: Boolean(progress.started),
      startedAt: progress.startedAt ? toIsoOrNull(progress.startedAt) : null,
      updatedAt: progress.updatedAt ? toIsoOrNull(progress.updatedAt) : null,
      phase: progress.phase || 'idle',
      cycle: toMetricNumber(progress.cycle),
      retryCooldownCount: toMetricNumber(progress.retryCooldownCount),
      rates: {
        batchWinesPerSec: toMetricNumber(progress?.rates?.batchWinesPerSec),
        globalWinesPerSec: toMetricNumber(progress?.rates?.globalWinesPerSec),
      },
      session: {
        winesDone: toMetricNumber(progress.sessionWinesDone),
        reviewsFetched: toMetricNumber(progress.sessionReviewsFetched),
        reviewsRowsDelta: toMetricNumber(progress.sessionReviewsRowsDelta),
        duplicatesEstimate: Math.max(
          0,
          toMetricNumber(progress.sessionReviewsFetched) - toMetricNumber(progress.sessionReviewsRowsDelta),
        ),
      },
      currentBatch: {
        target: toMetricNumber(progress?.currentBatch?.target),
        processed: toMetricNumber(progress?.currentBatch?.processed),
        ok: toMetricNumber(progress?.currentBatch?.ok),
        retryLater: toMetricNumber(progress?.currentBatch?.retryLater),
        pendingBefore: toMetricNumber(progress?.currentBatch?.pendingBefore),
        pendingAfter: toMetricNumber(progress?.currentBatch?.pendingAfter),
        startedAt: progress?.currentBatch?.startedAt ? toIsoOrNull(progress.currentBatch.startedAt) : null,
        updatedAt: progress?.currentBatch?.updatedAt ? toIsoOrNull(progress.currentBatch.updatedAt) : null,
      },
      lastError: progress.lastError || null,
    },
    history: {
      hourly: hourlyHistory,
      daily: dailyHistory,
    },
    events: getVivinoWorkerEvents(200),
  };
}

async function collectWine(pool, wineId) {
  const client = pool ? await pool.connect() : null;
  const brokerReviews = [];
  try {
    let total = 0;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = `${VIVINO_BASE_URL}/api/wines/${wineId}/reviews?per_page=${PER_PAGE}&page=${page}`;
      const result = await fetchJsonWithRetry(url);

      if (!result.ok) {
        // Erro transitorio: nao marcar como coletado, tenta em lote futuro.
        if (result.transient) {
          return { ok: false, retryLater: true, wineId, total };
        }
        // Erro permanente: marcar como coletado com o que ja temos.
        if (BROKER_ENABLED) {
          const persisted = await brokerPersistCollectedWine(wineId, total, brokerReviews);
          return { ok: true, done: true, wineId, total, status: result.status, estimatedRating: persisted.estimatedRating ?? null };
        }
        await markWineDone(client, wineId, total);
        const estimatedRating = await tryRecalculateEstimatedRating(client, wineId);
        return { ok: true, done: true, wineId, total, status: result.status, estimatedRating };
      }

      const items = (result.data && Array.isArray(result.data.reviews)) ? result.data.reviews : [];
      if (!items.length) break;

      if (BROKER_ENABLED) {
        for (const item of items) {
          if (!item || !item.id) continue;
          brokerReviews.push(parseReview(item, wineId));
        }
      } else {
        await client.query('BEGIN');
        for (const item of items) {
          if (!item || !item.id) continue;
          const parsed = parseReview(item, wineId);
          await upsertReview(client, parsed);
        }
        await client.query('COMMIT');
      }

      total += items.length;
      if (items.length < PER_PAGE) break;
      if (SLEEP_PER_WINE_MS > 0) await sleep(SLEEP_PER_WINE_MS);
    }

    if (BROKER_ENABLED) {
      const persisted = await brokerPersistCollectedWine(wineId, total, brokerReviews);
      return { ok: true, done: true, wineId, total, estimatedRating: persisted.estimatedRating ?? null };
    }

    await markWineDone(client, wineId, total);
    const estimatedRating = await tryRecalculateEstimatedRating(client, wineId);
    return { ok: true, done: true, wineId, total, estimatedRating };
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    const msg = String(err && err.message ? err.message : err);
    return { ok: false, retryLater: true, wineId, error: msg };
  } finally {
    if (client) {
      client.release();
    }
  }
}

async function runWithConcurrency(items, concurrency, handler) {
  const queue = items.slice();
  const workers = [];
  for (let i = 0; i < concurrency; i += 1) {
    workers.push((async () => {
      while (queue.length) {
        const next = queue.shift();
        if (next == null) break;
        await handler(next);
      }
    })());
  }
  await Promise.all(workers);
}

async function loop(pool) {
  let cycle = 0;
  while (true) {
    cycle += 1;
    workerProgress.cycle = cycle;
    workerProgress.phase = 'cycle_start';
    workerProgress.updatedAt = Date.now();
    pushWorkerEvent('info', 'cycle_start', `Iniciando ciclo ${cycle}`);

    const globalBefore = await refreshGlobalProgress(pool, {
      stage: 'cycle_start_stats',
      required: false,
    });
    updateRatesAndEta();

    const pendingBefore = globalBefore.pendingEligible;
    if (pendingBefore <= 0) {
      workerProgress.phase = 'idle_waiting';
      workerProgress.currentBatch = {
        target: 0,
        processed: 0,
        ok: 0,
        retryLater: 0,
        pendingBefore: 0,
        pendingAfter: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
      logProgressDashboard({ stage: 'idle_waiting', message: `Sem pendencias. pausa de ${Math.floor(SLEEP_WHEN_EMPTY_MS / 1000)}s.` });
      await sleep(SLEEP_WHEN_EMPTY_MS);
      continue;
    }

    cleanupRetryLaterMap(Date.now());

    const candidateLimit = Math.max(BATCH_SIZE, BATCH_SIZE * Math.max(1, RETRY_SELECTION_MULTIPLIER));
    let candidateIds = [];
    try {
      candidateIds = await getPendingWineIds(pool, candidateLimit);
    } catch (err) {
      if (!BROKER_ENABLED) throw err;
      const msg = String(err && err.message ? err.message : err);
      workerProgress.phase = 'broker_recovery_wait';
      workerProgress.updatedAt = Date.now();
      console.warn(`[vivino-worker] falha buscando candidatos no broker: ${msg}`);
      pushWorkerEvent('warn', 'candidate_fetch', 'Falha buscando candidatos no broker; aguardando para tentar novamente', {
        message: msg,
        candidateLimit,
        sleepMs: BROKER_RECOVERY_SLEEP_MS,
      });
      await sleep(BROKER_RECOVERY_SLEEP_MS);
      continue;
    }
    if (!candidateIds.length) {
      workerProgress.phase = 'idle_no_candidates';
      workerProgress.currentBatch = {
        target: 0,
        processed: 0,
        ok: 0,
        retryLater: 0,
        pendingBefore,
        pendingAfter: pendingBefore,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
      logProgressDashboard({ stage: 'idle_no_candidates', message: `Sem IDs no lote. pausa de ${Math.floor(SLEEP_WHEN_EMPTY_MS / 1000)}s.` });
      await sleep(SLEEP_WHEN_EMPTY_MS);
      continue;
    }

    const { selected: ids, skipped: skippedByCooldown } = buildBatchWithRetryCooldown(
      candidateIds,
      BATCH_SIZE,
      Date.now(),
    );

    if (!ids.length) {
      workerProgress.phase = 'cooldown_waiting';
      workerProgress.currentBatch = {
        target: 0,
        processed: 0,
        ok: 0,
        retryLater: 0,
        pendingBefore,
        pendingAfter: pendingBefore,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
      logProgressDashboard({
        stage: 'cooldown_waiting',
        message: `Todos candidatos em cooldown (candidatos=${candidateIds.length} cooldown=${skippedByCooldown}). aguardando ${Math.floor(SLEEP_BETWEEN_BATCH_MS / 1000)}s.`,
      });
      await sleep(SLEEP_BETWEEN_BATCH_MS);
      continue;
    }

    let okWines = 0;
    let retryLater = 0;
    let totalReviews = 0;
    let processed = 0;
    let lastProgressLogAt = Date.now();
    let lastProgressProcessed = 0;

    workerProgress.phase = 'batch_running';
    workerProgress.currentBatch = {
      target: ids.length,
      processed: 0,
      ok: 0,
      retryLater: 0,
      pendingBefore,
      pendingAfter: pendingBefore,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    workerProgress.updatedAt = Date.now();
    updateRatesAndEta();
    logProgressDashboard({
      stage: 'batch_start',
      message: `Lote ${cycle} iniciado | pendentes=${pendingBefore} | candidatos=${candidateIds.length} | cooldown=${skippedByCooldown}`,
    });

    await runWithConcurrency(ids, WORKERS, async (wineId) => {
      const res = await collectWine(pool, wineId);
      if (res.ok) {
        okWines += 1;
        totalReviews += Number(res.total || 0);
        pushWorkerEvent('info', 'wine_done', 'Vinho coletado', {
          wineId: Number(wineId),
          reviewsFetched: Number(res.total || 0),
          processed: processed + 1,
          target: ids.length,
        });
      } else if (res.retryLater) {
        retryLater += 1;
        markWineRetryLater(wineId);
        pushWorkerEvent('warn', 'wine_retry_later', 'Vinho reagendado para retry', {
          wineId: Number(wineId),
          processed: processed + 1,
          target: ids.length,
          error: res.error || null,
        });
      }

      processed += 1;
      workerProgress.currentBatch.processed = processed;
      workerProgress.currentBatch.ok = okWines;
      workerProgress.currentBatch.retryLater = retryLater;
      workerProgress.currentBatch.updatedAt = Date.now();
      workerProgress.sessionReviewsFetched += Number(res.total || 0);
      workerProgress.updatedAt = Date.now();
      updateRatesAndEta();

      const reachedStep = (processed - lastProgressProcessed) >= Math.max(1, PROGRESS_LOG_EVERY);
      const reachedTime = (Date.now() - lastProgressLogAt) >= Math.max(1000, PROGRESS_LOG_INTERVAL_MS);
      const finishedBatch = processed >= ids.length;
      if (reachedStep || reachedTime || finishedBatch) {
        const batchRemaining = Math.max(0, ids.length - processed);
        const batchEta = workerProgress.rates.batchWinesPerSec > 0
          ? (batchRemaining / workerProgress.rates.batchWinesPerSec)
          : null;
        console.log(
          `[vivino-worker] Progresso: ${processed}/${ids.length} | OK: ${okWines} | Retry: ${retryLater} | ${workerProgress.rates.batchWinesPerSec.toFixed(2)} vinhos/s | ETA lote: ${formatDuration(batchEta)} | ETA total: ${formatDuration(workerProgress.etaSeconds)}`,
        );
        pushWorkerEvent('info', 'batch_progress', 'Progresso do lote', {
          processed,
          target: ids.length,
          ok: okWines,
          retryLater,
          batchWinesPerSec: workerProgress.rates.batchWinesPerSec,
          etaBatchSeconds: batchEta,
          etaTotalSeconds: workerProgress.etaSeconds,
        });
        lastProgressLogAt = Date.now();
        lastProgressProcessed = processed;
      }
    });

    const globalAfter = await refreshGlobalProgress(pool, {
      stage: 'batch_done_stats',
      required: false,
      fallback: {
        totalEligible: workerProgress.totalEligible,
        doneEligible: workerProgress.doneEligible + okWines,
        pendingEligible: Math.max(0, pendingBefore - okWines),
      },
    });
    workerProgress.currentBatch.pendingAfter = globalAfter.pendingEligible;
    workerProgress.currentBatch.updatedAt = Date.now();
    workerProgress.phase = 'batch_done';
    workerProgress.updatedAt = Date.now();
    updateRatesAndEta();

    console.log(
      `[vivino-worker] ciclo=${cycle} ok_wines=${okWines} retry_later=${retryLater} reviews_lote=${totalReviews} pendentes_apos=${globalAfter.pendingEligible}`,
    );
    logProgressDashboard({ stage: 'batch_done', message: `Pausa de ${Math.floor(SLEEP_BETWEEN_BATCH_MS / 1000)}s entre lotes...` });
    await sleep(SLEEP_BETWEEN_BATCH_MS);
  }
}

async function startVivinoReviewsWorker() {
  if (started) return;
  started = true;
  workerProgress.enabled = WORKER_ENABLED;
  workerProgress.started = true;
  workerProgress.startedAt = Date.now();
  workerProgress.updatedAt = Date.now();
  workerProgress.phase = 'booting';
  workerProgress.lastError = null;
  pushWorkerEvent('info', 'boot', 'Vivino worker boot');

  if (!WORKER_ENABLED) {
    console.log('[vivino-worker] desabilitado via VIVINO_REVIEWS_WORKER_ENABLED=false');
    workerProgress.phase = 'disabled';
    workerProgress.updatedAt = Date.now();
    pushWorkerEvent('warn', 'disabled', 'Worker desabilitado via env');
    return;
  }

  const dbConfigError = getDatabaseConfigError();
  if (dbConfigError) {
    workerProgress.phase = 'error';
    workerProgress.lastError = dbConfigError || 'Banco Vivino nao configurado';
    workerProgress.updatedAt = Date.now();
    pushWorkerEvent('error', 'config_error', workerProgress.lastError, {
      database: describeDatabaseTarget(VIVINO_DATABASE_URL),
      broker: describeBrokerTarget(),
    });
    console.log(`[vivino-worker] ${workerProgress.lastError}. worker nao iniciado.`);
    return;
  }
  const pool = BROKER_ENABLED ? null : new Pool({
    connectionString: VIVINO_DATABASE_URL,
    max: Math.max(2, WORKERS + 2),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });
  workerPool = pool;

  if (pool) {
    pool.on('error', (err) => {
      const msg = String(err && err.message ? err.message : err);
      console.error('[vivino-worker] erro no pool:', msg);
      workerProgress.lastError = msg;
      workerProgress.updatedAt = Date.now();
      pushWorkerEvent('error', 'pool_error', 'Erro no pool PG', { message: msg });
    });
  }

  setupProxyIfEnabled();
  if (STEEL_ENABLED) {
    console.log(`[vivino-worker] Steel.dev fallback ${STEEL_API_KEY ? 'habilitado' : 'configurado sem API key'}`);
  }
  if (!BROKER_ENABLED && DATABASE_SOURCE === 'DATABASE_URL') {
    console.log('[vivino-worker] usando fallback DATABASE_URL. configure VIVINO_DATABASE_URL para evitar gravar na base errada.');
    pushWorkerEvent('warn', 'database_fallback', 'Usando fallback DATABASE_URL', {
      database: describeDatabaseTarget(VIVINO_DATABASE_URL),
    });
  }
  if (BROKER_ENABLED) {
    console.log(`[vivino-worker] broker HTTP ativo em ${BROKER_BASE_URL}`);
    pushWorkerEvent('info', 'broker_enabled', 'Broker HTTP ativo', {
      broker: describeBrokerTarget(),
    });
  }
  console.log(
    `[vivino-worker] iniciado | mode=${STORAGE_MODE} ${BROKER_ENABLED ? `broker=${BROKER_BASE_URL}` : `db_source=${DATABASE_SOURCE}`} workers=${WORKERS} batch=${BATCH_SIZE} min_ratings=${MIN_RATINGS} max_pages=${MAX_PAGES} per_page=${PER_PAGE} max_reviews_per_wine=${MAX_REVIEWS_PER_WINE} retry_cooldown_ms=${RETRY_WINE_COOLDOWN_MS} retry_multiplier=${RETRY_SELECTION_MULTIPLIER}`,
  );
  try {
    const initial = await refreshGlobalProgress(pool, {
      stage: 'boot_stats',
      required: true,
    });
    workerProgress.sessionBaseDoneEligible = initial.doneEligible;
    workerProgress.sessionBasePendingEligible = initial.pendingEligible;
    workerProgress.sessionBaseReviewsRows = initial.totalReviewsRows;
    workerProgress.sessionWinesDone = 0;
    workerProgress.sessionReviewsFetched = 0;
    workerProgress.sessionReviewsRowsDelta = 0;
    workerProgress.currentBatch = {
      target: 0,
      processed: 0,
      ok: 0,
      retryLater: 0,
      pendingBefore: initial.pendingEligible,
      pendingAfter: initial.pendingEligible,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    workerProgress.phase = 'ready';
    workerProgress.updatedAt = Date.now();
    updateRatesAndEta();
    logProgressDashboard({ stage: 'ready', message: 'Worker iniciado e monitoramento ativo.' });

    await loop(pool);
  } catch (err) {
    const msg = String(err && err.stack ? err.stack : (err && err.message ? err.message : err));
    workerProgress.phase = 'fatal_error';
    workerProgress.lastError = msg;
    workerProgress.updatedAt = Date.now();
    console.error('[vivino-worker] loop finalizado por erro fatal:', msg);
    pushWorkerEvent('error', 'fatal_error', 'Loop finalizado por erro fatal', { message: msg });
  }
}

module.exports = {
  startVivinoReviewsWorker,
  getVivinoWorkerProgress,
  getVivinoWorkerMetrics,
  getVivinoWorkerEvents,
};

