#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sistema Processador de Sorteios API v2.1 - CORRIGIDO
Sistema automatizado que lê Google Sheets, processa produtos da Natura 
com imagens de sorteio, e hospeda no Render.com com automação completa.

CORREÇÃO: Nomes das colunas ajustados para:
- Coluna G: link_produto
- Coluna E: url_imagem_processada

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
# PROCESSADOR DE IMAGENS V4.1
# ================================

class ProcessadorSorteioV4:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })
    
    def validar_produto_natura(self, url):
        """Validação semântica para produtos da Natura"""
        try:
            response = self.session.get(url, timeout=10)
            if response.status_code != 200:
                return False, "URL não acessível"
            
            soup = BeautifulSoup(response.content, 'html.parser')
            texto_pagina = soup.get_text().lower()
            
            # Palavras-chave que indicam produto da Natura
            palavras_natura = [
                'natura', 'ekos', 'tododia', 'chronos', 'mamãe e bebê',
                'humor', 'essencial', 'luna', 'kriska', 'águas'
            ]
            
            # Verificar se pelo menos uma palavra-chave está presente
            for palavra in palavras_natura:
                if palavra in texto_pagina:
                    return True, "Produto da Natura validado"
            
            return False, "Não parece ser um produto da Natura"
            
        except Exception as e:
            return False, f"Erro na validação: {str(e)}"
    
    def extrair_imagem_limpa(self, url):
        """Extrai a melhor imagem do produto"""
        try:
            response = self.session.get(url, timeout=15)
            soup = BeautifulSoup(response.content, 'html.parser')
            
            # Seletores para imagens de produtos
            seletores = [
                'img[data-testid="product-image"]',
                '.product-image img',
                '.main-image img',
                'img[alt*="produto"]',
                'img[src*="product"]',
                '.gallery img',
                'img[class*="zoom"]'
            ]
            
            melhor_img = None
            melhor_score = 0
            
            for seletor in seletores:
                imgs = soup.select(seletor)
                for img in imgs:
                    src = img.get('src') or img.get('data-src')
                    if not src:
                        continue
                    
                    if src.startswith('//'):
                        src = 'https:' + src
                    elif src.startswith('/'):
                        src = urljoin(url, src)
                    
                    # Calcular score da imagem
                    score = 0
                    if any(palavra in src.lower() for palavra in ['product', 'zoom', 'large']):
                        score += 3
                    if 'natura' in src.lower():
                        score += 2
                    if any(formato in src.lower() for formato in ['.jpg', '.png', '.webp']):
                        score += 1
                    
                    if score > melhor_score:
                        melhor_score = score
                        melhor_img = src
            
            if melhor_img:
                return melhor_img, "Imagem extraída com sucesso"
            else:
                return None, "Nenhuma imagem encontrada"
                
        except Exception as e:
            return None, f"Erro ao extrair imagem: {str(e)}"
    
    def baixar_imagem(self, url_imagem):
        """Baixa e processa a imagem"""
        try:
            response = self.session.get(url_imagem, timeout=15)
            if response.status_code != 200:
                return None, "Erro ao baixar imagem"
            
            img = Image.open(io.BytesIO(response.content))
            
            # Converter para RGBA se necessário
            if img.mode != 'RGBA':
                img = img.convert('RGBA')
            
            return img, "Imagem baixada com sucesso"
            
        except Exception as e:
            return None, f"Erro ao baixar imagem: {str(e)}"
    
    def processar_imagem_sorteio(self, img_produto):
        """Processa a imagem para sorteio"""
        try:
            # Redimensionar produto para 540x540
            img_produto = img_produto.resize((540, 540), Image.Resampling.LANCZOS)
            
            # Criar canvas 600x600 branco
            canvas = Image.new('RGBA', (600, 600), (255, 255, 255, 255))
            
            # Centralizar produto no canvas
            pos_x = (600 - 540) // 2
            pos_y = (600 - 540) // 2
            canvas.paste(img_produto, (pos_x, pos_y), img_produto)
            
            # Configurar fontes e cores
            try:
                fonte_media = ImageFont.truetype("arial.ttf", 60)
                fonte_grande = ImageFont.truetype("arial.ttf", 96)
            except:
                fonte_media = ImageFont.load_default()
                fonte_grande = ImageFont.load_default()
            
            draw = ImageDraw.Draw(canvas)
            cor_vermelha = (220, 20, 60)  # Vermelho
            cor_contorno = (255, 255, 255)  # Branco para contorno
            
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
            
            return None, "Erro no upload para Catbox"
            
        except Exception as e:
            return None, f"Erro no upload: {str(e)}"
    
    def processar_produto_completo(self, url_produto):
        """Processa um produto completo"""
        try:
            logger.info(f"🔄 Iniciando processamento: {url_produto}")
            
            # 1. Validar produto
            valido, msg_validacao = self.validar_produto_natura(url_produto)
            if not valido:
                return None, f"❌ Validação falhou: {msg_validacao}"
            
            # 2. Extrair imagem
            url_imagem, msg_extracao = self.extrair_imagem_limpa(url_produto)
            if not url_imagem:
                return None, f"❌ Extração falhou: {msg_extracao}"
            
            # 3. Baixar imagem
            img_produto, msg_download = self.baixar_imagem(url_imagem)
            if not img_produto:
                return None, f"❌ Download falhou: {msg_download}"
            
            # 4. Processar para sorteio
            buffer_processado, msg_processamento = self.processar_imagem_sorteio(img_produto)
            if not buffer_processado:
                return None, f"❌ Processamento falhou: {msg_processamento}"
            
            # 5. Upload para Catbox
            url_final, msg_upload = self.upload_catbox(buffer_processado)
            if not url_final:
                return None, f"❌ Upload falhou: {msg_upload}"
            
            logger.info(f"✅ Processamento concluído: {url_final}")
            return url_final, "✅ Produto processado com sucesso"
            
        except Exception as e:
            logger.error(f"❌ Erro geral no processamento: {e}")
            return None, f"❌ Erro geral: {str(e)}"

