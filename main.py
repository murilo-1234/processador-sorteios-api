# -*- coding: utf-8 -*-
"""
Sistema Integrado de Processamento de Sorteios + Automação Manychat
Preserva funcionalidades existentes e adiciona automação Selenium
"""

import os
import json
import logging
import threading
import time
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, render_template_string
from flask_cors import CORS
import schedule

# Imports dos módulos do sistema
from config_final import *
from google_sheets_monitor_final import GoogleSheetsMonitor, executar_monitoramento
from selenium_manager_final import SeleniumManager, processar_todas_automacoes

# Configuração de logging
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format=LOG_FORMAT,
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler('sistema_sorteios.log')
    ]
)

logger = logging.getLogger(__name__)

# Inicialização Flask
app = Flask(__name__)
CORS(app)

# ================================
# VARIÁVEIS GLOBAIS DO SISTEMA
# ================================

sistema_ativo = True
ultima_verificacao = None
logs_sistema = []
estatisticas = {
    'verificacoes_realizadas': 0,
    'novos_sorteios_processados': 0,
    'automacoes_atualizadas': 0,
    'erros_encontrados': 0,
    'ultima_automacao': None
}

# ================================
# FUNÇÕES DE LOG
# ================================

def adicionar_log(nivel, mensagem):
    """Adiciona log ao sistema com timestamp"""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_entry = {
        'timestamp': timestamp,
        'nivel': nivel,
        'mensagem': mensagem
    }
    
    logs_sistema.append(log_entry)
    
    # Mantém apenas os últimos logs
    if len(logs_sistema) > LOG_MAX_LINES:
        logs_sistema.pop(0)
    
    # Log no sistema
    if nivel == 'INFO':
        logger.info(mensagem)
    elif nivel == 'WARNING':
        logger.warning(mensagem)
    elif nivel == 'ERROR':
        logger.error(mensagem)
    elif nivel == 'DEBUG':
        logger.debug(mensagem)

# ================================
# FUNÇÃO PRINCIPAL DE VERIFICAÇÃO
# ================================

def executar_verificacao_sistema():
    """Execução principal do sistema - verifica planilhas e atualiza Manychat"""
    global ultima_verificacao, estatisticas
    
    try:
        adicionar_log('INFO', MENSAGENS['verificacao_iniciada'])
        estatisticas['verificacoes_realizadas'] += 1
        
        # 1. Monitora Google Sheets
        resultados_sheets = executar_monitoramento()
        
        if not resultados_sheets or 'erro' in resultados_sheets:
            erro = resultados_sheets.get('erro', 'Erro desconhecido') if resultados_sheets else 'Falha no monitoramento'
            adicionar_log('ERROR', f"❌ Erro no monitoramento Google Sheets: {erro}")
            estatisticas['erros_encontrados'] += 1
            return False
        
        # 2. Processa novos sorteios
        novos_processados = resultados_sheets.get('novos_processados', 0)
        if novos_processados > 0:
            adicionar_log('INFO', f"🆕 {novos_processados} novos sorteios processados")
            estatisticas['novos_sorteios_processados'] += novos_processados
        
        # 3. Verifica sorteios finalizados
        sorteios_finalizados = resultados_sheets.get('sorteios_finalizados', [])
        
        if sorteios_finalizados:
            # Há sorteios que acabaram de finalizar
            for sorteio in sorteios_finalizados:
                adicionar_log('INFO', MENSAGENS['sorteio_finalizado'].format(sorteio.get('nome', 'Desconhecido')))
            
            # Obtém dados para automação
            dados_automacao = resultados_sheets.get('dados_automacao')
            
            if dados_automacao:
                adicionar_log('INFO', MENSAGENS['proximo_sorteio'].format(
                    dados_automacao.get('nome', 'Desconhecido'),
                    dados_automacao.get('data', 'Data não informada')
                ))
                
                # 4. Executa automação Manychat
                if executar_automacao_manychat(dados_automacao):
                    adicionar_log('INFO', "✅ Todas as automações Manychat atualizadas com sucesso")
                    estatisticas['automacoes_atualizadas'] += 1
                    estatisticas['ultima_automacao'] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                else:
                    adicionar_log('ERROR', "❌ Falha na automação Manychat")
                    estatisticas['erros_encontrados'] += 1
        
        ultima_verificacao = datetime.now()
        adicionar_log('INFO', "✅ Verificação do sistema concluída")
        return True
        
    except Exception as e:
        adicionar_log('ERROR', f"❌ Erro crítico na verificação: {e}")
        estatisticas['erros_encontrados'] += 1
        return False

