const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const database = require('../config/database');
const logger = require('../config/logger');
const SorteiosModule = require('../modules/sorteios');

const router = express.Router();

// Middleware de autenticação
const authenticateAdmin = async (req, res, next) => {
  try {
    const token = req.session.adminToken || req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      // Se for requisição AJAX, retornar JSON
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ error: 'Token de acesso necessário' });
      }
      // Se for navegador, redirecionar para login
      return res.redirect('/admin/login');
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'whatsapp-automation-secret');
    
    // Verificar se token não expirou
    if (decoded.exp && Date.now() >= decoded.exp * 1000) {
      req.session.destroy();
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ error: 'Sessão expirada' });
      }
      return res.redirect('/admin/login');
    }
    
    req.admin = decoded;
    next();
    
  } catch (error) {
    logger.error('❌ Erro na autenticação admin:', error);
    req.session.destroy();
    
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ error: 'Token inválido' });
    }
    return res.redirect('/admin/login');
  }
};

// Página de login
router.get('/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Login - WhatsApp Automation</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .login-container {
                background: white;
                padding: 2rem;
                border-radius: 10px;
                box-shadow: 0 10px 25px rgba(0,0,0,0.1);
                width: 100%;
                max-width: 400px;
            }
            .logo {
                text-align: center;
                margin-bottom: 2rem;
                color: #333;
            }
            .form-group {
                margin-bottom: 1rem;
            }
            label {
                display: block;
                margin-bottom: 0.5rem;
                color: #555;
                font-weight: 500;
            }
            input {
                width: 100%;
                padding: 0.75rem;
                border: 2px solid #e1e5e9;
                border-radius: 5px;
                font-size: 1rem;
                transition: border-color 0.3s;
            }
            input:focus {
                outline: none;
                border-color: #667eea;
            }
            .btn {
                width: 100%;
                padding: 0.75rem;
                background: #667eea;
                color: white;
                border: none;
                border-radius: 5px;
                font-size: 1rem;
                cursor: pointer;
                transition: background 0.3s;
            }
            .btn:hover {
                background: #5a6fd8;
            }
            .error {
                color: #e74c3c;
                margin-top: 0.5rem;
                font-size: 0.9rem;
            }
        </style>
    </head>
    <body>
        <div class="login-container">
            <div class="logo">
                <h1>🤖 WhatsApp Automation</h1>
                <p>Painel Administrativo</p>
            </div>
            <form id="loginForm">
                <div class="form-group">
                    <label for="username">Usuário:</label>
                    <input type="text" id="username" name="username" required placeholder="Digite seu usuário">
                </div>
                <div class="form-group">
                    <label for="password">Senha:</label>
                    <input type="password" id="password" name="password" required placeholder="Digite sua senha">
                </div>
                <button type="submit" class="btn">Entrar</button>
                <div id="error" class="error"></div>
            </form>
        </div>

        <script>
            document.getElementById('loginForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                
                const username = document.getElementById('username').value;
                const password = document.getElementById('password').value;
                const errorDiv = document.getElementById('error');
                
                try {
                    const response = await fetch('/admin/auth/login', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ username, password })
                    });
                    
                    const data = await response.json();
                    
                    if (response.ok) {
                        window.location.href = '/admin/dashboard';
                    } else {
                        errorDiv.textContent = data.error || 'Usuário ou senha incorretos';
                    }
                } catch (error) {
                    errorDiv.textContent = 'Erro de conexão';
                }
            });
        </script>
    </body>
    </html>
  `);
});

// Autenticação
router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Credenciais padrão
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    
    // Validar usuário e senha
    if (username !== adminUsername || password !== adminPassword) {
      logger.audit('admin_login_failed', `Tentativa de login falhada: ${username}`, username, req.ip);
      return res.status(401).json({ error: 'Usuário ou senha incorretos' });
    }
    
    // Gerar token JWT
    const token = jwt.sign(
      { 
        admin: true, 
        username: username,
        timestamp: Date.now() 
      },
      process.env.JWT_SECRET || 'whatsapp-automation-secret',
      { expiresIn: '24h' }
    );
    
    // Salvar token na sessão
    req.session.adminToken = token;
    
    logger.audit('admin_login_success', `Login realizado com sucesso: ${username}`, username, req.ip);
    
    res.json({ 
      success: true, 
      token,
      username: username,
      message: 'Login realizado com sucesso'
    });
    
  } catch (error) {
    logger.error('❌ Erro no login admin:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Logout
router.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Dashboard principal
router.get('/dashboard', authenticateAdmin, async (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    const jobScheduler = req.app.locals.jobScheduler;
    
    const whatsappStatus = whatsappClient?.getConnectionStatus() || {};
    const jobsStatus = jobScheduler?.getJobsStatus() || {};
    
    res.send(await generateDashboardHTML(whatsappStatus, jobsStatus));
  } catch (error) {
    logger.error('❌ Erro ao carregar dashboard:', error);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

// API: Status do sistema
router.get('/api/status', authenticateAdmin, async (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    const jobScheduler = req.app.locals.jobScheduler;
    const sorteiosModule = new SorteiosModule();
    
    const status = {
      whatsapp: whatsappClient?.getConnectionStatus() || {},
      jobs: jobScheduler?.getJobsStatus() || {},
      sorteios: await sorteiosModule.obterEstatisticas(),
      timestamp: new Date().toISOString()
    };
    
    res.json(status);
  } catch (error) {
    logger.error('❌ Erro ao obter status:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Grupos WhatsApp
router.get('/api/grupos', authenticateAdmin, async (req, res) => {
  try {
    const db = await database.getConnection();
    const grupos = await db.all(`
      SELECT jid, nome, ativo_sorteios, enabled, created_at 
      FROM grupos_whatsapp 
      ORDER BY nome
    `);
    
    res.json(grupos);
  } catch (error) {
    logger.error('❌ Erro ao obter grupos:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Atualizar grupo
router.put('/api/grupos/:jid', authenticateAdmin, async (req, res) => {
  try {
    const { jid } = req.params;
    const { ativo_sorteios, enabled } = req.body;
    
    const db = await database.getConnection();
    await db.run(`
      UPDATE grupos_whatsapp 
      SET ativo_sorteios = ?, enabled = ?
      WHERE jid = ?
    `, [ativo_sorteios ? 1 : 0, enabled ? 1 : 0, jid]);
    
    logger.audit('grupo_updated', `Grupo ${jid} atualizado`, 'admin', req.ip);
    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Erro ao atualizar grupo:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Sincronizar grupos do WhatsApp
router.post('/api/grupos/sync', authenticateAdmin, async (req, res) => {
  try {
    const whatsappClient = req.app.locals.whatsappClient;
    
    if (!whatsappClient || !whatsappClient.isConnected) {
      return res.status(400).json({ error: 'WhatsApp não está conectado' });
    }
    
    const grupos = await whatsappClient.getGroups();
    const db = await database.getConnection();
    
    let novosGrupos = 0;
    
    for (const grupo of grupos) {
      const existe = await db.get('SELECT jid FROM grupos_whatsapp WHERE jid = ?', [grupo.jid]);
      
      if (!existe) {
        await db.run(`
          INSERT INTO grupos_whatsapp (jid, nome, ativo_sorteios, enabled)
          VALUES (?, ?, 0, 1)
        `, [grupo.jid, grupo.nome]);
        novosGrupos++;
      } else {
        // Atualizar nome se mudou
        await db.run('UPDATE grupos_whatsapp SET nome = ? WHERE jid = ?', [grupo.nome, grupo.jid]);
      }
    }
    
    logger.audit('grupos_sync', `${novosGrupos} novos grupos sincronizados`, 'admin', req.ip);
    res.json({ success: true, novosGrupos, totalGrupos: grupos.length });
  } catch (error) {
    logger.error('❌ Erro ao sincronizar grupos:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Textos de sorteios
router.get('/api/textos', authenticateAdmin, async (req, res) => {
  try {
    const db = await database.getConnection();
    const textos = await db.all(`
      SELECT * FROM textos_sorteios 
      ORDER BY id
    `);
    
    res.json(textos);
  } catch (error) {
    logger.error('❌ Erro ao obter textos:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Criar/Atualizar texto
router.post('/api/textos', authenticateAdmin, async (req, res) => {
  try {
    const { id, texto_template, ativo } = req.body;
    const db = await database.getConnection();
    
    if (id) {
      // Atualizar
      await db.run(`
        UPDATE textos_sorteios 
        SET texto_template = ?, ativo = ?
        WHERE id = ?
      `, [texto_template, ativo ? 1 : 0, id]);
    } else {
      // Criar
      await db.run(`
        INSERT INTO textos_sorteios (texto_template, ativo)
        VALUES (?, ?)
      `, [texto_template, ativo ? 1 : 0]);
    }
    
    logger.audit('texto_updated', `Texto ${id ? 'atualizado' : 'criado'}`, 'admin', req.ip);
    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Erro ao salvar texto:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Deletar texto
router.delete('/api/textos/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const db = await database.getConnection();
    
    await db.run('DELETE FROM textos_sorteios WHERE id = ?', [id]);
    
    logger.audit('texto_deleted', `Texto ${id} deletado`, 'admin', req.ip);
    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Erro ao deletar texto:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Cupons
router.get('/api/cupons', authenticateAdmin, async (req, res) => {
  try {
    const db = await database.getConnection();
    const cupom = await db.get(`
      SELECT * FROM cupons_atuais 
      ORDER BY atualizado_em DESC 
      LIMIT 1
    `);
    
    res.json(cupom || { cupom1: '', cupom2: '' });
  } catch (error) {
    logger.error('❌ Erro ao obter cupons:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Atualizar cupons
router.post('/api/cupons', authenticateAdmin, async (req, res) => {
  try {
    const { cupom1, cupom2 } = req.body;
    const db = await database.getConnection();
    
    await db.run(`
      INSERT INTO cupons_atuais (cupom1, cupom2)
      VALUES (?, ?)
    `, [cupom1, cupom2]);
    
    logger.audit('cupons_updated', 'Cupons atualizados', 'admin', req.ip);
    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Erro ao atualizar cupons:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Executar job manualmente
router.post('/api/jobs/:name/run', authenticateAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    const jobScheduler = req.app.locals.jobScheduler;
    
    if (!jobScheduler) {
      return res.status(400).json({ error: 'Agendador não disponível' });
    }
    
    await jobScheduler.runJobNow(name);
    
    logger.audit('job_manual_run', `Job ${name} executado manualmente`, 'admin', req.ip);
    res.json({ success: true });
  } catch (error) {
    logger.error(`❌ Erro ao executar job ${req.params.name}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// API: Processar sorteio manual
