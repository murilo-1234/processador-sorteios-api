/**
 * Serviço B (bots): multi-números só com bot do ChatGPT.
 * Mantém “sessão forte”, QR visível e administração simples.
 * Página: /admin → status + QR + Conectar + Limpar sessão (por número)
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');

// Reuso do seu código existente
const WhatsAppClient = require('../whatsapp-automation/src/services/whatsapp-client');
let attachAssistant = null;
try {
  ({ attachAssistant } = require('../whatsapp-automation/src/modules/assistant-bot'));
} catch {}

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ || 'America/Sao_Paulo';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS || '';
const ASSISTANT_ENABLED = String(process.env.ASSISTANT_ENABLED || '1') === '1';
const WA_SESSION_BASE = process.env.WA_SESSION_BASE || './data/baileys-bots';

// Lista de números (somente os que serão “só-bot”)
const WA_INSTANCE_IDS = String(process.env.WA_INSTANCE_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!WA_INSTANCE_IDS.length) {
  console.error('Defina WA_INSTANCE_IDS com os números que serão conectados (ex: 4891167973,4891784533)');
  process.exit(1);
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
const instances = new Map(); // id -> { id, client, sessPath }
const qrStore = new Map();   // id -> último QR recebido

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

async function spawnInstance(id) {
  const sessPath = path.join(WA_SESSION_BASE, id.replace(/\D/g, ''));
  ensureDir(sessPath);

  const client = new WhatsAppClient();
  client.sessionPath = sessPath;

  // CAPTURA DE QR do Baileys para servir em /qr/:id
  try {
    // fallback genérico: alguns wrappers emitem 'qr' e/ou 'connection.update'
    if (typeof client.on === 'function') {
      client.on('qr', (qr) => qrStore.set(id, qr));
      client.on('connection.update', (u) => {
        if (u?.qr) qrStore.set(id, u.qr);
        if (u?.connection === 'open') qrStore.delete(id);
      });
    }
  } catch {}

  // inicializa; ele já tenta reconectar quando cair
  await client.initialize().catch(() => {});

  // Baileys v6 direto (se exposto)
  try {
    if (client.sock?.ev?.on) {
      client.sock.ev.on('connection.update', (u) => {
        if (u?.qr) qrStore.set(id, u.qr);
        if (u?.connection === 'open') qrStore.delete(id);
      });
    }
  } catch {}

  // anexa atendente (mesmas regras do 1whatsapp)
  if (attachAssistant && ASSISTANT_ENABLED) {
    try { attachAssistant({ whatsappClient: client }); } catch {}
  }

  const ref = { id, client, sessPath };
  instances.set(id, ref);
  return ref;
}

// cria todas as instâncias na subida
(async () => {
  ensureDir(WA_SESSION_BASE);
  for (const id of WA_INSTANCE_IDS) {
    await spawnInstance(id);
  }
})().catch(err => {
  console.error('Falha ao subir instâncias:', err?.message || err);
  process.exit(1);
});

// ---------- App web ----------
const app = express();
app.use(express.json());

// Health público para o Render
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    tz: TZ,
    instances: Array.from(instances.keys()),
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
      connected: !!st.isConnected,
      user: st.user || null,
      retry: st.currentRetry || 0,
      sessionPath: x.sessPath,
      qrCached: qrStore.has(x.id),
    };
  });
  res.json({ ok: true, at: now, instances: list });
});

// QR em SVG a partir do cache + tentativa de reacender emissão
app.get('/qr/:id', async (req, res) => {
  const id = req.params.id;
  const it = instances.get(id);
  if (!it) return res.status(404).send('instância não encontrada');

  // provoca novo ciclo de QR se não houver um em cache
  if (!qrStore.get(id)) {
    try { await it.client.initialize().catch(()=>{}); } catch {}
  }

  const qr = qrStore.get(id);
  if (!qr) return res.status(404).send('QR ainda não disponível');
  try {
    const svg = await QRCode.toString(qr, { type: 'svg', margin: 1, width: 256 });
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.send(svg);
  } catch (e) {
    return res.status(500).send(String(e?.message || e));
  }
});

// conectar: limpa sessão e inicia para garantir QR novo
app.post('/api/:id/connect', basicAuth, async (req, res) => {
  const it = instances.get(req.params.id);
  if (!it) return res.status(404).json({ ok: false, error: 'instância não encontrada' });
  try {
    qrStore.delete(it.id);
    await it.client.clearSession?.().catch(()=>{});
    await it.client.initialize();
    return res.json({ ok: true, hint: `Abra /qr/${it.id} para escanear` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// limpar sessão (logout “hard”) e reabrir para já gerar novo QR
app.post('/api/:id/clear', basicAuth, async (req, res) => {
  const it = instances.get(req.params.id);
  if (!it) return res.status(404).json({ ok: false, error: 'instância não encontrada' });
  try {
    qrStore.delete(it.id);
    await it.client.clearSession?.();
    await it.client.initialize().catch(()=>{});
    return res.json({ ok: true, message: 'Sessão limpa. Gere o novo QR em /qr/' + it.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
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
      out.push(`
        <div class="card">
          <div class="head">
            <div class="id"># ${it.id}</div>
            <div class="badge ${st.isConnected ? 'ok' : 'down'}">${st.isConnected ? 'Conectado' : 'Desconectado'}</div>
          </div>
          <div class="meta">Sessão: ${it.sessPath}</div>
          <div class="meta">User: ${user || '—'}</div>
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

  res.send(`<!DOCTYPE html><html lang="pt-br"><head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>WA Bots – Multi</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;background:#0b1020;color:#e6e9ef;margin:0;padding:24px}
    h1{font-size:20px;margin:0 0 16px}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
    .card{background:#121a2a;border:1px solid #22304a;border-radius:12px;padding:16px}
    .head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
    .id{font-weight:600}
    .badge{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid #334766}
    .badge.ok{color:#c2ffd2;border-color:#2f7b43;background:#16301c}
    .badge.down{color:#ffd1d1;border-color:#7b2f2f;background:#301616}
    .meta{font-size:12px;color:#99a3b5;margin:4px 0}
    .actions{display:flex;gap:8px;margin-top:12px}
    button,.qr{appearance:none;border:1px solid #334766;background:#1a2438;color:#e6e9ef;padding:8px 12px;border-radius:8px;cursor:pointer;text-decoration:none}
    button:hover,.qr:hover{background:#22304a}
    .danger{border-color:#7b2f2f}
  </style>
  <script>
    async function doPost(url){
      const r = await fetch(url,{method:'POST'});
      const j = await r.json().catch(()=>({}));
      alert(JSON.stringify(j,null,2));
      location.reload();
    }
    setInterval(()=>location.reload(), 15000);
  </script>
  </head><body>
    <h1>WhatsApp Bots – Multi-instância</h1>
    <div class="grid">
      ${rows}
    </div>
  </body></html>`);
});

app.listen(PORT, () => {
  console.log(`[bots] online on :${PORT} TZ=${TZ} instances=${WA_INSTANCE_IDS.join(',')}`);
});
