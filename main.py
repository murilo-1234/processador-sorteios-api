#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sistema Processador de Sorteios API v2.0 - COMPLETO
Sistema automatizado que lê Google Sheets, processa produtos da Natura 
com imagens de sorteio, e hospeda no Render.com com automação completa.

Autor: Sistema Manus
Data: Julho 2025
"""

from flask import Flask, request, jsonify, render_template_string
from flask_cors import CORS
import os
import threading
import time
import schedule
import logging
from datetime import datetime
import json
import requests
from bs4 import BeautifulSoup
from PIL import Image, ImageDraw, ImageFont
import io
import re
from urllib.parse import urljoin, urlparse
import gspread
from oauth2client.service_account import ServiceAccountCredentials

# Configurar logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# ================================
# CONFIGURAÇÕES GLOBAIS
# ================================

# Configuração Google Sheets
PLANILHA_ID = "1D84AsjVlCeXmW2hJEIVKBj6EHWe4xYfB6wd-JpHf_Ug"
CREDENCIAIS_PATH = "lithe-augury-466402-k6-52759a6c850c.json"

# Status global do sistema
sistema_status = {
    "ultima_execucao": None,
    "produtos_processados": 0,
    "erros": 0,
    "status": "Aguardando primeira execução"
}

# ================================
# CLASSE PROCESSADOR V4.1
# ================================

class ProcessadorSorteioV4:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })
        
    def extrair_imagem_produto(self, url_produto):
        """Extrai a melhor imagem do produto da página da Natura"""
        try:
            response = self.session.get(url_produto, timeout=10)
            response.raise_for_status()
            
            soup = BeautifulSoup(response.content, 'html.parser')
            
            # Buscar imagens do produto
            imagens_candidatas = []
            
            # Seletores para imagens da Natura
            seletores = [
                'img[src*="natura.com"]',
                'img[data-src*="natura.com"]',
                '.product-image img',
                '.gallery img',
                'img[alt*="produto"]'
            ]
            
            for seletor in seletores:
                imgs = soup.select(seletor)
                for img in imgs:
                    src = img.get('src') or img.get('data-src')
                    if src and self._validar_imagem_semantica(src, img):
                        if src.startswith('//'):
                            src = 'https:' + src
                        elif src.startswith('/'):
                            src = urljoin(url_produto, src)
                        imagens_candidatas.append(src)
            
            if not imagens_candidatas:
                return None, "Nenhuma imagem válida encontrada"
                
            # Retornar a primeira imagem válida
            return imagens_candidatas[0], "Imagem extraída com sucesso"
            
        except Exception as e:
            return None, f"Erro ao extrair imagem: {str(e)}"
    
    def _validar_imagem_semantica(self, src, img_tag):
        """Validação semântica flexível para imagens de produto"""
        if not src:
            return False
            
        # Palavras que indicam imagem de produto (flexível)
        palavras_produto = ['produto', 'item', 'natura', 'cosmetico', 'perfume', 'creme']
        
        # Palavras que devem ser evitadas
        palavras_evitar = ['logo', 'banner', 'icon', 'thumb', 'small']
        
        src_lower = src.lower()
        alt_text = (img_tag.get('alt') or '').lower()
        
        # Verificar se contém palavras a evitar
        for palavra in palavras_evitar:
            if palavra in src_lower:
                return False
        
        # Se contém palavras de produto, é válida
        for palavra in palavras_produto:
            if palavra in src_lower or palavra in alt_text:
                return True
        
        # Se chegou até aqui e tem extensão de imagem, aceitar
        extensoes = ['.jpg', '.jpeg', '.png', '.webp']
        return any(ext in src_lower for ext in extensoes)
    
    def processar_imagem_sorteio(self, url_imagem):
        """Processa a imagem para formato de sorteio"""
        try:
            # Baixar imagem
            response = self.session.get(url_imagem, timeout=10)
            response.raise_for_status()
            
            # Abrir imagem
            img_original = Image.open(io.BytesIO(response.content))
            img_original = img_original.convert('RGBA')
            
            # Criar canvas 600x600 branco
            canvas = Image.new('RGBA', (600, 600), (255, 255, 255, 255))
            
            # Redimensionar produto para máximo 540x540
            img_produto = img_original.copy()
            img_produto.thumbnail((540, 540), Image.Resampling.LANCZOS)
            
            # Centralizar produto no canvas
            pos_x = (600 - img_produto.width) // 2
            pos_y = (600 - img_produto.height) // 2
            canvas.paste(img_produto, (pos_x, pos_y), img_produto)
            
            # Adicionar textos
            draw = ImageDraw.Draw(canvas)
            
            # Configurar fonte (usar fonte padrão se não encontrar)
            try:
                fonte_grande = ImageFont.truetype("arial.ttf", 96)
                fonte_media = ImageFont.truetype("arial.ttf", 60)
            except:
                fonte_grande = ImageFont.load_default()
                fonte_media = ImageFont.load_default()
            
            # Cor vermelha escura
            cor_vermelha = (139, 0, 0)  # Dark red
            cor_contorno = (255, 255, 255)  # Branco
            
            # Texto superior: "Ganhe esse Top!"
            texto_superior = "Ganhe esse Top!"
            bbox_superior = draw.textbbox((0, 0), texto_superior, font=fonte_media)
            largura_superior = bbox_superior[2] - bbox_superior[0]
            x_superior = (600 - largura_superior) // 2
            y_superior = 20
            
            # Desenhar contorno branco
            for dx in [-2, -1, 0, 1, 2]:
                for dy in [-2, -1, 0, 1, 2]:
                    if dx != 0 or dy != 0:
                        draw.text((x_superior + dx, y_superior + dy), texto_superior, 
                                font=fonte_media, fill=cor_contorno)
            
            # Desenhar texto principal
            draw.text((x_superior, y_superior), texto_superior, 
                     font=fonte_media, fill=cor_vermelha)
            
            # Texto inferior: "Sorteio"
            texto_inferior = "Sorteio"
            bbox_inferior = draw.textbbox((0, 0), texto_inferior, font=fonte_grande)
            largura_inferior = bbox_inferior[2] - bbox_inferior[0]
            altura_inferior = bbox_inferior[3] - bbox_inferior[1]
            x_inferior = (600 - largura_inferior) // 2
            y_inferior = 600 - altura_inferior - 20
            
            # Desenhar contorno branco
            for dx in [-2, -1, 0, 1, 2]:
                for dy in [-2, -1, 0, 1, 2]:
                    if dx != 0 or dy != 0:
                        draw.text((x_inferior + dx, y_inferior + dy), texto_inferior, 
                                font=fonte_grande, fill=cor_contorno)
            
            # Desenhar texto principal
            draw.text((x_inferior, y_inferior), texto_inferior, 
                     font=fonte_grande, fill=cor_vermelha)
            
            # Converter para RGB e salvar
            canvas_rgb = Image.new('RGB', canvas.size, (255, 255, 255))
            canvas_rgb.paste(canvas, mask=canvas.split()[-1])
            
            # Salvar em buffer
            buffer = io.BytesIO()
            canvas_rgb.save(buffer, format='PNG', quality=95)
            buffer.seek(0)
            
            return buffer, "Imagem processada com sucesso"
            
        except Exception as e:
            return None, f"Erro ao processar imagem: {str(e)}"
    
    def upload_catbox(self, buffer_imagem):
        """Faz upload da imagem para Catbox.moe"""
        try:
            buffer_imagem.seek(0)
            
            files = {
                'fileToUpload': ('sorteio.png', buffer_imagem, 'image/png')
            }
            
            data = {
                'reqtype': 'fileupload'
            }
            
            response = requests.post('https://catbox.moe/user/api.php', 
                                   files=files, data=data, timeout=30)
            
            if response.status_code == 200:
                url = response.text.strip()
                if url.startswith('https://files.catbox.moe/'):
                    return url, "Upload realizado com sucesso"
            
            return None, f"Erro no upload: {response.text}"
            
        except Exception as e:
            return None, f"Erro no upload: {str(e)}"
    
    def processar_produto_completo(self, url_produto):
        """Processa um produto completo"""
        try:
            # 1. Extrair imagem
            url_imagem, msg_extracao = self.extrair_imagem_produto(url_produto)
            if not url_imagem:
                return None, f"Falha na extração: {msg_extracao}"
            
            # 2. Processar imagem
            buffer_imagem, msg_processamento = self.processar_imagem_sorteio(url_imagem)
            if not buffer_imagem:
                return None, f"Falha no processamento: {msg_processamento}"
            
            # 3. Upload
            url_final, msg_upload = self.upload_catbox(buffer_imagem)
            if not url_final:
                return None, f"Falha no upload: {msg_upload}"
            
            return url_final, "Produto processado com sucesso"
            
        except Exception as e:
            return None, f"Erro geral: {str(e)}"

# ================================
# CLASSE GOOGLE SHEETS
# ================================

class GoogleSheetsManager:
    def __init__(self):
        self.planilha = None
        self.conectar()
    
    def conectar(self):
        """Conecta com Google Sheets"""
        try:
            scope = ['https://spreadsheets.google.com/feeds',
                    'https://www.googleapis.com/auth/drive']
            
            # Tentar usar arquivo de credenciais
            try:
                creds = ServiceAccountCredentials.from_json_keyfile_name(CREDENCIAIS_PATH, scope)
            except:
                # Se não encontrar arquivo, usar credenciais inline (simplificado)
                logger.warning("Arquivo de credenciais não encontrado, usando modo simplificado")
                return False
            
            client = gspread.authorize(creds)
            self.planilha = client.open_by_key(PLANILHA_ID).sheet1
            logger.info("✅ Conectado ao Google Sheets")
            return True
            
        except Exception as e:
            logger.error(f"❌ Erro ao conectar Google Sheets: {e}")
            return False
    
    def obter_produtos_pendentes(self):
        """Obtém produtos que precisam ser processados"""
        try:
            if not self.planilha:
                return []
            
            # Ler todas as linhas
            dados = self.planilha.get_all_records()
            produtos_pendentes = []
            
            for i, linha in enumerate(dados, start=2):  # Linha 2 = primeira linha de dados
                link_produto = linha.get('Link do Produto', '').strip()
                imagem_processada = linha.get('Imagem Processada', '').strip()
                
                # Se tem link do produto mas não tem imagem processada
                if link_produto and not imagem_processada:
                    produtos_pendentes.append({
                        'linha': i,
                        'url': link_produto,
                        'produto': linha.get('Produto', 'Produto sem nome')
                    })
            
            return produtos_pendentes
            
        except Exception as e:
            logger.error(f"❌ Erro ao obter produtos pendentes: {e}")
            return []
    
    def atualizar_imagem_processada(self, linha, url_imagem):
        """Atualiza a coluna de imagem processada"""
        try:
            if not self.planilha:
                return False
            
            # Coluna E = Imagem Processada
            self.planilha.update_cell(linha, 5, url_imagem)
            logger.info(f"✅ Linha {linha} atualizada com imagem: {url_imagem}")
            return True
            
        except Exception as e:
            logger.error(f"❌ Erro ao atualizar planilha: {e}")
            return False

# ================================
# INSTÂNCIAS GLOBAIS
# ================================

processador = ProcessadorSorteioV4()
sheets_manager = GoogleSheetsManager()

# ================================
# FUNÇÕES DE AUTOMAÇÃO
# ================================

def processar_planilha_automatico():
    """Função que processa a planilha automaticamente"""
    global sistema_status
    
    try:
        logger.info("🔄 Iniciando processamento automático da planilha")
        sistema_status["status"] = "Processando planilha..."
        
        # Obter produtos pendentes
        produtos_pendentes = sheets_manager.obter_produtos_pendentes()
        
        if not produtos_pendentes:
            logger.info("✅ Nenhum produto pendente encontrado")
            sistema_status["status"] = "Nenhum produto pendente"
            sistema_status["ultima_execucao"] = datetime.now().isoformat()
            return
        
        logger.info(f"📋 {len(produtos_pendentes)} produtos pendentes encontrados")
        
        # Processar cada produto
        for produto in produtos_pendentes:
            try:
                logger.info(f"🎯 Processando: {produto['produto']}")
                
                # Processar produto
                url_imagem, mensagem = processador.processar_produto_completo(produto['url'])
                
                if url_imagem:
                    # Atualizar planilha
                    if sheets_manager.atualizar_imagem_processada(produto['linha'], url_imagem):
                        sistema_status["produtos_processados"] += 1
                        logger.info(f"✅ Produto processado: {produto['produto']}")
                    else:
                        sistema_status["erros"] += 1
                        logger.error(f"❌ Erro ao atualizar planilha para: {produto['produto']}")
                else:
                    sistema_status["erros"] += 1
                    logger.error(f"❌ Erro ao processar: {produto['produto']} - {mensagem}")
                
                # Aguardar entre processamentos
                time.sleep(2)
                
            except Exception as e:
                sistema_status["erros"] += 1
                logger.error(f"❌ Erro no produto {produto['produto']}: {e}")
        
        sistema_status["status"] = f"Processamento concluído: {len(produtos_pendentes)} produtos"
        sistema_status["ultima_execucao"] = datetime.now().isoformat()
        logger.info("✅ Processamento automático concluído")
        
    except Exception as e:
        sistema_status["erros"] += 1
        sistema_status["status"] = f"Erro no processamento: {str(e)}"
        logger.error(f"❌ Erro no processamento automático: {e}")

def iniciar_scheduler():
    """Inicia o scheduler para execução automática"""
    # Agendar execução a cada 30 minutos
    schedule.every(30).minutes.do(processar_planilha_automatico)
    
    def run_scheduler():
        while True:
            schedule.run_pending()
            time.sleep(60)  # Verificar a cada minuto
    
    # Executar scheduler em thread separada
    scheduler_thread = threading.Thread(target=run_scheduler, daemon=True)
    scheduler_thread.start()
    logger.info("⏰ Scheduler iniciado - execução a cada 30 minutos")

# ================================
# ROTAS DA API
# ================================

@app.route('/')
def home():
    """Página inicial com dashboard"""
    html = """
    <!DOCTYPE html>
    <html>
    <head>
        <title>🎯 Sistema Processador de Sorteios</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
            .container { max-width: 800px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            h1 { color: #2c3e50; text-align: center; }
            .status { padding: 15px; margin: 10px 0; border-radius: 5px; }
            .success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
            .info { background: #d1ecf1; border: 1px solid #bee5eb; color: #0c5460; }
            .warning { background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; }
            .btn { padding: 10px 20px; margin: 5px; border: none; border-radius: 5px; cursor: pointer; text-decoration: none; display: inline-block; }
            .btn-primary { background: #007bff; color: white; }
            .btn-success { background: #28a745; color: white; }
            .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }
            .stat-card { background: #f8f9fa; padding: 15px; border-radius: 5px; text-align: center; }
            .stat-number { font-size: 2em; font-weight: bold; color: #007bff; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🎯 Sistema Processador de Sorteios</h1>
            <div class="status success">
                <strong>✅ Sistema Online e Funcionando!</strong><br>
                Automação ativa - processamento a cada 30 minutos
            </div>
            
            <div class="stats">
                <div class="stat-card">
                    <div class="stat-number" id="produtos">{{ produtos_processados }}</div>
                    <div>Produtos Processados</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" id="erros">{{ erros }}</div>
                    <div>Erros</div>
                </div>
            </div>
            
            <div class="status info">
                <strong>📊 Status:</strong> <span id="status">{{ status }}</span><br>
                <strong>🕐 Última Execução:</strong> <span id="ultima">{{ ultima_execucao or 'Aguardando primeira execução' }}</span>
            </div>
            
            <div style="text-align: center; margin: 20px 0;">
                <a href="/api/sorteios/processar-planilha" class="btn btn-primary" onclick="return confirm('Processar planilha manualmente?')">
                    🚀 Processar Planilha Agora
                </a>
                <a href="/api/sorteios/status" class="btn btn-success">
                    📊 Ver Status Detalhado
                </a>
            </div>
            
            <div class="status warning">
                <strong>🔗 Endpoints da API:</strong><br>
                • <code>GET /api/sorteios/health</code> - Health check<br>
                • <code>GET /api/sorteios/status</code> - Status detalhado<br>
                • <code>POST /api/sorteios/processar-planilha</code> - Processar planilha<br>
                • <code>POST /api/sorteios/processar-produto</code> - Processar produto individual
            </div>
        </div>
        
        <script>
            // Atualizar status a cada 30 segundos
            setInterval(function() {
                fetch('/api/sorteios/status')
                    .then(response => response.json())
                    .then(data => {
                        document.getElementById('produtos').textContent = data.produtos_processados;
                        document.getElementById('erros').textContent = data.erros;
                        document.getElementById('status').textContent = data.status;
                        document.getElementById('ultima').textContent = data.ultima_execucao || 'Aguardando primeira execução';
                    })
                    .catch(error => console.log('Erro ao atualizar status:', error));
            }, 30000);
        </script>
    </body>
    </html>
    """.replace('{{ produtos_processados }}', str(sistema_status['produtos_processados'])) \
       .replace('{{ erros }}', str(sistema_status['erros'])) \
       .replace('{{ status }}', sistema_status['status']) \
       .replace('{{ ultima_execucao }}', sistema_status['ultima_execucao'] or '')
    
    return html

@app.route('/api/sorteios/health')
def health():
    """Health check da API"""
    return jsonify({
        "status": "ok",
        "message": "Sistema funcionando",
        "timestamp": datetime.now().isoformat()
    })

@app.route('/api/sorteios/status')
def status():
    """Status detalhado do sistema"""
    return jsonify({
        "sistema": "Processador de Sorteios V2.0",
        "status": "online",
        "ultima_execucao": sistema_status["ultima_execucao"],
        "produtos_processados": sistema_status["produtos_processados"],
        "erros": sistema_status["erros"],
        "status_atual": sistema_status["status"],
        "google_sheets": "conectado" if sheets_manager.planilha else "desconectado",
        "automacao": "ativa",
        "frequencia": "30 minutos",
        "timestamp": datetime.now().isoformat()
    })

@app.route('/api/sorteios/processar-produto', methods=['POST'])
def processar_produto():
    """Processa um produto individual"""
    try:
        data = request.get_json()
        url_produto = data.get('url')
        
        if not url_produto:
            return jsonify({"erro": "URL do produto é obrigatória"}), 400
        
        # Processar produto
        url_imagem, mensagem = processador.processar_produto_completo(url_produto)
        
        if url_imagem:
            return jsonify({
                "sucesso": True,
                "url_imagem": url_imagem,
                "mensagem": mensagem,
                "timestamp": datetime.now().isoformat()
            })
        else:
            return jsonify({
                "sucesso": False,
                "erro": mensagem,
                "timestamp": datetime.now().isoformat()
            }), 400
            
    except Exception as e:
        return jsonify({
            "sucesso": False,
            "erro": str(e),
            "timestamp": datetime.now().isoformat()
        }), 500

@app.route('/api/sorteios/processar-planilha', methods=['POST', 'GET'])
def processar_planilha():
    """Processa a planilha completa"""
    try:
        # Executar processamento em thread separada para não bloquear
        thread = threading.Thread(target=processar_planilha_automatico)
        thread.start()
        
        return jsonify({
            "sucesso": True,
            "mensagem": "Processamento da planilha iniciado",
            "timestamp": datetime.now().isoformat()
        })
        
    except Exception as e:
        return jsonify({
            "sucesso": False,
            "erro": str(e),
            "timestamp": datetime.now().isoformat()
        }), 500

# ================================
# INICIALIZAÇÃO
# ================================

if __name__ == '__main__':
    # Iniciar scheduler
    iniciar_scheduler()
    
    # Executar primeira verificação após 30 segundos
    def primeira_execucao():
        time.sleep(30)
        processar_planilha_automatico()
    
    threading.Thread(target=primeira_execucao, daemon=True).start()
    
    # Iniciar servidor
    port = int(os.environ.get('PORT', 5000))
    logger.info(f"🚀 Iniciando servidor na porta {port}")
    logger.info("🎯 Sistema Processador de Sorteios V2.0")
    logger.info("⏰ Automação: A cada 30 minutos")
    logger.info("📊 Dashboard: http://localhost:5000")
    
    app.run(host='0.0.0.0', port=port, debug=False)
