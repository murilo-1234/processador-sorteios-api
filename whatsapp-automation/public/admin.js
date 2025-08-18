// JavaScript para o painel administrativo

let currentSection = 'dashboard';

// Inicialização
document.addEventListener('DOMContentLoaded', function() {
    loadStats();
    setInterval(loadStats, 30000); // Atualizar a cada 30 segundos
});

// Navegação entre seções
function showSection(section) {
    // Esconder todas as seções
    document.querySelectorAll('[id$="-section"]').forEach(el => {
        el.style.display = 'none';
    });
    
    // Mostrar seção selecionada
    document.getElementById(section + '-section').style.display = 'block';
    
    // Atualizar navegação
    document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
    event.target.classList.add('active');
    
    currentSection = section;
    
    // Carregar dados específicos da seção
    switch(section) {
        case 'grupos':
            loadGrupos();
            break;
        case 'textos':
            loadTextos();
            break;
        case 'configuracoes':
            loadCupons();
            break;
    }
}

// Carregar estatísticas
async function loadStats() {
    try {
        const response = await fetch('/admin/api/status');
        const data = await response.json();
        
        const statsDiv = document.getElementById('stats');
        if (statsDiv) {
            statsDiv.innerHTML = `
                <div style="margin-bottom: 1rem;">
                    <strong>Sorteios Processados:</strong>
                    <div>Hoje: ${data.sorteios?.sorteios?.hoje || 0}</div>
                    <div>Ontem: ${data.sorteios?.sorteios?.ontem || 0}</div>
                    <div>Última semana: ${data.sorteios?.sorteios?.ultima_semana || 0}</div>
                </div>
                <div>
                    <strong>Envios (última semana):</strong>
                    <div>Enviados: ${data.sorteios?.envios?.enviados || 0}</div>
                    <div>Falhados: ${data.sorteios?.envios?.falhados || 0}</div>
                </div>
            `;
        }
    } catch (error) {
        console.error('Erro ao carregar estatísticas:', error);
    }
}

// Executar job manualmente
async function runJob(jobName) {
    if (!confirm(`Executar job "${jobName}" manualmente?`)) return;
    
    try {
        const response = await fetch(`/admin/api/jobs/${jobName}/run`, {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (data.success) {
            alert(`Job "${jobName}" executado com sucesso!`);
        } else {
            alert(`Erro ao executar job: ${data.error}`);
        }
    } catch (error) {
        alert('Erro de conexão ao executar job');
        console.error(error);
    }
}

// Processar sorteio manual
async function processarSorteioManual() {
    const codigo = document.getElementById('codigoSorteio').value.trim();
    const resultadoDiv = document.getElementById('resultado-manual');
    
    if (!codigo) {
        alert('Digite o código do sorteio');
        return;
    }
    
    resultadoDiv.innerHTML = '<p>Processando...</p>';
    
    try {
        const response = await fetch('/admin/api/sorteios/processar', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ codigo })
        });
        
        const data = await response.json();
        
        if (data.status === 'success') {
            resultadoDiv.innerHTML = `
                <div style="color: green;">
                    <strong>✅ Sucesso!</strong><br>
                    Ganhador: ${data.ganhador}<br>
                    Grupos enviados: ${data.gruposEnviados}
                </div>
            `;
        } else if (data.status === 'already_processed') {
            resultadoDiv.innerHTML = '<div style="color: orange;">⚠️ Sorteio já foi processado hoje</div>';
        } else {
            resultadoDiv.innerHTML = `<div style="color: red;">❌ Erro: ${data.error || 'Erro desconhecido'}</div>`;
        }
        
        document.getElementById('codigoSorteio').value = '';
    } catch (error) {
        resultadoDiv.innerHTML = '<div style="color: red;">❌ Erro de conexão</div>';
        console.error(error);
    }
}

