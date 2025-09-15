/* public/js/hub.js
 * HUB utilitário para páginas públicas e admin do WhatsApp Automation.
 * Mantém compatibilidade adicionando tudo ao namespace window.WAHub sem poluir o escopo global.
 */
(function (window, document) {
  'use strict';

  // ---------- Utils ----------
  var WAHub = window.WAHub || {};

  function nowISO() { return new Date().toISOString(); }

  function toJSONSafe(res) {
    var ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.indexOf('application/json') !== -1) return res.json();
    return res.text().then(function (t) {
      try { return JSON.parse(t); } catch (_) { return { ok: res.ok, status: res.status, text: t }; }
    });
  }

  function timeoutPromise(ms) {
    return new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error('timeout')); }, ms);
    });
  }

  function request(url, fetchOpts, opts) {
    fetchOpts = fetchOpts || {};
    opts = opts || {};
    var timeout = typeof opts.timeout === 'number' ? opts.timeout : 15000;
    return Promise.race([
      fetch(url, fetchOpts),
      timeoutPromise(timeout)
    ]).then(function (res) {
      if (!res || typeof res.ok === 'undefined') throw new Error('network');
      return toJSONSafe(res).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
          err.status = res.status; err.payload = data;
          throw err;
        }
        return data;
      });
    });
  }

  function $(sel) { return document.querySelector(sel); }
  function setHTML(id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; }
  function setText(id, text) { var el = document.getElementById(id); if (el) el.textContent = text; }
  function toggleDisplay(id, show) { var el = document.getElementById(id); if (el) el.style.display = show ? 'block' : 'none'; }

  function showAlert(message, type) {
    type = type || 'info';
    var alertsDiv = document.getElementById('alerts');
    if (!alertsDiv) return;
    var cls = 'alert-' + type;
    alertsDiv.innerHTML = '<div class="alert ' + cls + '">' + message + '</div>';
    setTimeout(function () { alertsDiv.innerHTML = ''; }, 5000);
  }

  function showLoading(show) { toggleDisplay('loading', !!show); }

  // ---------- Status ----------
  function computeNextRunLabel() {
    var d = new Date();
    var m = d.getMinutes();
    var nextMin = m < 5 ? 5 : (m < 35 ? 35 : 5);
    var nextHour = (nextMin === 5 && m >= 35) ? d.getHours() + 1 : d.getHours();
    var hh = String(nextHour % 24).padStart(2, '0');
    var mm = String(nextMin).padStart(2, '0');
    return hh + ':' + mm;
  }

  function paintStatus(health) {
    // WhatsApp
    var whatsappConnected = !!(health && health.checks && health.checks.whatsapp && health.checks.whatsapp.connected);
    var waEl = document.getElementById('whatsapp-status');
    if (waEl) {
      waEl.innerHTML =
        '<span class="status-indicator ' + (whatsappConnected ? 'status-connected' : 'status-disconnected') + '"></span>' +
        '<span>' + (whatsappConnected ? 'Conectado' : 'Desconectado') + '</span>';
    }

    // Scheduler
    var schedulerOk = (health && health.checks && health.checks.scheduler && health.checks.scheduler.status === 'ok');
    var monEl = document.getElementById('monitor-status');
    if (monEl) {
      monEl.innerHTML =
        '<span class="status-indicator ' + (schedulerOk ? 'status-connected' : 'status-warning') + '"></span>' +
        '<span>' + (schedulerOk ? 'Ativo' : 'Inativo') + '</span>';
    }

    // Database
    var dbOk = (health && health.checks && health.checks.database && health.checks.database.status === 'ok');
    var dbEl = document.getElementById('database-status');
    if (dbEl) {
      dbEl.innerHTML =
        '<span class="status-indicator ' + (dbOk ? 'status-connected' : 'status-disconnected') + '"></span>' +
        '<span>' + (dbOk ? 'OK' : 'Erro') + '</span>';
    }

    // Memory
    var mem = (health && health.checks && health.checks.memory && Math.round(health.checks.memory.memory_usage_mb || 0)) || 0;
    var memOk = mem < 400;
    var memEl = document.getElementById('memory-status');
    if (memEl) {
      memEl.innerHTML =
        '<span class="status-indicator ' + (memOk ? 'status-connected' : 'status-warning') + '"></span>' +
        '<span>' + mem + 'MB</span>';
    }

    // Horas
    var last = new Date();
    setText('ultimo-monitoramento', last.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
    setText('proximo-monitoramento', computeNextRunLabel());
  }

  function updateStatsFromAdminStatus(status) {
    // Atualiza estatísticas se disponíveis no /admin/api/status
    try {
      var s = status && status.sorteios && status.sorteios.sorteios || {};
      var grupos = status && status.whatsapp && status.whatsapp.groupsActive;
      if (typeof grupos === 'number') setText('grupos-ativos', grupos);
      if (typeof s.total_processados === 'number') setText('sorteios-processados', s.total_processados);
    } catch (_) {}
  }

  function atualizarStatus() {
    return request('/health', {}, { timeout: 12000 })
      .then(function (data) {
        paintStatus(data);
        updateStatsFromAdminStatus(data);
        return data;
      })
      .catch(function (err) {
        showAlert('Erro ao atualizar status (' + (err.message || err) + ')', 'error');
      });
  }

  // ---------- Grupos ----------
  var gruposCache = [];

  function renderizarGrupos() {
    var cont = document.getElementById('grupos-lista');
    if (!cont) return;
    if (!gruposCache.length) {
      cont.innerHTML = '<p>Nenhum grupo encontrado. Sincronize os grupos primeiro.</p>';
      return;
    }
    cont.innerHTML = gruposCache.map(function (g) {
      var ativo = !!(g.ativo || g.ativo_sorteios);
      var id = g.id || g.jid || '';
      var nome = g.nome || g.name || g.subject || id;
      return '' +
        '<div class="group-item">' +
          '<div>' +
            '<div class="group-name">' + nome + '</div>' +
            '<span class="group-status ' + (ativo ? 'group-active' : 'group-inactive') + '">' +
              (ativo ? 'Ativo' : 'Inativo') +
            '</span>' +
          '</div>' +
          '<label class="toggle-switch">' +
            '<input type="checkbox" ' + (ativo ? 'checked' : '') + ' onchange="WAHub.toggleGrupo(\'' + id + '\', this.checked)">' +
            '<span class="slider"></span>' +
          '</label>' +
        '</div>';
    }).join('');
  }

  function carregarGrupos() {
    var adminEndpoint = '/admin/api/grupos';
    // tenta admin primeiro; se falhar, mantém lista mock ou limpa
    showLoading(true);
    return request(adminEndpoint, {}, { timeout: 15000 })
      .then(function (list) {
        if (Array.isArray(list)) gruposCache = list;
        renderizarGrupos();
        showLoading(false);
        return list;
      })
      .catch(function () {
        // fallback soft: não quebra página pública
        showLoading(false);
        // mantém os grupos como estão; se vazio, mostra placeholder
        renderizarGrupos();
      });
  }

  function toggleGrupo(grupoId, ativo) {
    // Atualiza UI imediata
    var g = gruposCache.find(function (x) { return (x.id || x.jid) === grupoId; });
    if (g) { g.ativo = !!ativo; g.ativo_sorteios = !!ativo; renderizarGrupos(); }

    // Tenta persistir se admin API existir
    return request('/admin/api/grupos/' + encodeURIComponent(grupoId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ativo_sorteios: !!ativo })
    }).catch(function () {
      // reverte em caso de erro
      if (g) { g.ativo = !ativo; g.ativo_sorteios = !ativo; renderizarGrupos(); }
      showAlert('Erro ao alterar status do grupo', 'error');
    });
  }

  function sincronizarGrupos() {
    showLoading(true);
    showAlert('Sincronizando grupos...', 'info');
    return request('/admin/api/grupos/sync', { method: 'POST' }, { timeout: 20000 })
      .then(function () { return carregarGrupos(); })
      .then(function () {
        showAlert('Grupos sincronizados com sucesso!', 'success');
        showLoading(false);
      })
      .catch(function (e) {
        showAlert('Erro ao sincronizar grupos: ' + (e.message || e), 'error');
        showLoading(false);
      });
  }

  // ---------- Ações rápidas ----------
  function processarSorteioManual(codigo) {
    // se o código vier de input padrão do dashboard admin
    if (!codigo) {
      var input = document.getElementById('codigoSorteio');
      codigo = input && input.value ? input.value.trim() : '';
    }
    if (!codigo) { showAlert('Informe o código do sorteio.', 'error'); return Promise.resolve(); }

    var resultEl = document.getElementById('resultado-manual');
    if (resultEl) resultEl.textContent = 'Processando...';

    return request('/admin/api/sorteios/processar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codigo: codigo })
    }, { timeout: 30000 })
      .then(function (data) {
        if (resultEl) resultEl.textContent = JSON.stringify(data, null, 2);
        showAlert('Sorteio processado!', 'success');
        return data;
      })
      .catch(function (e) {
        if (resultEl) resultEl.textContent = 'Erro: ' + (e.message || e);
        showAlert('Erro ao processar sorteio', 'error');
      });
  }

  function testarConexao() {
    showLoading(true);
    showAlert('Testando conexão WhatsApp...', 'info');
    return atualizarStatus()
      .then(function () { showAlert('Conexão WhatsApp verificada!', 'success'); })
      .catch(function () { showAlert('Erro na verificação', 'error'); })
      .finally(function () { showLoading(false); });
  }

  function clearWhatsAppSession() {
    if (!confirm('Tem certeza que deseja limpar a sessão do WhatsApp? Isso irá desconectar e exigir nova autenticação.')) return;
    showLoading(true);
    return request('/api/whatsapp/clear-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }).then(function (data) {
      showAlert(data && data.message ? data.message : 'Sessão limpa com sucesso! QR será gerado.', 'success');
      setTimeout(atualizarStatus, 3000);
    }).catch(function (e) {
      showAlert('Erro ao limpar sessão: ' + (e.message || e), 'error');
    }).finally(function () { showLoading(false); });
  }

  function resetWhatsApp() {
    if (!confirm('Deseja resetar o WhatsApp? Isso irá limpar a sessão e gerar novo QR Code.')) return;
    showLoading(true);
    return request('/api/reset-whatsapp', {}, { timeout: 30000 })
      .then(function (data) {
        showAlert((data && data.message) || 'Reset solicitado', 'success');
        setTimeout(function () {
          atualizarStatus();
          if (data && data.action === 'qr_ready') showAlert('QR Code pronto! Acesse /qr para escanear', 'info');
        }, 3000);
      })
      .catch(function (e) { showAlert('Erro ao resetar: ' + (e.message || e), 'error'); })
      .finally(function () { showLoading(false); });
  }

  // ---------- Jobs (admin) ----------
  function runJob(name) {
    if (!name) return;
    return request('/admin/api/jobs/' + encodeURIComponent(name) + '/run', { method: 'POST' })
      .then(function () { alert('Job executado com sucesso.'); })
      .catch(function () { alert('Falha ao executar job.'); });
  }

  // ---------- Textos (admin) ----------
  function loadTextos() {
    var listBox = document.getElementById('textos-list');
    if (!listBox) return Promise.resolve();
    return request('/admin/api/textos')
      .then(function (list) {
        if (!Array.isArray(list) || !list.length) {
          listBox.innerHTML = '<p>Nenhum texto cadastrado.</p>'; return;
        }
        listBox.innerHTML = list.map(function (t) {
          return '' +
            '<div style="border:1px solid #e9ecef; padding:10px; border-radius:6px; margin:.5rem 0;">' +
              '<div style="font-weight:600; margin-bottom:.25rem;">#' + t.id + '</div>' +
              '<div style="white-space:pre-wrap;">' + (t.texto_template || '') + '</div>' +
              '<div style="margin-top:.5rem; display:flex; gap:.5rem; align-items:center;">' +
                '<span class="badge ' + (t.ativo ? 'ok' : 'warn') + '">' + (t.ativo ? 'Ativo' : 'Inativo') + '</span>' +
                '<button class="btn" onclick=\'WAHub.showTextoModal(' + JSON.stringify(t).replace(/'/g, '&apos;') + ')\'>Editar</button>' +
                '<button class="btn danger" onclick="WAHub.deleteTexto(' + t.id + ')">Excluir</button>' +
              '</div>' +
            '</div>';
        }).join('');
      })
      .catch(function () { listBox.innerHTML = '<p>Erro ao carregar textos.</p>'; });
  }

  function showTextoModal(item) {
    var modal = document.getElementById('texto-modal');
    if (!modal) return;
    var idInput = document.getElementById('texto-id');
    var txtInput = document.getElementById('texto-template');
    var ativoInput = document.getElementById('texto-ativo');
    if (idInput) idInput.value = item && item.id || '';
    if (txtInput) txtInput.value = item && item.texto_template || '';
    if (ativoInput) ativoInput.checked = !!(item && item.ativo);
    modal.style.display = 'block';
  }

  function closeTextoModal() {
    var modal = document.getElementById('texto-modal');
    if (modal) modal.style.display = 'none';
  }

  function saveTextoFromForm(e) {
    if (e && e.preventDefault) e.preventDefault();
    var id = ($('#texto-id') || {}).value || null;
    var texto_template = ($('#texto-template') || {}).value || '';
    var ativo = ($('#texto-ativo') || {}).checked || false;
    return request('/admin/api/textos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, texto_template: texto_template, ativo: ativo })
    }).then(function () {
      closeTextoModal();
      loadTextos();
      alert('Salvo!');
    }).catch(function () { alert('Erro ao salvar'); });
  }

  function deleteTexto(id) {
    if (!confirm('Excluir texto #' + id + '?')) return;
    return request('/admin/api/textos/' + id, { method: 'DELETE' })
      .then(function () { loadTextos(); alert('Excluído!'); })
      .catch(function () { alert('Erro ao excluir'); });
  }

  // ---------- Cupons (admin) ----------
  function salvarCupons() {
    var cupom1 = ($('#cupom1') || {}).value || '';
    var cupom2 = ($('#cupom2') || {}).value || '';
    return request('/admin/api/cupons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cupom1: cupom1.trim(), cupom2: cupom2.trim() })
    }).then(function () { alert('Cupons salvos!'); })
      .catch(function () { alert('Erro ao salvar cupons'); });
  }

  // ---------- Inicialização ----------
  function init(options) {
    options = options || {};
    // Bind do form de textos, se existir
    var textoForm = document.getElementById('texto-form');
    if (textoForm && !textoForm.__hubBound) {
      textoForm.addEventListener('submit', saveTextoFromForm);
      textoForm.__hubBound = true;
    }
    // Carregamentos condicionais
    atualizarStatus();
    if (document.getElementById('grupos-lista') || document.getElementById('grupos-table')) {
      carregarGrupos();
    }
    if (document.getElementById('textos-list')) {
      loadTextos();
    }
    // Poll de status se solicitado
    var interval = options.statusIntervalMs || 30000;
    if (!init.__pollStarted) {
      setInterval(atualizarStatus, interval);
      init.__pollStarted = true;
    }
  }

  // ---------- Expose ----------
  WAHub.init = init;
  WAHub.atualizarStatus = atualizarStatus;
  WAHub.showAlert = showAlert;
  WAHub.showLoading = showLoading;

  WAHub.carregarGrupos = carregarGrupos;
  WAHub.renderizarGrupos = renderizarGrupos;
  WAHub.toggleGrupo = toggleGrupo;
  WAHub.sincronizarGrupos = sincronizarGrupos;

  WAHub.processarSorteioManual = processarSorteioManual;
  WAHub.testarConexao = testarConexao;
  WAHub.clearWhatsAppSession = clearWhatsAppSession;
  WAHub.resetWhatsApp = resetWhatsApp;
  WAHub.runJob = runJob;

  WAHub.loadTextos = loadTextos;
  WAHub.showTextoModal = showTextoModal;
  WAHub.closeTextoModal = closeTextoModal;
  WAHub.saveTextoFromForm = saveTextoFromForm;
  WAHub.deleteTexto = deleteTexto;

  WAHub.salvarCupons = salvarCupons;

  // Auto-init se a página desejar (data-auto-init)
  if (document.currentScript && document.currentScript.dataset.autoInit === '1') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { init(); });
    } else {
      init();
    }
  }

  window.WAHub = WAHub;
})(window, document);