def executar_automacao_manychat(dados_automacao):
    """Executa automação Manychat com os dados do próximo sorteio"""
    try:
        if SIMULAR_ATUALIZACOES:
            adicionar_log('INFO', "🧪 Modo simulação - automação Manychat simulada")
            time.sleep(2)  # Simula tempo de processamento
            return True
        
        # Extrai dados necessários
        data_sorteio = dados_automacao.get('data')
        url_planilha = dados_automacao.get('url_planilha')
        sorteio_id = dados_automacao.get('sorteio_id')
        
        if not all([data_sorteio, url_planilha, sorteio_id]):
            adicionar_log('ERROR', "❌ Dados insuficientes para automação Manychat")
            return False
        
        adicionar_log('INFO', "🤖 Iniciando automação Selenium...")
        
        # Executa automação via Selenium
        resultados = processar_todas_automacoes(data_sorteio, url_planilha, sorteio_id)
        
        if 'erro' in resultados:
            adicionar_log('ERROR', f"❌ Erro na automação: {resultados['erro']}")
            return False
        
        # Processa resultados por automação
        sucesso_total = True
        for automacao, resultado in resultados.items():
            if 'erro' in resultado:
                adicionar_log('WARNING', f"⚠️ {automacao}: {resultado['erro']}")
                sucesso_total = False
            elif resultado.get('sucesso'):
                adicionar_log('INFO', MENSAGENS['automacao_concluida'].format(automacao))
            else:
                adicionar_log('WARNING', f"⚠️ Falha parcial na automação {automacao}")
                sucesso_total = False
        
        return sucesso_total
        
    except Exception as e:
        adicionar_log('ERROR', f"❌ Erro na automação Manychat: {e}")
        return False

# ================================
# SCHEDULER E THREAD DE MONITORAMENTO
# ================================

def iniciar_scheduler():
    """Inicia o scheduler para verificações periódicas"""
    schedule.every(INTERVALO_VERIFICACAO).minutes.do(executar_verificacao_sistema)
    
    adicionar_log('INFO', f"⏰ Scheduler iniciado - verificações a cada {INTERVALO_VERIFICACAO} minutos")
    
    while sistema_ativo:
        schedule.run_pending()
        time.sleep(60)  # Verifica a cada minuto

def iniciar_monitoramento():
    """Inicia thread de monitoramento em background"""
    thread_scheduler = threading.Thread(target=iniciar_scheduler, daemon=True)
    thread_scheduler.start()
    
    adicionar_log('INFO', MENSAGENS['sistema_iniciado'])

# ================================
# ROTAS DA API FLASK
# ================================