// Limpar sessão WhatsApp
async function clearWhatsAppSession() {
    if (!confirm('Limpar sessão do WhatsApp? Será necessário escanear o QR Code novamente.')) return;
    
    try {
        const response = await fetch('/api/whatsapp/clear-session', {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (data.success) {
            alert('Sessão limpa com sucesso! Verifique os logs para o novo QR Code.');
            location.reload();
        } else {
            alert(`Erro: ${data.error}`);
        }
    } catch (error) {
        alert('Erro de conexão');
        console.error(error);
    }
}

// Carregar grupos
async function loadGrupos() {
    try {
        const response = await fetch('/admin/api/grupos');
        const grupos = await response.json();
        
        const tbody = document.querySelector('#grupos-table tbody');
        tbody.innerHTML = '';
        
        grupos.forEach(grupo => {
            const row = tbody.insertRow();
            row.innerHTML = `
                <td>${grupo.nome}</td>
                <td>
                    <input type="checkbox" ${grupo.ativo_sorteios ? 'checked' : ''} 
                           onchange="updateGrupo('${grupo.jid}', 'ativo_sorteios', this.checked)">
                </td>
                <td>
                    <input type="checkbox" ${grupo.enabled ? 'checked' : ''} 
                           onchange="updateGrupo('${grupo.jid}', 'enabled', this.checked)">
                </td>
                <td>
                    <small>${new Date(grupo.created_at).toLocaleDateString()}</small>
                </td>
            `;
        });
    } catch (error) {
        console.error('Erro ao carregar grupos:', error);
    }
}

// Sincronizar grupos
async function syncGroups() {
    try {
        const response = await fetch('/admin/api/grupos/sync', {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (data.success) {
            alert(`Sincronização concluída! ${data.novosGrupos} novos grupos encontrados.`);
            loadGrupos();
        } else {
            alert(`Erro: ${data.error}`);
        }
    } catch (error) {
        alert('Erro de conexão');
        console.error(error);
    }
}

// Atualizar grupo
async function updateGrupo(jid, campo, valor) {
    try {
        const body = {};
        body[campo] = valor;
        
        // Manter o outro valor
        const row = event.target.closest('tr');
        const checkboxes = row.querySelectorAll('input[type="checkbox"]');
        if (campo === 'ativo_sorteios') {
            body.enabled = checkboxes[1].checked;
        } else {
            body.ativo_sorteios = checkboxes[0].checked;
        }
        
        const response = await fetch(`/admin/api/grupos/${encodeURIComponent(jid)}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        
        const data = await response.json();
        
        if (!data.success) {
            alert(`Erro: ${data.error}`);
            // Reverter checkbox
            event.target.checked = !valor;
        }
    } catch (error) {
        alert('Erro de conexão');
        console.error(error);
        // Reverter checkbox
        event.target.checked = !valor;
    }
}

// Carregar textos
async function loadTextos() {
    try {
        const response = await fetch('/admin/api/textos');
        const textos = await response.json();
        
        const container = document.getElementById('textos-list');
        container.innerHTML = '';
        
        textos.forEach(texto => {
            const div = document.createElement('div');
            div.style.cssText = 'border: 1px solid #ddd; padding: 1rem; margin: 1rem 0; border-radius: 5px;';
            div.innerHTML = `
                <div style="display: flex; justify-content: between; align-items: center; margin-bottom: 0.5rem;">
                    <strong>Texto #${texto.id}</strong>
                    <span class="status ${texto.ativo ? 'connected' : 'disconnected'}">
                        ${texto.ativo ? 'Ativo' : 'Inativo'}
                    </span>
                </div>
                <div style="background: #f8f9fa; padding: 0.5rem; border-radius: 3px; margin-bottom: 0.5rem; font-family: monospace; font-size: 0.9rem;">
                    ${texto.texto_template.substring(0, 200)}${texto.texto_template.length > 200 ? '...' : ''}
                </div>
                <div>
                    <button class="btn" onclick="editTexto(${texto.id})">Editar</button>
                    <button class="btn danger" onclick="deleteTexto(${texto.id})">Excluir</button>
                </div>
            `;
            container.appendChild(div);
        });
    } catch (error) {
        console.error('Erro ao carregar textos:', error);
    }
}

// Mostrar modal de texto
function showTextoModal(id = null) {
    const modal = document.getElementById('texto-modal');
    const form = document.getElementById('texto-form');
    
    if (id) {
        // Editar texto existente
        fetch(`/admin/api/textos`)
            .then(response => response.json())
            .then(textos => {
                const texto = textos.find(t => t.id === id);
                if (texto) {
                    document.getElementById('texto-id').value = texto.id;
                    document.getElementById('texto-template').value = texto.texto_template;
                    document.getElementById('texto-ativo').checked = texto.ativo;
                }
            });
    } else {
        // Novo texto
        form.reset();
        document.getElementById('texto-ativo').checked = true;
    }
    
    modal.style.display = 'block';
}

// Editar texto
function editTexto(id) {
    showTextoModal(id);
}

// Deletar texto
async function deleteTexto(id) {
    if (!confirm('Excluir este texto?')) return;
    
    try {
        const response = await fetch(`/admin/api/textos/${id}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            loadTextos();
        } else {
            alert(`Erro: ${data.error}`);
        }
    } catch (error) {
        alert('Erro de conexão');
        console.error(error);
    }
}

// Fechar modal
function closeModal() {
    document.getElementById('texto-modal').style.display = 'none';
}

// Salvar texto
document.getElementById('texto-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const formData = {
        id: document.getElementById('texto-id').value || null,
        texto_template: document.getElementById('texto-template').value,
        ativo: document.getElementById('texto-ativo').checked
    };
    
    try {
        const response = await fetch('/admin/api/textos', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(formData)
        });
        
        const data = await response.json();
        
        if (data.success) {
            closeModal();
            loadTextos();
        } else {
            alert(`Erro: ${data.error}`);
        }
    } catch (error) {
        alert('Erro de conexão');
        console.error(error);
    }
});

// Carregar cupons
async function loadCupons() {
    try {
        const response = await fetch('/admin/api/cupons');
        const cupons = await response.json();
        
        document.getElementById('cupom1').value = cupons.cupom1 || '';
        document.getElementById('cupom2').value = cupons.cupom2 || '';
    } catch (error) {
        console.error('Erro ao carregar cupons:', error);
    }
}

// Salvar cupons
async function salvarCupons() {
    const cupons = {
        cupom1: document.getElementById('cupom1').value,
        cupom2: document.getElementById('cupom2').value
    };
    
    try {
        const response = await fetch('/admin/api/cupons', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(cupons)
        });
        
        const data = await response.json();
        
        if (data.success) {
            alert('Cupons salvos com sucesso!');
        } else {
            alert(`Erro: ${data.error}`);
        }
    } catch (error) {
        alert('Erro de conexão');
        console.error(error);
    }
}

// Logout
async function logout() {
    try {
        await fetch('/admin/auth/logout', { method: 'POST' });
        window.location.href = '/admin/login';
    } catch (error) {
        console.error('Erro no logout:', error);
        window.location.href = '/admin/login';
    }
}

// Fechar modal clicando fora
window.onclick = function(event) {
    const modal = document.getElementById('texto-modal');
    if (event.target === modal) {
        closeModal();
    }
}

