# -*- coding: utf-8 -*-
"""
Configurações do Sistema de Automação Manychat + Google Sheets
"""

import os
from datetime import datetime

# ================================
# CONFIGURAÇÕES GOOGLE SHEETS
# ================================

# Planilha principal de sorteios
PLANILHA_SORTEIOS_ID = "1D84AsjVlCeXmW2hJEIVKBj6EHWe4xYfB6wd-JpHf_Ug"
PLANILHA_SORTEIOS_URL = f"https://docs.google.com/spreadsheets/d/{PLANILHA_SORTEIOS_ID}/edit"

# Planilha template de participantes
PLANILHA_TEMPLATE_ID = "1VWbKvHQt7MP3WAkGLLgV3mKRa3xyBwglFoqDkF3QQaE"
PLANILHA_TEMPLATE_URL = f"https://docs.google.com/spreadsheets/d/{PLANILHA_TEMPLATE_ID}/edit"

# Credenciais Google
GOOGLE_CREDENTIALS_PATH = os.getenv('GOOGLE_CREDENTIALS_PATH', 'credentials.json')

# ================================
# CONFIGURAÇÕES MANYCHAT
# ================================

# Token da API Manychat (para verificações) — removido do código por segurança (2026-06-10); usar ENV se voltar a usar
MANYCHAT_API_TOKEN = os.environ.get("MANYCHAT_API_TOKEN", "")

# URLs das automações (CONFIGURAR COM AS URLs REAIS)
AUTOMACOES_URLS = {
    'instagram': 'https://app.manychat.com/fb1066870/cms/files/content20250711132911_351235/edit',
    'facebook': 'https://app.manychat.com/fb1066870/cms/files/content20250720172834_901322/edit',
    'whatsapp': 'https://app.manychat.com/fb1066870/cms/files/content20250720172901_269298/edit'
}

# ================================
# TEXTOS DOS BLOCOS (BUSCA POR TEXTO)
# ================================

# Textos para localizar blocos condicionais
BLOCOS_CONDICIONAIS = {
    'dia_sorteio': ['Dia Sorteio', 'Dia sorteio', 'Dia do Sorteio', 'Dia do sorteio'],
    'dia_sorteio_menos_1': ['Dia Sorteio -1', 'Dia sorteio -1', 'Dia do Sorteio -1', 'Dia do sorteio -1'],
    'dia_sorteio_menos_2': ['Dia Sorteio -2', 'Dia sorteio -2', 'Dia do Sorteio -2', 'Dia do sorteio -2'],
    'dia_sorteio_menos_3': ['Dia Sorteio -3', 'Dia sorteio -3', 'Dia do Sorteio -3', 'Dia do sorteio -3']
}

# Textos para localizar blocos de planilha
BLOCOS_PLANILHA = ['Planilha', 'planilha', 'Google Planilhas', 'Google Sheets']

# Textos para localizar blocos de ação
BLOCOS_ACAO = ['Ações - Id Sorteio', 'Ação - Id Sorteio', 'Id Sorteio', 'Ações Id Sorteio']

# ================================
# MAPEAMENTOS GOOGLE SHEETS
# ================================

# Campos fixos (iguais em todas as automações)
CAMPOS_FIXOS_MAPEAMENTO = {
    "Nome Completo": "Nome Completo",
    "ID do contato": "Código de Sorteio",
    "Username do Instagram": "Início Instagram",
    "ID da Página do Facebook": "Início Facebook"
}

# Campos variáveis por automação
CAMPOS_VARIAVEIS_MAPEAMENTO = {
    'instagram': "Data - Instagram",
    'facebook': "Data - Facebook",
    'whatsapp': "Data - Whatsapp"
}

# Coluna de destino no Google Sheets
COLUNA_DESTINO_VARIAVEL = "Acesso"

# ================================
# CONFIGURAÇÕES SELENIUM
# ================================

# Configurações do Chrome
CHROME_OPTIONS = [
    '--headless',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1920,1080',
    '--disable-extensions',
    '--disable-plugins',
    '--disable-images',
    '--disable-javascript',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
]

# Diretório para dados do usuário (sessão)
CHROME_USER_DATA_DIR = '/tmp/chrome-user-data'

# Timeouts
SELENIUM_TIMEOUT = 30
SELENIUM_IMPLICIT_WAIT = 10

# ================================
# CONFIGURAÇÕES DO SISTEMA
# ================================

# Intervalo de verificação (em minutos)
INTERVALO_VERIFICACAO = 5

# Configurações de log
LOG_LEVEL = 'INFO'
LOG_FORMAT = '[%(asctime)s] %(levelname)s: %(message)s'
LOG_MAX_LINES = 1000