@app.route('/')
def dashboard():
    """Dashboard principal do sistema"""
    template = """
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Sistema de Automação Manychat + Sorteios</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
            .container { max-width: 1200px; margin: 0 auto; }
            .card { background: white; padding: 20px; margin: 10px 0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            .status { padding: 10px; border-radius: 4px; margin: 10px 0; }
            .status.ativo { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
            .status.erro { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
            .btn { padding: 10px 20px; margin: 5px; border: none; border-radius: 4px; cursor: pointer; }
            .btn-primary { background: #007bff; color: white; }
            .btn-success { background: #28a745; color: white; }
            .btn-warning { background: #ffc107; color: black; }
            .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }
            .stat-card { text-align: center; padding: 15px; }
            .stat-number { font-size: 2em; font-weight: bold; color: #007bff; }
            .logs { max-height: 400px; overflow-y: auto; background: #f8f9fa; padding: 15px; border-radius: 4px; }
            .log-entry { margin: 5px 0; padding: 5px; border-left: 3px solid #007bff; }
            .log-error { border-left-color: #dc3545; }
            .log-warning { border-left-color: #ffc107; }
            .log-info { border-left-color: #28a745; }
            h1, h2 { color: #333; }
            .refresh { float: right; }
        </style>
        <script>
            function executarVerificacao() {
                fetch('/api/executar-verificacao', {method: 'POST'})
                    .then(response => response.json())
                    .then(data => {
                        alert(data.sucesso ? 'Verificação executada!' : 'Erro: ' + data.erro);
                        location.reload();
                    });
            }
            
            function testarManychat() {
                fetch('/api/testar-manychat', {method: 'POST'})
                    .then(response => response.json())
                    .then(data => {
                        alert(data.sucesso ? 'Conexão OK!' : 'Erro: ' + data.erro);
                    });
            }
            
            // Auto-refresh a cada 30 segundos
            setTimeout(() => location.reload(), 30000);
        </script>
    </head>
    <body>
        <div class="container">
            <h1>🤖 Sistema de Automação Manychat + Sorteios</h1>
            
            <div class="card">
                <h2>Status do Sistema <button class="btn btn-primary refresh" onclick="location.reload()">🔄 Atualizar</button></h2>
                <div class="status {{ 'ativo' if sistema_ativo else 'erro' }}">
                    {{ '✅ Sistema Ativo' if sistema_ativo else '❌ Sistema Inativo' }}
                </div>
                <p><strong>Última Verificação:</strong> {{ ultima_verificacao.strftime('%d/%m/%Y %H:%M:%S') if ultima_verificacao else 'Nunca' }}</p>
                <p><strong>Próxima Verificação:</strong> {{ (ultima_verificacao + timedelta(minutes=intervalo)).strftime('%d/%m/%Y %H:%M:%S') if ultima_verificacao else 'Em breve' }}</p>
            </div>
            
            <div class="card">
                <h2>Estatísticas</h2>
                <div class="stats">
                    <div class="stat-card">
                        <div class="stat-number">{{ estatisticas.verificacoes_realizadas }}</div>
                        <div>Verificações</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">{{ estatisticas.novos_sorteios_processados }}</div>
                        <div>Sorteios Processados</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">{{ estatisticas.automacoes_atualizadas }}</div>
                        <div>Automações Atualizadas</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">{{ estatisticas.erros_encontrados }}</div>
                        <div>Erros</div>
                    </div>
                </div>
                <p><strong>Última Automação:</strong> {{ estatisticas.ultima_automacao or 'Nunca' }}</p>
            </div>
            
            <div class="card">
                <h2>Controles</h2>
                <button class="btn btn-success" onclick="executarVerificacao()">🔍 Executar Verificação Manual</button>
                <button class="btn btn-warning" onclick="testarManychat()">🧪 Testar Conexão Manychat</button>
            </div>
            
            <div class="card">
                <h2>Logs Recentes ({{ logs_sistema|length }} entradas)</h2>
                <div class="logs">
                    {% for log in logs_sistema[-20:] %}
                    <div class="log-entry log-{{ log.nivel.lower() }}">
                        <strong>[{{ log.timestamp }}]</strong> {{ log.mensagem }}
                    </div>
                    {% endfor %}
                </div>
            </div>
        </div>
    </body>
    </html>
    """
    
    return render_template_string(template, 
        sistema_ativo=sistema_ativo,
        ultima_verificacao=ultima_verificacao,
        intervalo=INTERVALO_VERIFICACAO,
        estatisticas=estatisticas,
        logs_sistema=logs_sistema,
        timedelta=timedelta
    )

@app.route('/api/status')
def api_status():
    """Retorna status do sistema"""
    return jsonify({
        'sistema_ativo': sistema_ativo,
        'ultima_verificacao': ultima_verificacao.isoformat() if ultima_verificacao else None,
        'estatisticas': estatisticas,
        'configuracoes': {
            'intervalo_verificacao': INTERVALO_VERIFICACAO,
            'automacoes_configuradas': len([url for url in AUTOMACOES_URLS.values() if not url.startswith('URL_DA_AUTOMACAO')]),
            'modo_simulacao': SIMULAR_ATUALIZACOES
        }
    })

@app.route('/api/executar-verificacao', methods=['POST'])
def api_executar_verificacao():
    """Executa verificação manual do sistema"""
    try:
        sucesso = executar_verificacao_sistema()
        return jsonify({
            'sucesso': sucesso,
            'timestamp': datetime.now().isoformat(),
            'mensagem': 'Verificação executada com sucesso' if sucesso else 'Erro na verificação'
        })
    except Exception as e:
        return jsonify({
            'sucesso': False,
            'erro': str(e)
        }), 500

@app.route('/api/testar-manychat', methods=['POST'])
def api_testar_manychat():
    """Testa conexão com Manychat"""
    try:
        if SIMULAR_ATUALIZACOES:
            return jsonify({
                'sucesso': True,
                'mensagem': 'Modo simulação - teste simulado'
            })
        
        with SeleniumManager() as selenium:
            sessao_ativa = selenium.verificar_sessao_ativa()
            
            return jsonify({
                'sucesso': sessao_ativa,
                'mensagem': 'Sessão Manychat ativa' if sessao_ativa else 'Sessão expirada - necessário login'
            })
            
    except Exception as e:
        return jsonify({
            'sucesso': False,
            'erro': str(e)
        }), 500