router.post('/api/sorteios/processar', authenticateAdmin, async (req, res) => {
  try {
    const { codigo } = req.body;
    const sorteiosModule = new SorteiosModule();
    
    const resultado = await sorteiosModule.processarSorteioManual(codigo);
    
    logger.audit('sorteio_manual', `Sorteio ${codigo} processado manualmente`, 'admin', req.ip);
    res.json(resultado);
  } catch (error) {
    logger.error('❌ Erro ao processar sorteio manual:', error);
    res.status(500).json({ error: error.message });
  }
});

// Função para gerar HTML do dashboard
async function generateDashboardHTML(whatsappStatus, jobsStatus) {
  return `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Dashboard - WhatsApp Automation</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: #f8f9fa;
                color: #333;
            }
            .header {
                background: white;
                padding: 1rem 2rem;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .nav {
                display: flex;
                gap: 1rem;
            }
            .nav a {
                text-decoration: none;
                color: #667eea;
                font-weight: 500;
                padding: 0.5rem 1rem;
                border-radius: 5px;
                transition: background 0.3s;
            }
            .nav a:hover, .nav a.active {
                background: #667eea;
                color: white;
            }
            .container {
                max-width: 1200px;
                margin: 2rem auto;
                padding: 0 2rem;
            }
            .grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
                gap: 2rem;
                margin-bottom: 2rem;
            }
            .card {
                background: white;
                border-radius: 10px;
                padding: 1.5rem;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            .card h3 {
                margin-bottom: 1rem;
                color: #333;
            }
            .status {
                display: inline-block;
                padding: 0.25rem 0.75rem;
                border-radius: 20px;
                font-size: 0.8rem;
                font-weight: 500;
            }
            .status.connected { background: #d4edda; color: #155724; }
            .status.disconnected { background: #f8d7da; color: #721c24; }
            .status.running { background: #d1ecf1; color: #0c5460; }
            .btn {
                background: #667eea;
                color: white;
                border: none;
                padding: 0.5rem 1rem;
                border-radius: 5px;
                cursor: pointer;
                font-size: 0.9rem;
                transition: background 0.3s;
            }
            .btn:hover { background: #5a6fd8; }
            .btn.danger { background: #e74c3c; }
            .btn.danger:hover { background: #c0392b; }
            .table {
                width: 100%;
                border-collapse: collapse;
                margin-top: 1rem;
            }
            .table th, .table td {
                padding: 0.75rem;
                text-align: left;
                border-bottom: 1px solid #dee2e6;
            }
            .table th {
                background: #f8f9fa;
                font-weight: 600;
            }
            .modal {
                display: none;
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.5);
                z-index: 1000;
            }
            .modal-content {
                background: white;
                margin: 5% auto;
                padding: 2rem;
                border-radius: 10px;
                width: 90%;
                max-width: 600px;
                max-height: 80vh;
                overflow-y: auto;
            }
            .form-group {
                margin-bottom: 1rem;
            }
            .form-group label {
                display: block;
                margin-bottom: 0.5rem;
                font-weight: 500;
            }
            .form-group input, .form-group textarea {
                width: 100%;
                padding: 0.75rem;
                border: 2px solid #e1e5e9;
                border-radius: 5px;
                font-size: 1rem;
            }
            .form-group textarea {
                min-height: 100px;
                resize: vertical;
            }
            .checkbox {
                display: flex;
                align-items: center;
                gap: 0.5rem;
            }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>🤖 WhatsApp Automation</h1>
            <div class="nav">
                <a href="#" class="active" onclick="showSection('dashboard')">Dashboard</a>
                <a href="#" onclick="showSection('grupos')">Grupos</a>
                <a href="#" onclick="showSection('textos')">Textos</a>
                <a href="#" onclick="showSection('configuracoes')">Configurações</a>
                <a href="#" onclick="logout()">Sair</a>
            </div>
        </div>

        <div class="container">
            <!-- Dashboard Section -->
            <div id="dashboard-section">
                <div class="grid">
                    <div class="card">
                        <h3>📱 Status WhatsApp</h3>
                        <p>Conexão: <span class="status ${whatsappStatus.isConnected ? 'connected' : 'disconnected'}">${whatsappStatus.isConnected ? 'Conectado' : 'Desconectado'}</span></p>
                        <p>Fila de mensagens: ${whatsappStatus.queueLength || 0}</p>
                        <p>Circuit Breaker: ${whatsappStatus.circuitBreakerState || 'N/A'}</p>
                        ${!whatsappStatus.isConnected ? '<button class="btn" onclick="clearWhatsAppSession()">Limpar Sessão</button>' : ''}
                    </div>

                    <div class="card">
                        <h3>⏰ Jobs Agendados</h3>
                        <div id="jobs-list">
                            ${Object.entries(jobsStatus).map(([name, job]) => `
                                <div style="margin-bottom: 1rem;">
                                    <strong>${name}</strong>
                                    <span class="status ${job.isRunning ? 'running' : 'connected'}">${job.isRunning ? 'Executando' : 'Agendado'}</span>
                                    <button class="btn" onclick="runJob('${name}')">Executar</button>
                                </div>
                            `).join('')}
                        </div>
                    </div>

                    <div class="card">
                        <h3>📊 Estatísticas</h3>
                        <div id="stats">Carregando...</div>
                    </div>
                </div>

                <div class="card">
                    <h3>🎯 Processar Sorteio Manual</h3>
                    <div style="display: flex; gap: 1rem; align-items: center;">
                        <input type="text" id="codigoSorteio" placeholder="Código do sorteio (ex: a09)" style="flex: 1;">
                        <button class="btn" onclick="processarSorteioManual()">Processar</button>
                    </div>
                    <div id="resultado-manual" style="margin-top: 1rem;"></div>
                </div>
            </div>

            <!-- Outras seções serão carregadas dinamicamente -->
            <div id="grupos-section" style="display: none;">
                <div class="card">
                    <h3>👥 Gestão de Grupos</h3>
                    <button class="btn" onclick="syncGroups()">Sincronizar Grupos</button>
                    <table class="table" id="grupos-table">
                        <thead>
                            <tr>
                                <th>Nome</th>
                                <th>Ativo para Sorteios</th>
                                <th>Habilitado</th>
                                <th>Ações</th>
                            </tr>
                        </thead>
                        <tbody></tbody>
                    </table>
                </div>
            </div>

            <div id="textos-section" style="display: none;">
                <div class="card">
                    <h3>📝 Textos de Sorteios</h3>
                    <button class="btn" onclick="showTextoModal()">Novo Texto</button>
                    <div id="textos-list"></div>
                </div>
            </div>

            <div id="configuracoes-section" style="display: none;">
                <div class="card">
                    <h3>🎫 Cupons Atuais</h3>
                    <div class="form-group">
                        <label>Cupom Principal:</label>
                        <input type="text" id="cupom1" placeholder="PEGAJ">
                    </div>
                    <div class="form-group">
                        <label>Cupom Secundário:</label>
                        <input type="text" id="cupom2" placeholder="DESCONTO">
                    </div>
                    <button class="btn" onclick="salvarCupons()">Salvar Cupons</button>
                </div>
            </div>
        </div>

        <!-- Modal para textos -->
        <div id="texto-modal" class="modal">
            <div class="modal-content">
                <h3>Editar Texto</h3>
                <form id="texto-form">
                    <input type="hidden" id="texto-id">
                    <div class="form-group">
                        <label>Texto do Template:</label>
                        <textarea id="texto-template" placeholder="Use {NOME_GANHADOR}, {PREMIO}, {LINK_RESULTADO}, {CUPOM}"></textarea>
                    </div>
                    <div class="form-group">
                        <div class="checkbox">
                            <input type="checkbox" id="texto-ativo">
                            <label>Ativo</label>
                        </div>
                    </div>
                    <div style="display: flex; gap: 1rem;">
                        <button type="submit" class="btn">Salvar</button>
                        <button type="button" class="btn danger" onclick="closeModal()">Cancelar</button>
                    </div>
                </form>
            </div>
        </div>

        <script>
            // JavaScript será adicionado na próxima parte devido ao limite de caracteres
        </script>
    </body>
    </html>
  `;
}

module.exports = router;