# Configurações Flask
FLASK_HOST = '0.0.0.0'
FLASK_PORT = int(os.getenv('PORT', 5000))
FLASK_DEBUG = os.getenv('FLASK_DEBUG', 'false').lower() == 'true'

# ================================
# CONFIGURAÇÕES DE NOTIFICAÇÃO
# ================================

# Email para notificações (opcional)
EMAIL_NOTIFICACAO = os.getenv('EMAIL_NOTIFICACAO', '')

# Webhook para notificações (opcional)
WEBHOOK_NOTIFICACAO = os.getenv('WEBHOOK_NOTIFICACAO', '')

# ================================
# SELETORES SELENIUM ALTERNATIVOS
# ================================

# Múltiplos seletores para maior robustez
SELETORES_BLOCO = [
    "//div[contains(text(), '{}')]",
    "//span[contains(text(), '{}')]",
    "//button[contains(text(), '{}')]",
    "//a[contains(text(), '{}')]",
    "//*[contains(@class, 'block') and contains(text(), '{}')]",
    "//*[contains(@class, 'card') and contains(text(), '{}')]"
]

# Seletores para campos de data
SELETORES_CAMPO_DATA = [
    "//input[@type='date']",
    "//input[contains(@class, 'date')]",
    "//input[contains(@placeholder, 'data')]",
    "//input[contains(@placeholder, 'Data')]"
]

# Seletores para campos de texto
SELETORES_CAMPO_TEXTO = [
    "//input[@type='text']",
    "//textarea",
    "//input[not(@type)]",
    "//*[@contenteditable='true']"
]

# Seletores para botões de salvar
SELETORES_BOTAO_SALVAR = [
    "//button[contains(text(), 'Salvar')]",
    "//button[contains(text(), 'Save')]",
    "//button[contains(@class, 'save')]",
    "//input[@type='submit']"
]

# ================================
# CONFIGURAÇÕES DE RETRY
# ================================

# Número máximo de tentativas
MAX_RETRIES = 3

# Delay entre tentativas (segundos)
RETRY_DELAY = 5

# ================================
# MENSAGENS DO SISTEMA
# ================================

MENSAGENS = {
    'sistema_iniciado': '🚀 Sistema de automação Manychat iniciado',
    'verificacao_iniciada': '🔍 Iniciando verificação de sorteios',
    'sorteio_finalizado': '🎯 Sorteio finalizado detectado: {}',
    'proximo_sorteio': '📅 Próximo sorteio: {} em {}',
    'automacao_iniciada': '🤖 Iniciando automação para {}',
    'bloco_atualizado': '✏️ Bloco "{}" atualizado com sucesso',
    'automacao_concluida': '✅ Automação {} concluída com sucesso',
    'erro_sessao': '🚨 Sessão Manychat expirada - necessário novo login',
    'erro_bloco': '❌ Erro ao atualizar bloco: {}',
    'sistema_pausado': '⏸️ Sistema pausado devido a erro crítico'
}

# ================================
# VALIDAÇÕES
# ================================

def validar_configuracoes():
    """Valida se todas as configurações necessárias estão presentes"""
    erros = []
    
    # Verifica credenciais Google
    if not os.path.exists(GOOGLE_CREDENTIALS_PATH):
        erros.append(f"Arquivo de credenciais não encontrado: {GOOGLE_CREDENTIALS_PATH}")
    
    # Verifica URLs das automações
    for plataforma, url in AUTOMACOES_URLS.items():
        if url.startswith('URL_DA_AUTOMACAO'):
            erros.append(f"URL da automação {plataforma} não configurada")
    
    return erros

# ================================
# FUNÇÕES AUXILIARES
# ================================

def obter_timestamp():
    """Retorna timestamp atual formatado"""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def formatar_data_brasileira(data):
    """Formata data no padrão brasileiro DD/MM/YYYY"""
    if isinstance(data, str):
        return data
    return data.strftime("%d/%m/%Y")

def formatar_hora_brasileira(hora):
    """Formata hora no padrão brasileiro HH:MM"""
    if isinstance(hora, str):
        return hora
    return hora.strftime("%H:%M")

# ================================
# CONFIGURAÇÕES DE DESENVOLVIMENTO
# ================================

# Modo debug (desabilita Selenium em desenvolvimento)
DEBUG_MODE = os.getenv('DEBUG_MODE', 'false').lower() == 'true'

# Simular atualizações (para testes)
SIMULAR_ATUALIZACOES = os.getenv('SIMULAR_ATUALIZACOES', 'false').lower() == 'true'

if __name__ == "__main__":
    # Testa configurações
    erros = validar_configuracoes()
    if erros:
        print("❌ Erros de configuração encontrados:")
        for erro in erros:
            print(f"  - {erro}")
    else:
        print("✅ Todas as configurações estão válidas")