# ================================
# GERENCIADOR GOOGLE SHEETS
# ================================

class GoogleSheetsManager:
    def __init__(self):
        self.planilha = None
        self.conectar()
    
    def conectar(self):
        """Conecta ao Google Sheets"""
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
                # CORREÇÃO: Usar nomes corretos das colunas
                link_produto = linha.get('link_produto', '').strip()
                imagem_processada = linha.get('url_imagem_processada', '').strip()
                
                # Se tem link do produto mas não tem imagem processada
                if link_produto and not imagem_processada:
                    produtos_pendentes.append({
                        'linha': i,
                        'url': link_produto,
                        'produto': linha.get('nome', 'Produto sem nome')
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
            
            # Coluna E = url_imagem_processada (coluna 5)
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
    try:
        logger.info("🔄 Iniciando processamento automático da planilha")
        sistema_status["status"] = "Processando planilha..."
        
        # Obter produtos pendentes
        produtos = sheets_manager.obter_produtos_pendentes()
        
        if not produtos:
            logger.info("ℹ️ Nenhum produto pendente encontrado")
            sistema_status["status"] = "Aguardando produtos pendentes"
            return
        
        logger.info(f"📋 Encontrados {len(produtos)} produtos pendentes")
        
        # Processar cada produto
        for produto in produtos:
            try:
                logger.info(f"🔄 Processando: {produto['produto']}")
                
                # Processar produto
                url_imagem, mensagem = processador.processar_produto_completo(produto['url'])
                
                if url_imagem:
                    # Atualizar planilha
                    sucesso = sheets_manager.atualizar_imagem_processada(produto['linha'], url_imagem)
                    
                    if sucesso:
                        sistema_status["produtos_processados"] += 1
                        logger.info(f"✅ {produto['produto']} processado com sucesso")
                    else:
                        sistema_status["erros"] += 1
                        logger.error(f"❌ Erro ao atualizar planilha para {produto['produto']}")
                else:
                    sistema_status["erros"] += 1
                    logger.error(f"❌ Erro ao processar {produto['produto']}: {mensagem}")
                
                # Pausa entre processamentos
                time.sleep(2)
                
            except Exception as e:
                sistema_status["erros"] += 1
                logger.error(f"❌ Erro ao processar produto {produto.get('produto', 'desconhecido')}: {e}")
        
        sistema_status["ultima_execucao"] = datetime.now().isoformat()
        sistema_status["status"] = "Aguardando próxima execução"
        logger.info("✅ Processamento automático concluído")
        
    except Exception as e:
        sistema_status["erros"] += 1
        sistema_status["status"] = f"Erro: {str(e)}"
        logger.error(f"❌ Erro no processamento automático: {e}")

def iniciar_scheduler():
    """Inicia o scheduler em thread separada"""
    def run_scheduler():
        # Agendar execução a cada 30 minutos
        schedule.every(30).minutes.do(processar_planilha_automatico)
        
        logger.info("⏰ Scheduler iniciado - execução a cada 30 minutos")
        
        while True:
            schedule.run_pending()
            time.sleep(60)  # Verificar a cada minuto
    
    # Executar em thread separada
    scheduler_thread = threading.Thread(target=run_scheduler, daemon=True)
    scheduler_thread.start()

# ================================
# ROTAS DA API
# ================================

@app.route('/')
def dashboard():
    """Dashboard principal do sistema"""
    html = """
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Sistema Processador de Sorteios</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
            .container { max-width: 1200px; margin: 0 auto; }
            .header { text-align: center; margin-bottom: 30px; }
            .status-card { background: white; padding: 20px; border-radius: 10px; margin: 20px 0; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .success { background: #d4edda; border-left: 5px solid #28a745; }
            .stats { display: flex; justify-content: space-around; margin: 20px 0; }
            .stat { text-align: center; }
            .stat h2 { font-size: 2.5em; margin: 0; color: #007bff; }
            .buttons { text-align: center; margin: 30px 0; }
            .btn { padding: 15px 30px; margin: 10px; border: none; border-radius: 5px; font-size: 16px; cursor: pointer; text-decoration: none; display: inline-block; }
            .btn-primary { background: #007bff; color: white; }
            .btn-success { background: #28a745; color: white; }
            .endpoints { background: #fff3cd; padding: 20px; border-radius: 10px; margin: 20px 0; }
            .endpoint { margin: 10px 0; font-family: monospace; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🎯 Sistema Processador de Sorteios</h1>
            </div>
            
            <div class="status-card success">
                <h3>✅ Sistema Online e Funcionando!</h3>
                <p>Automação ativa - processamento a cada 30 minutos</p>
            </div>
            
            <div class="stats">
                <div class="stat">
                    <h2>{{ produtos_processados }}</h2>
                    <p>Produtos Processados</p>
                </div>
                <div class="stat">
                    <h2>{{ erros }}</h2>
                    <p>Erros</p>
                </div>
            </div>
            
            <div class="status-card">
                <h4>📊 Status: {{ status }}</h4>
                <p>🕐 Última Execução: {{ ultima_execucao or 'Aguardando primeira execução' }}</p>
            </div>
            
            <div class="buttons">
                <a href="/api/sorteios/processar-planilha" class="btn btn-primary">🚀 Processar Planilha Agora</a>
                <a href="/api/sorteios/status" class="btn btn-success">📊 Ver Status Detalhado</a>
            </div>
            
            <div class="endpoints">
                <h4>🔌 Endpoints da API:</h4>
                <div class="endpoint">• GET /api/sorteios/health - Health check</div>
                <div class="endpoint">• GET /api/sorteios/status - Status detalhado</div>
                <div class="endpoint">• POST /api/sorteios/processar-planilha - Processar planilha</div>
                <div class="endpoint">• POST /api/sorteios/processar-produto - Processar produto individual</div>
            </div>
        </div>
    </body>
    </html>
    """
    
    return render_template_string(html, **sistema_status)

@app.route('/api/sorteios/health')
def health_check():
    """Health check da API"""
    return jsonify({
        "status": "ok",
        "message": "Sistema funcionando",
        "timestamp": datetime.now().isoformat()
    })

@app.route('/api/sorteios/status')
def status_detalhado():
    """Status detalhado do sistema"""
    return jsonify({
        "sistema": sistema_status,
        "google_sheets": {
            "conectado": sheets_manager.planilha is not None,
            "planilha_id": PLANILHA_ID
        },
        "processador": {
            "ativo": True,
            "versao": "4.1"
        },
        "timestamp": datetime.now().isoformat()
    })

@app.route('/api/sorteios/processar-planilha', methods=['GET', 'POST'])
def processar_planilha_manual():
    """Processa a planilha manualmente"""
    try:
        # Executar em thread separada para não bloquear
        thread = threading.Thread(target=processar_planilha_automatico, daemon=True)
        thread.start()
        
        return jsonify({
            "mensagem": "Processamento da planilha iniciado",
            "sucesso": True,
            "timestamp": datetime.now().isoformat()
        })
        
    except Exception as e:
        return jsonify({
            "mensagem": f"Erro ao iniciar processamento: {str(e)}",
            "sucesso": False,
            "timestamp": datetime.now().isoformat()
        }), 500

@app.route('/api/sorteios/processar-produto', methods=['POST'])
def processar_produto_individual():
    """Processa um produto individual"""
    try:
        data = request.get_json()
        url_produto = data.get('url')
        
        if not url_produto:
            return jsonify({
                "mensagem": "URL do produto é obrigatória",
                "sucesso": False
            }), 400
        
        # Processar produto
        url_imagem, mensagem = processador.processar_produto_completo(url_produto)
        
        if url_imagem:
            return jsonify({
                "mensagem": mensagem,
                "url_imagem": url_imagem,
                "sucesso": True,
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
    app.run(host='0.0.0.0', port=port, debug=False)