@app.route('/api/login-manychat', methods=['POST'])
def api_login_manychat():
    """Endpoint para login no Manychat (implementação futura)"""
    return jsonify({
        'sucesso': False,
        'mensagem': 'Login manual necessário - acesse Manychat no navegador e faça login'
    })

@app.route('/api/logs')
def api_logs():
    """Retorna logs do sistema"""
    return jsonify({
        'logs': logs_sistema[-100:],  # Últimos 100 logs
        'total': len(logs_sistema)
    })

@app.route('/api/status-sheets')
def api_status_sheets():
    """Testa conexão com Google Sheets"""
    try:
        monitor = GoogleSheetsMonitor()
        sucesso = monitor.testar_conexao()
        
        return jsonify({
            'sucesso': sucesso,
            'mensagem': 'Conexão Google Sheets OK' if sucesso else 'Erro na conexão'
        })
        
    except Exception as e:
        return jsonify({
            'sucesso': False,
            'erro': str(e)
        }), 500

# ================================
# ROTAS ORIGINAIS DO SISTEMA (PRESERVADAS)
# ================================

@app.route('/webhook', methods=['POST'])
def webhook():
    """Webhook original do sistema - preservado"""
    try:
        data = request.get_json()
        adicionar_log('INFO', f"📡 Webhook recebido: {data}")
        
        # Aqui você pode adicionar a lógica original do webhook
        # Mantendo compatibilidade com o sistema existente
        
        return jsonify({'status': 'success', 'message': 'Webhook processado'})
        
    except Exception as e:
        adicionar_log('ERROR', f"❌ Erro no webhook: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/sorteios', methods=['GET'])
def api_sorteios():
    """API para listar sorteios - preservada/expandida"""
    try:
        monitor = GoogleSheetsMonitor()
        if not monitor.inicializar_conexao():
            return jsonify({'erro': 'Falha na conexão Google Sheets'}), 500
        
        dados = monitor.obter_dados_sorteios()
        return jsonify({
            'sorteios': dados,
            'total': len(dados)
        })
        
    except Exception as e:
        return jsonify({'erro': str(e)}), 500

# ================================
# INICIALIZAÇÃO DO SISTEMA
# ================================

def inicializar_sistema():
    """Inicializa o sistema completo"""
    try:
        # Valida configurações
        erros_config = validar_configuracoes()
        if erros_config:
            for erro in erros_config:
                adicionar_log('ERROR', f"❌ Configuração: {erro}")
            return False
        
        # Testa conexões
        adicionar_log('INFO', "🔍 Testando conexões...")
        
        # Testa Google Sheets
        monitor = GoogleSheetsMonitor()
        if not monitor.testar_conexao():
            adicionar_log('ERROR', "❌ Falha na conexão Google Sheets")
            return False
        
        adicionar_log('INFO', "✅ Google Sheets conectado")
        
        # Testa Selenium (se não estiver em modo simulação)
        if not SIMULAR_ATUALIZACOES:
            try:
                with SeleniumManager() as selenium:
                    adicionar_log('INFO', "✅ Selenium inicializado")
            except Exception as e:
                adicionar_log('WARNING', f"⚠️ Selenium não disponível: {e}")
        
        # Inicia monitoramento
        iniciar_monitoramento()
        
        # Executa primeira verificação
        executar_verificacao_sistema()
        
        return True
        
    except Exception as e:
        adicionar_log('ERROR', f"❌ Erro na inicialização: {e}")
        return False

# ================================
# PONTO DE ENTRADA
# ================================

if __name__ == '__main__':
    print("🚀 Iniciando Sistema de Automação Manychat + Sorteios...")
    
    if inicializar_sistema():
        print("✅ Sistema inicializado com sucesso!")
        print(f"🌐 Dashboard: http://localhost:{FLASK_PORT}")
        print(f"📊 API Status: http://localhost:{FLASK_PORT}/api/status")
        
        # Inicia servidor Flask
        app.run(
            host=FLASK_HOST,
            port=FLASK_PORT,
            debug=FLASK_DEBUG,
            threaded=True
        )
    else:
        print("❌ Falha na inicialização do sistema!")
        exit(1)

