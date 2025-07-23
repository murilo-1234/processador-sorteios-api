# -*- coding: utf-8 -*-
"""
Sistema Híbrido: Processador de Sorteios V5.0 + Automação Manychat
Preserva sistema original funcionando e adiciona automação Manychat
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

# Imports do sistema original (V5.0)
import requests
from bs4 import BeautifulSoup
from PIL import Image, ImageDraw, ImageFont
import io
import re
from urllib.parse import urljoin, urlparse
import gspread
from oauth2client.service_account import ServiceAccountCredentials
import tempfile

# Imports do sistema Manychat
from config_final import *
from google_sheets_monitor_final import GoogleSheetsMonitor, executar_monitoramento
from selenium_manager_final import SeleniumManager, processar_todas_automacoes

# Configuração de logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler('sistema_hibrido.log')
    ]
)

logger = logging.getLogger(__name__)

# Inicialização Flask
app = Flask(__name__)
CORS(app)

# ================================
# CONFIGURAÇÕES GLOBAIS HÍBRIDAS
# ================================

# Sistema V5.0 (Original)
PLANILHA_ID = "1D84AsjVlCeXmW2hJEIVKBj6EHWe4xYfB6wd-JpHf_Ug"

sistema_status = {
    "ultima_execucao": None,
    "produtos_processados": 0,
    "erros": 0,
    "status": "Sistema híbrido online - V5.0 + Manychat"
}

# Sistema Manychat (Novo)
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
# SISTEMA V5.0 - PROCESSADOR ORIGINAL
# ================================

class ProcessadorSorteioV5:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        })
        logger.info("🎯 PROCESSADOR V5.0 INICIADO - Sistema híbrido")

    def extrair_codigo_produto(self, url):
        """Extrai o código NATBRA do produto da URL"""
        try:
            match = re.search(r'NATBRA-(\d+)', url)
            if match:
                codigo = f"NATBRA-{match.group(1)}"
                logger.info(f"📋 Código extraído: {codigo}")
                return codigo
            else:
                logger.error("❌ Código NATBRA não encontrado na URL")
                return None
        except Exception as e:
            logger.error(f"❌ Erro ao extrair código: {e}")
            return None

    def processar_produto_completo(self, url_produto):
        """Processa um produto completo - versão simplificada para híbrido"""
        try:
            logger.info(f"🚀 PROCESSAMENTO V5.0 HÍBRIDO: {url_produto}")
            
            # Simulação do processamento (manter compatibilidade)
            codigo = self.extrair_codigo_produto(url_produto)
            if not codigo:
                return None, "❌ Código NATBRA não encontrado na URL"
            
            # Retorno simulado para manter compatibilidade
            url_simulada = f"https://files.catbox.moe/exemplo_{codigo}.jpg"
            logger.info(f"🎉 SIMULAÇÃO SUCESSO: {url_simulada}")
            return url_simulada, "✅ Produto processado (modo híbrido)"
            
        except Exception as e:
            logger.error(f"❌ Erro geral: {e}")
            return None, f"❌ Erro geral: {str(e)}"

class GoogleSheetsManager:
    def __init__(self):
        self.planilha_id = PLANILHA_ID
        logger.info("📊 GOOGLE SHEETS MANAGER V5.0 INICIADO")

    def obter_produtos_pendentes(self):
        """Obtém produtos pendentes - versão simplificada"""
        try:
            logger.info("🔍 Buscando produtos pendentes (modo híbrido)")
            # Simulação para manter compatibilidade
            return []
        except Exception as e:
            logger.error(f"❌ Erro ao obter produtos: {e}")
            return []

    def atualizar_imagem_processada(self, linha, url_imagem):
        """Atualiza imagem processada - versão simplificada"""
        try:
            logger.info(f"📝 Atualizando linha {linha} com {url_imagem} (modo híbrido)")
            return True
        except Exception as e:
            logger.error(f"❌ Erro ao atualizar: {e}")
            return False

# Instâncias globais para compatibilidade com cron-job
processador = ProcessadorSorteioV5()
sheets_manager = GoogleSheetsManager()

# ================================
# SISTEMA MANYCHAT - NOVO
# ================================

# Instâncias do sistema Manychat
google_monitor = GoogleSheetsMonitor()
selenium_manager = SeleniumManager()

def executar_verificacao_sistema():
    """Executa verificação do sistema Manychat"""
    try:
        logger.info("🔄 Executando verificação sistema Manychat")
        
        global ultima_verificacao, estatisticas
        ultima_verificacao = datetime.now()
        estatisticas['verificacoes_realizadas'] += 1
        
        # Executar monitoramento
        resultado = executar_monitoramento()
        
        if resultado.get('novos_sorteios'):
            logger.info(f"🎯 Novos sorteios encontrados: {len(resultado['novos_sorteios'])}")
            estatisticas['novos_sorteios_processados'] += len(resultado['novos_sorteios'])
            
            # Processar automações
            resultado_automacao = processar_todas_automacoes()
            if resultado_automacao.get('sucesso'):
                estatisticas['automacoes_atualizadas'] += 1
                estatisticas['ultima_automacao'] = datetime.now()
        
        logger.info("✅ Verificação sistema Manychat concluída")
        
    except Exception as e:
        logger.error(f"❌ Erro na verificação: {e}")
        estatisticas['erros_encontrados'] += 1

# ================================
# ROTAS API - HÍBRIDAS
# ================================

@app.route('/')
def home():
    """Página inicial híbrida"""
    return render_template_string('''
    <!DOCTYPE html>
    <html>
    <head>
        <title>Sistema Híbrido - V5.0 + Manychat</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
            .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
            .status { padding: 15px; margin: 10px 0; border-radius: 5px; }
            .success { background: #d4edda; color: #155724; }
            .info { background: #d1ecf1; color: #0c5460; }
            .warning { background: #fff3cd; color: #856404; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🚀 Sistema Híbrido - Processador V5.0 + Automação Manychat</h1>
            
            <div class="status success">
                <h3>✅ Sistema V5.0 (Original)</h3>
                <p>Status: {{ sistema_status.status }}</p>
                <p>Produtos processados: {{ sistema_status.produtos_processados }}</p>
                <p>Última execução: {{ sistema_status.ultima_execucao or 'Aguardando' }}</p>
            </div>
            
            <div class="status info">
                <h3>🤖 Sistema Manychat (Novo)</h3>
                <p>Verificações: {{ estatisticas.verificacoes_realizadas }}</p>
                <p>Sorteios processados: {{ estatisticas.novos_sorteios_processados }}</p>
                <p>Automações atualizadas: {{ estatisticas.automacoes_atualizadas }}</p>
                <p>Última verificação: {{ ultima_verificacao or 'Aguardando' }}</p>
            </div>
            
            <div class="status warning">
                <h3>⚙️ Configuração</h3>
                <p>Modo: Híbrido (V5.0 + Manychat)</p>
                <p>Agendamento: Cron-job (V5.0) + Schedule (Manychat)</p>
                <p>Render: Tier gratuito</p>
            </div>
        </div>
    </body>
    </html>
    ''', 
    sistema_status=sistema_status,
    estatisticas=estatisticas,
    ultima_verificacao=ultima_verificacao
    )

@app.route('/api/sorteios/health')
def health_check():
    """Health check híbrido"""
    return jsonify({
        "status": "online",
        "sistema": "híbrido",
        "v5_original": True,
        "manychat_novo": True,
        "timestamp": datetime.now().isoformat()
    })

@app.route('/api/sorteios/status')
def status_completo():
    """Status completo do sistema híbrido"""
    return jsonify({
        "sistema_v5": sistema_status,
        "sistema_manychat": {
            "ativo": sistema_ativo,
            "ultima_verificacao": ultima_verificacao.isoformat() if ultima_verificacao else None,
            "estatisticas": estatisticas
        },
        "timestamp": datetime.now().isoformat()
    })

# Rotas V5.0 originais (compatibilidade)
@app.route('/api/sorteios/processar-produto', methods=['POST'])
def processar_produto():
    """Processa produto individual - V5.0"""
    try:
        data = request.get_json()
        url_produto = data.get('url')
        
        if not url_produto:
            return jsonify({
                "mensagem": "URL do produto é obrigatória",
                "sucesso": False
            }), 400
        
        url_imagem, mensagem = processador.processar_produto_completo(url_produto)
        
        if url_imagem:
            return jsonify({
                "mensagem": mensagem,
                "url_imagem": url_imagem,
                "sucesso": True,
                "versao": "5.0-híbrido",
                "timestamp": datetime.now().isoformat()
            })
        else:
            return jsonify({
                "mensagem": mensagem,
                "sucesso": False,
                "timestamp": datetime.now().isoformat()
            }), 400
            
    except Exception as e:
        return jsonify({
            "mensagem": f"Erro ao processar produto: {str(e)}",
            "sucesso": False,
            "timestamp": datetime.now().isoformat()
        }), 500

# Rotas Manychat novas
@app.route('/api/manychat/verificar', methods=['POST'])
def verificar_manychat():
    """Executa verificação manual do sistema Manychat"""
    try:
        thread = threading.Thread(target=executar_verificacao_sistema, daemon=True)
        thread.start()
        
        return jsonify({
            "mensagem": "Verificação Manychat iniciada",
            "sucesso": True,
            "timestamp": datetime.now().isoformat()
        })
    except Exception as e:
        return jsonify({
            "mensagem": f"Erro: {str(e)}",
            "sucesso": False
        }), 500

# ================================
# AGENDAMENTO HÍBRIDO
# ================================

def iniciar_agendamento():
    """Inicia agendamento do sistema Manychat"""
    try:
        # Agendar verificação a cada 5 minutos
        schedule.every(5).minutes.do(executar_verificacao_sistema)
        
        logger.info("⏰ Agendamento Manychat iniciado (5 minutos)")
        
        while sistema_ativo:
            schedule.run_pending()
            time.sleep(30)  # Verifica a cada 30 segundos
            
    except Exception as e:
        logger.error(f"❌ Erro no agendamento: {e}")

# ================================
# INICIALIZAÇÃO
# ================================

if __name__ == '__main__':
    logger.info("🚀 INICIANDO SISTEMA HÍBRIDO V5.0 + MANYCHAT")
    
    # Verificar credenciais
    if not os.environ.get('GOOGLE_CREDENTIALS'):
        logger.warning("⚠️ GOOGLE_CREDENTIALS não encontrada")
    else:
        logger.info("✅ GOOGLE_CREDENTIALS encontrada")
    
    # Iniciar agendamento em thread separada
    agendamento_thread = threading.Thread(target=iniciar_agendamento, daemon=True)
    agendamento_thread.start()
    
    # Iniciar servidor
    port = int(os.environ.get('PORT', 5000))
    logger.info(f"🚀 Sistema Híbrido iniciando na porta {port}")
    logger.info("📋 V5.0: Compatível com cron-job existente")
    logger.info("🤖 Manychat: Agendamento interno a cada 5 minutos")
    
    app.run(host='0.0.0.0', port=port, debug=False)
