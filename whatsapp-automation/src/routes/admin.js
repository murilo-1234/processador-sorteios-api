import express from 'express';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import { CONFIG } from '../config.js';
import { listGroups } from '../db/sqlite.js';

const router = express.Router();
router.use(cookieParser());

function requireAuth(req, res, next) {
  const token = req.cookies?.adm || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.redirect('/admin/login');
  try { 
    jwt.verify(token, CONFIG.admin.jwtSecret); 
    next(); 
  } catch { 
    return res.redirect('/admin/login'); 
  }
}

router.get('/admin/login', (req, res) => {
  res.send(`<!doctype html><meta charset="utf-8" />
<title>Login</title>
<style>body{font-family:ui-sans-serif;max-width:480px;margin:40px auto}
input{display:block;width:100%;margin:8px 0;padding:10px}button{padding:10px 14px}</style>
<h2>Login Admin</h2>
<form method="post" action="/admin/login">
  <input name="username" placeholder="Usuário" />
  <input name="password" type="password" placeholder="Senha" />
  <button>Entrar</button>
</form>`);
});

router.post('/admin/login', express.urlencoded({ extended: true }), (req, res) => {
  const { username, password } = req.body;
  if (username === CONFIG.admin.username && password === CONFIG.admin.password) {
    const token = jwt.sign({ u: username }, CONFIG.admin.jwtSecret, { expiresIn: '7d' });
    res.cookie('adm', token, { httpOnly: true, sameSite: 'lax' });
    return res.redirect('/admin');
  }
  res.status(401).send('Credenciais inválidas');
});

router.get('/admin', requireAuth, (req, res) => {
  res.send(generatePrivateDashboardHTML());
});

router.get('/admin/public', (req, res) => {
  res.send(generatePublicDashboardHTML());
});

function generatePrivateDashboardHTML() {
  return baseHtml({ title: 'Dashboard (Privado)', isPublic: false });
}

function generatePublicDashboardHTML() {
  return baseHtml({ title: 'Dashboard Público', isPublic: true });
}

