const { Pool } = require('pg');
const { ProxyAgent } = require('undici');

const VIVINO_BASE_URL = process.env.VIVINO_BASE_URL || 'https://www.vivino.com';
const VIVINO_DATABASE_URL = process.env.VIVINO_DATABASE_URL || process.env.DATABASE_URL || '';
const WORKER_ENABLED = String(process.env.VIVINO_REVIEWS_WORKER_ENABLED || 'true') === 'true';
const WORKERS = Number(process.env.VIVINO_REVIEWS_WORKERS || 5);
const BATCH_SIZE = Number(process.env.VIVINO_REVIEWS_BATCH_SIZE || 500);
const MIN_RATINGS = Number(process.env.VIVINO_REVIEWS_MIN_RATINGS || 0);
const MAX_PAGES = Number(process.env.VIVINO_REVIEWS_MAX_PAGES || 2);
const PER_PAGE = Number(process.env.VIVINO_REVIEWS_PER_PAGE || 50);
const MAX_RETRIES = Number(process.env.VIVINO_REVIEWS_MAX_RETRIES || 5);
const REQUEST_TIMEOUT_MS = Number(process.env.VIVINO_REVIEWS_REQUEST_TIMEOUT_MS || 30000);
const SLEEP_BETWEEN_BATCH_MS = Number(process.env.VIVINO_REVIEWS_SLEEP_BETWEEN_BATCH_MS || 5000);
const SLEEP_WHEN_EMPTY_MS = Number(process.env.VIVINO_REVIEWS_SLEEP_WHEN_EMPTY_MS || 120000);
const SLEEP_PER_WINE_MS = Number(process.env.VIVINO_REVIEWS_SLEEP_PER_WINE_MS || 150);
const RETRY_429_MS = Number(process.env.VIVINO_REVIEWS_RETRY_429_MS || 30000);
const RETRY_503_MS = Number(process.env.VIVINO_REVIEWS_RETRY_503_MS || 15000);
const PROXY_ENABLED = String(
  process.env.VIVINO_PROXY_ENABLED ?? process.env.PROXY_ENABLED ?? 'false',
).trim().toLowerCase() === 'true';
const PROXY_URL = process.env.VIVINO_PROXY_URL || process.env.PROXY_URL || '';
const PROXY_HOST = process.env.VIVINO_PROXY_HOST || process.env.PROXY_HOST || '';
const PROXY_PORT = process.env.VIVINO_PROXY_PORT || process.env.PROXY_PORT || '';
const PROXY_USER = process.env.VIVINO_PROXY_USER || process.env.PROXY_USER || '';
const PROXY_PASS = process.env.VIVINO_PROXY_PASS || process.env.PROXY_PASS || '';
const STEEL_ENABLED = String(process.env.VIVINO_STEEL_ENABLED || 'false').trim().toLowerCase() === 'true';
const STEEL_API_KEY = process.env.VIVINO_STEEL_API_KEY || process.env.STEEL_API_KEY || '';
const STEEL_WS_ENDPOINT = process.env.VIVINO_STEEL_WS_ENDPOINT || 'wss://connect.steel.dev';
const STEEL_TIMEOUT_MS = Number(process.env.VIVINO_STEEL_TIMEOUT_MS || 45000);
const STEEL_MAX_REQUESTS_PER_SESSION = Number(process.env.VIVINO_STEEL_MAX_REQUESTS_PER_SESSION || 25);

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function setupProxyIfEnabled() {
  console.log(`[vivino-worker] proxy_enabled=${PROXY_ENABLED}`);
  if (!PROXY_ENABLED) return;

  let proxy = PROXY_URL;
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
    console.log('[vivino-worker] VIVINO_PROXY_ENABLED=true, mas proxy não configurado. seguindo sem proxy.');
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

      // Erros permanentes, não insistir.
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
      return { ok: false, transient: true, status };
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      console.log(`[vivino-worker] erro Steel.dev em ${url}: ${msg}`);
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
    id: item.id,
    vinho_id: wineId,
    rating: item.rating ?? null,
    nota_texto: (item.note || '').replace(/\x00/g, ''),
    idioma: (item.language || '').replace(/\x00/g, ''),
    usuario_id: user.id ?? null,
    usuario_nome: ((user.alias || user.seo_name || '') || '').replace(/\x00/g, ''),
    safra_avaliada: vintageYear,
    criado_em: createdAt,
    usuario_total_ratings: userStats.ratings_count ?? null,
    usuario_total_reviews: userStats.reviews_count ?? null,
    usuario_followers: userStats.followers_count ?? null,
    usuario_followings: userStats.followings_count ?? null,
    usuario_ratings_sum: userStats.ratings_sum ?? null,
    usuario_seo_name: user.seo_name ?? null,
    usuario_is_premium: user.is_premium ?? null,
    usuario_idioma: user.language ?? null,
    review_likes: activityStats.likes_count ?? null,
    review_comments: activityStats.comments_count ?? null,
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

async function getPendingWineIds(pool, limit) {
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

async function getPendingCount(pool) {
  const r = await pool.query(
    `SELECT COUNT(*)::bigint AS n
     FROM vivino_vinhos
     WHERE reviews_coletados = FALSE
       AND total_ratings >= $1`,
    [MIN_RATINGS],
  );
  return Number(r.rows[0].n || 0);
}

async function collectWine(pool, wineId) {
  const client = await pool.connect();
  try {
    let total = 0;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = `${VIVINO_BASE_URL}/api/wines/${wineId}/reviews?per_page=${PER_PAGE}&page=${page}`;
      const result = await fetchJsonWithRetry(url);

      if (!result.ok) {
        // Erro transitório: não marcar como coletado, tenta em lote futuro.
        if (result.transient) {
          return { ok: false, retryLater: true, wineId, total };
        }
        // Erro permanente: marcar como coletado com o que já temos.
        await markWineDone(client, wineId, total);
        return { ok: true, done: true, wineId, total, status: result.status };
      }

      const items = (result.data && Array.isArray(result.data.reviews)) ? result.data.reviews : [];
      if (!items.length) break;

      await client.query('BEGIN');
      for (const item of items) {
        if (!item || !item.id) continue;
        const parsed = parseReview(item, wineId);
        await upsertReview(client, parsed);
      }
      await client.query('COMMIT');

      total += items.length;
      if (items.length < PER_PAGE) break;
      if (SLEEP_PER_WINE_MS > 0) await sleep(SLEEP_PER_WINE_MS);
    }

    await markWineDone(client, wineId, total);
    return { ok: true, done: true, wineId, total };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    const msg = String(err && err.message ? err.message : err);
    return { ok: false, retryLater: true, wineId, error: msg };
  } finally {
    client.release();
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

    const pendingBefore = await getPendingCount(pool);
    if (pendingBefore <= 0) {
      console.log(`[vivino-worker] ${nowIso()} sem pendências. dormindo ${SLEEP_WHEN_EMPTY_MS}ms`);
      await sleep(SLEEP_WHEN_EMPTY_MS);
      continue;
    }

    const ids = await getPendingWineIds(pool, BATCH_SIZE);
    if (!ids.length) {
      console.log(`[vivino-worker] ${nowIso()} sem IDs no lote. dormindo ${SLEEP_WHEN_EMPTY_MS}ms`);
      await sleep(SLEEP_WHEN_EMPTY_MS);
      continue;
    }

    let okWines = 0;
    let retryLater = 0;
    let totalReviews = 0;

    console.log(`[vivino-worker] ciclo=${cycle} pendentes=${pendingBefore} lote=${ids.length} workers=${WORKERS}`);

    await runWithConcurrency(ids, WORKERS, async (wineId) => {
      const res = await collectWine(pool, wineId);
      if (res.ok) {
        okWines += 1;
        totalReviews += Number(res.total || 0);
      } else if (res.retryLater) {
        retryLater += 1;
      }
    });

    const pendingAfter = await getPendingCount(pool);
    console.log(`[vivino-worker] ciclo=${cycle} ok_wines=${okWines} retry_later=${retryLater} reviews_lote=${totalReviews} pendentes_apos=${pendingAfter}`);
    await sleep(SLEEP_BETWEEN_BATCH_MS);
  }
}

async function startVivinoReviewsWorker() {
  if (started) return;
  started = true;

  if (!WORKER_ENABLED) {
    console.log('[vivino-worker] desabilitado via VIVINO_REVIEWS_WORKER_ENABLED=false');
    return;
  }

  if (!VIVINO_DATABASE_URL) {
    console.log('[vivino-worker] VIVINO_DATABASE_URL/DATABASE_URL ausente. worker não iniciado.');
    return;
  }

  const pool = new Pool({
    connectionString: VIVINO_DATABASE_URL,
    max: Math.max(2, WORKERS + 2),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });

  pool.on('error', (err) => {
    console.error('[vivino-worker] erro no pool:', err && err.message ? err.message : err);
  });

  setupProxyIfEnabled();
  if (STEEL_ENABLED) {
    console.log(`[vivino-worker] Steel.dev fallback ${STEEL_API_KEY ? 'habilitado' : 'configurado sem API key'}`);
  }
  console.log(`[vivino-worker] iniciado | workers=${WORKERS} batch=${BATCH_SIZE} min_ratings=${MIN_RATINGS} max_pages=${MAX_PAGES}`);

  try {
    await loop(pool);
  } catch (err) {
    console.error('[vivino-worker] loop finalizado por erro fatal:', err && err.stack ? err.stack : err);
  }
}

module.exports = { startVivinoReviewsWorker };