function baseHtml({ title, isPublic }) {
  return `<!doctype html><meta charset="utf-8" />
<title>WhatsApp Automation</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 20px; }
  h1 { color: #1a202c; margin-bottom: 30px; }
  h1 small { color: #718096; font-weight: normal; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px; }
  .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-left: 8px; }
  .dot.green { background: #48bb78; }
  .dot.red { background: #f56565; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 20px; margin-bottom: 30px; }
  .kpi { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); text-align: center; }
  .kpi div { font-size: 2rem; font-weight: bold; color: #2d3748; }
  .kpi small { color: #718096; }
  .actions { margin-bottom: 30px; }
  .actions button { background: #4299e1; color: white; border: none; padding: 12px 20px; border-radius: 6px; margin-right: 10px; margin-bottom: 10px; cursor: pointer; }
  .actions button:hover { background: #3182ce; }
  .alert { padding: 12px; border-radius: 6px; margin-bottom: 20px; }
  .alert.success { background: #c6f6d5; color: #22543d; }
  .alert.error { background: #fed7d7; color: #742a2a; }
  .alert.info { background: #bee3f8; color: #2a4365; }
  .tbl { width: 100%; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .tbl th, .tbl td { padding: 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
  .tbl th { background: #f7fafc; font-weight: 600; }
  .tbl code { background: #edf2f7; padding: 2px 4px; border-radius: 3px; font-size: 0.875rem; }
  #loading { text-align: center; padding: 40px; color: #718096; }
</style>

<div class="wrap">
  <h1>WhatsApp Automation <small>${title}</small></h1>
  
  <section class="cards">
    <div class="card" id="waCard">🤖 WhatsApp <span id="waDot" class="dot red"></span> <small id="waText">Verificando…</small></div>
    <div class="card">🕵️ Monitoramento <small>Verificando…</small></div>
    <div class="card">🗄️ Banco de Dados <small>Verificando…</small></div>
    <div class="card">🧠 Memória <small>Verificando…</small></div>
  </section>
  
  <section class="kpis">
    <div class="kpi"><div id="kpiGrupos">0</div><small>Grupos</small></div>
    <div class="kpi"><div id="kpiAtivos">0</div><small>Ativos</small></div>
    <div class="kpi"><div id="kpiUlt">--</div><small>Último Sync</small></div>
  </section>
  
  <section class="actions">
    <button onclick="sincronizarGrupos()">🔄 Sincronizar Grupos</button>
    <button onclick="testarConexao()">🧪 Testar WhatsApp</button>
    <button onclick="atualizarStatus()">📊 Atualizar Status</button>
    <button onclick="processarSorteios()">🎯 Processar Sorteios</button>
  </section>
  
  <div id="alerts"></div>
  
  <section>
    <h3>Grupos WhatsApp</h3>
    <div id="loading">Carregando grupos…</div>
    <table id="tbl" class="tbl" style="display:none">
      <thead><tr><th>Nome</th><th>JID</th><th>Ativo</th><th>Sorteios</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </section>
</div>

<script>
let grupos = [];
let lastSync = null;

document.addEventListener('DOMContentLoaded', () => {
  atualizarStatus();
  carregarGrupos();
  setInterval(atualizarStatus, 30000);
});

function showAlert(msg, type='info') {
  const el = document.getElementById('alerts');
  el.innerHTML = '<div class="alert '+type+'">'+msg+'</div>';
  setTimeout(() => el.innerHTML='', 4000);
}

function setLoading(b) { 
  document.getElementById('loading').style.display = b ? 'block':'none'; 
  document.getElementById('tbl').style.display = b ? 'none':'table'; 
}

async function atualizarStatus() {
  try {
    const r = await fetch('/health');
    const d = await r.json();
    const ok = d?.checks?.whatsapp?.connected;
    document.getElementById('waDot').className = 'dot '+ (ok?'green':'red');
    document.getElementById('waText').innerText = ok ? 'Conectado' : 'Desconectado';
  } catch(e) { 
    console.error(e); 
  }
}

async function carregarGrupos() {
  try {
    setLoading(true);
    console.log('🔄 Carregando grupos...');
    const r = await fetch('/api/grupos');
    const data = await r.json();
    grupos = data || [];
    console.log('✅ Grupos carregados:', grupos.length);
    renderizarGrupos();
  } catch(e) { 
    console.error('❌ Erro ao carregar grupos:', e); 
    showAlert('Erro ao carregar grupos','error'); 
  } finally { 
    setLoading(false); 
  }
}

function renderizarGrupos() {
  const tb = document.getElementById('tbody');
  tb.innerHTML = '';
  
  for(const g of grupos) {
    const tr = document.createElement('tr');
    tr.innerHTML = \`
      <td>\${g.name || ''}</td>
      <td><code>\${g.jid}</code></td>
      <td><input type="checkbox" \${g.enabled? 'checked':''} onchange="toggleGrupo('\${g.jid}','enabled',this.checked)" /></td>
      <td><input type="checkbox" \${g.ativo_sorteios? 'checked':''} onchange="toggleGrupo('\${g.jid}','ativo_sorteios',this.checked)" /></td>
    \`;
    tb.appendChild(tr);
  }
  
  document.getElementById('kpiGrupos').innerText = grupos.length;
  document.getElementById('kpiAtivos').innerText = grupos.filter(g=>g.enabled||g.ativo_sorteios).length;
  document.getElementById('kpiUlt').innerText = lastSync || '--';
}

async function sincronizarGrupos() {
  try {
    setLoading(true);
    console.log('🔄 Sincronizando grupos...');
    const r = await fetch('/api/grupos/sincronizar', { method:'POST' });
    const d = await r.json();
    
    if(!r.ok) { 
      showAlert(d.error||'Falha ao sincronizar','error'); 
      return; 
    }
    
    lastSync = new Date().toLocaleString();
    showAlert('Sincronizado: '+d.count+' grupos','success');
    await carregarGrupos();
  } catch(e) { 
    console.error('❌ Erro ao sincronizar:', e); 
    showAlert('Erro ao sincronizar','error'); 
  } finally { 
    setLoading(false); 
  }
}

async function toggleGrupo(jid, field, value) {
  try {
    console.log('🔄 Toggle grupo:', jid, field, value);
    const r = await fetch('/api/grupos/'+encodeURIComponent(jid)+'/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field, value })
    });
    
    const d = await r.json();
    if(!r.ok) { 
      showAlert(d.error||'Erro ao alterar grupo','error'); 
      return; 
    }
    
    showAlert('Grupo alterado com sucesso','success');
    await carregarGrupos();
  } catch(e) { 
    console.error('❌ Erro toggle:', e); 
    showAlert('Erro ao alterar grupo','error'); 
  }
}

async function testarConexao() {
  try {
    const r = await fetch('/api/whatsapp/status');
    const d = await r.json();
    showAlert('WhatsApp: ' + (d.isConnected ? 'Conectado' : 'Desconectado'), d.isConnected ? 'success' : 'error');
  } catch(e) {
    showAlert('Erro ao testar conexão','error');
  }
}

async function processarSorteios() {
  try {
    showAlert('Processando sorteios...', 'info');
    const r = await fetch('/api/sorteios/processar', { method: 'POST' });
    const d = await r.json();
    
    if(!r.ok) { 
      showAlert(d.error||'Erro ao processar','error'); 
      return; 
    }
    
    showAlert(d.message || 'Sorteios processados','success');
  } catch(e) {
    console.error('❌ Erro processar:', e);
    showAlert('Erro ao processar sorteios','error');
  }
}
</script>`;
}

export default router;

