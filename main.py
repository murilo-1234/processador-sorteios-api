#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sistema Processador de Sorteios API v5.0 - CORRIGIDO COMPLETO
Sistema automatizado que lê Google Sheets, processa produtos da Natura 
com extração por código e validação de fundo branco conforme PDF.

CORREÇÕES IMPLEMENTADAS:
- Extração por código NATBRA-XXXXX (não semântica)
- Validação de fundo branco ≥60% obrigatória
- Processamento conforme especificações do PDF
- Mapeamento correto das colunas E/G

Autor: Sistema Manus V5.0
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
CREDENCIAIS_PATH = "credentials.json"

# Status global do sistema
sistema_status = {
    "ultima_execucao": None,
    "produtos_processados": 0,
    "erros": 0,
    "status": "Aguardando primeira execução"
}

# ================================
# PROCESSADOR DE IMAGENS V5.0 CORRIGIDO
# ================================

class ProcessadorSorteioV5:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        })
        logger.info("🎯 PROCESSADOR V5.0 INICIADO - Extração por código + validação fundo branco")

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

    def validar_fundo_branco(self, img):
        """Valida se a imagem tem ≥60% de fundo branco"""
        try:
            if img.mode != 'RGB':
                img = img.convert('RGB')
            
            width, height = img.size
            pixels_brancos = 0
            pixels_amostrados = 0
            
            # Amostragem das bordas (mais eficiente)
            border_size = min(width, height) // 10
            
            # Amostragem das bordas
            for x in range(0, width, 5):
                for y in range(border_size):
                    r, g, b = img.getpixel((x, y))
                    if r > 240 and g > 240 and b > 240:
                        pixels_brancos += 1
                    pixels_amostrados += 1
            
            for x in range(0, width, 5):
                for y in range(height - border_size, height):
                    r, g, b = img.getpixel((x, y))
                    if r > 240 and g > 240 and b > 240:
                        pixels_brancos += 1
                    pixels_amostrados += 1
            
            for y in range(0, height, 5):
                for x in range(border_size):
                    r, g, b = img.getpixel((x, y))
                    if r > 240 and g > 240 and b > 240:
                        pixels_brancos += 1
                    pixels_amostrados += 1
                
                for x in range(width - border_size, width):
                    r, g, b = img.getpixel((x, y))
                    if r > 240 and g > 240 and b > 240:
                        pixels_brancos += 1
                    pixels_amostrados += 1
            
            if pixels_amostrados > 0:
                percentual = (pixels_brancos / pixels_amostrados) * 100
                logger.info(f"🎨 Fundo branco: {percentual:.1f}%")
                return percentual >= 60.0, percentual
            else:
                return False, 0.0
                
        except Exception as e:
            logger.error(f"❌ Erro na validação de fundo branco: {e}")
            return False, 0.0

    def extrair_imagens_por_codigo(self, url, codigo_produto):
        """Extrai imagens baseado no código do produto"""
        try:
            logger.info(f"🔍 Buscando imagens para código: {codigo_produto}")
            
            response = self.session.get(url, timeout=15)
            if response.status_code != 200:
                return [], "Erro ao acessar página do produto"
            
            soup = BeautifulSoup(response.content, 'html.parser')
            imgs = soup.find_all('img')
            candidatas = []
            
            for img in imgs:
                src = img.get('src') or img.get('data-src') or img.get('data-lazy-src')
                if not src:
                    continue
                
                if src.startswith('//'):
                    src = 'https:' + src
                elif src.startswith('/'):
                    src = urljoin(url, src)
                
                # Filtrar apenas imagens que contêm o código do produto
                if codigo_produto in src or codigo_produto.replace('-', '') in src:
                    candidatas.append({
                        'url': src,
                        'score': 0,
                        'motivo': f'Contém código {codigo_produto}'
                    })
                    logger.info(f"✅ Candidata: {src}")
            
            if not candidatas:
                logger.error(f"❌ Nenhuma imagem com código {codigo_produto}")
                return [], "Nenhuma imagem encontrada com o código do produto"
            
            logger.info(f"📋 Candidatas encontradas: {len(candidatas)}")
            return candidatas, "Candidatas extraídas com sucesso"
            
        except Exception as e:
            logger.error(f"❌ Erro ao extrair imagens: {e}")
            return [], f"Erro na extração: {str(e)}"

    def avaliar_e_selecionar_imagem(self, candidatas):
        """Avalia candidatas e seleciona a melhor com base no fundo branco"""
        try:
            logger.info("🔍 Avaliando candidatas...")
            melhores = []
            
            for i, candidata in enumerate(candidatas):
                logger.info(f"📋 Avaliando {i+1}/{len(candidatas)}: {candidata['url']}")
                
                try:
                    response = self.session.get(candidata['url'], timeout=10)
                    if response.status_code != 200:
                        continue
                    
                    img = Image.open(io.BytesIO(response.content))
                    tem_fundo_branco, percentual = self.validar_fundo_branco(img)
                    
                    if tem_fundo_branco:
                        score = 1000
                        if percentual >= 80:
                            score += 500
                        elif percentual >= 70:
                            score += 300
                        else:
                            score += 100
                        
                        width, height = img.size
                        if width >= 800 and height >= 800:
                            score += 200
                        elif width >= 400 and height >= 400:
                            score += 100
                        
                        candidata['score'] = score
                        candidata['percentual_branco'] = percentual
                        candidata['imagem'] = img
                        melhores.append(candidata)
                        
                        logger.info(f"✅ APROVADA - Score: {score}, Fundo: {percentual:.1f}%")
                    else:
                        logger.info(f"❌ REJEITADA - Fundo: {percentual:.1f}%")
                
                except Exception as e:
                    logger.error(f"❌ Erro ao avaliar: {e}")
                    continue
            
            if not melhores:
                return None, "Nenhuma imagem com fundo branco adequado (≥60%)"
            
            melhores.sort(key=lambda x: x['score'], reverse=True)
            melhor = melhores[0]
            
            logger.info(f"🏆 MELHOR: Score {melhor['score']}, Fundo {melhor['percentual_branco']:.1f}%")
            return melhor['imagem'], "Imagem selecionada com sucesso"
            
        except Exception as e:
            logger.error(f"❌ Erro na avaliação: {e}")
            return None, f"Erro na avaliação: {str(e)}"

    def processar_imagem_sorteio(self, img_produto):
        """Processa a imagem para sorteio conforme especificações do PDF"""
        try:
            logger.info("🎨 Processando imagem para sorteio...")
            
            # Redimensionar produto para máximo 540x540 mantendo proporção
            img_produto.thumbnail((540, 540), Image.Resampling.LANCZOS)
            
            # Criar canvas 600x600 branco
            canvas = Image.new('RGB', (600, 600), (255, 255, 255))
            
            # Centralizar produto no canvas
            produto_width, produto_height = img_produto.size
            pos_x = (600 - produto_width) // 2
            pos_y = (600 - produto_height) // 2
            
            if img_produto.mode == 'RGBA':
                canvas.paste(img_produto, (pos_x, pos_y), img_produto)
            else:
                canvas.paste(img_produto, (pos_x, pos_y))
            
            # Configurar fontes
            try:
                fonte_media = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 60)
                fonte_grande = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 96)
            except:
                try:
                    fonte_media = ImageFont.truetype("arial.ttf", 60)
                    fonte_grande = ImageFont.truetype("arial.ttf", 96)
                except:
                    fonte_media = ImageFont.load_default()
                    fonte_grande = ImageFont.load_default()
            
            draw = ImageDraw.Draw(canvas)
            cor_vermelha = (139, 0, 0)  # #8B0000
            cor_contorno = (255, 255, 255)
            
            # TEXTO SUPERIOR: "Ganhe esse Top!"
            texto_superior = "Ganhe esse Top!"
            bbox_superior = draw.textbbox((0, 0), texto_superior, font=fonte_media)
            largura_superior = bbox_superior[2] - bbox_superior[0]
            x_superior = (600 - largura_superior) // 2
            y_superior = 20
            
            # Contorno branco (4px)
            for dx in range(-4, 5):
                for dy in range(-4, 5):
                    if dx != 0 or dy != 0:
                        draw.text((x_superior + dx, y_superior + dy), texto_superior, 
                                font=fonte_media, fill=cor_contorno)
            
            draw.text((x_superior, y_superior), texto_superior, 
                     font=fonte_media, fill=cor_vermelha)
            
            # TEXTO INFERIOR: "Sorteio"
            texto_inferior = "Sorteio"
            bbox_inferior = draw.textbbox((0, 0), texto_inferior, font=fonte_grande)
            largura_inferior = bbox_inferior[2] - bbox_inferior[0]
            altura_inferior = bbox_inferior[3] - bbox_inferior[1]
            x_inferior = (600 - largura_inferior) // 2
            y_inferior = 600 - altura_inferior - 20
            
            # Contorno branco (6px)
            for dx in range(-6, 7):
                for dy in range(-6, 7):
                    if dx != 0 or dy != 0:
                        draw.text((x_inferior + dx, y_inferior + dy), texto_inferior, 
                                font=fonte_grande, fill=cor_contorno)
            
            draw.text((x_inferior, y_inferior), texto_inferior, 
                     font=fonte_grande, fill=cor_vermelha)
            
            # Salvar em buffer
            buffer = io.BytesIO()
            canvas.save(buffer, format='PNG', quality=95)
            buffer.seek(0)
            
            logger.info("✅ Imagem processada com sucesso")
            return buffer, "Imagem processada conforme PDF"
            
        except Exception as e:
            logger.error(f"❌ Erro ao processar imagem: {e}")
            return None, f"Erro no processamento: {str(e)}"

    def upload_catbox(self, buffer_imagem):
        """Faz upload da imagem para Catbox.moe"""
        try:
            logger.info("📤 Upload para Catbox.moe...")
            buffer_imagem.seek(0)
            
            files = {
                'fileToUpload': ('sorteio.png', buffer_imagem, 'image/png')
            }
            
            data = {
                'reqtype': 'fileupload'
            }
            
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
            
            response = requests.post('https://catbox.moe/user/api.php', 
                                   files=files, 
                                   data=data, 
                                   headers=headers,
                                   timeout=60)
            
            logger.info(f"📊 Status Code: {response.status_code}")
            
            if response.status_code == 200:
                url = response.text.strip()
                if url.startswith('https://files.catbox.moe/'):
                    logger.info(f"✅ Upload concluído: {url}")
                    return url, "Upload realizado com sucesso"
                else:
                    logger.error(f"❌ Resposta inesperada: {url}")
                    return None, f"Resposta inesperada: {url}"
            else:
                logger.error(f"❌ Erro HTTP {response.status_code}")
                return None, f"Erro HTTP {response.status_code}"
            
        except Exception as e:
            logger.error(f"❌ Erro no upload: {e}")
            return None, f"Erro no upload: {str(e)}"

    def processar_produto_completo(self, url_produto):
        """Processa um produto completo"""
        try:
            logger.info(f"🚀 PROCESSAMENTO V5.0: {url_produto}")
            
            # 1. Extrair código do produto
            codigo = self.extrair_codigo_produto(url_produto)
            if not codigo:
                return None, "❌ Código NATBRA não encontrado na URL"
            
            # 2. Extrair imagens por código
            candidatas, msg_extracao = self.extrair_imagens_por_codigo(url_produto, codigo)
            if not candidatas:
                return None, f"❌ Extração falhou: {msg_extracao}"
            
            # 3. Avaliar e selecionar melhor imagem
            img_produto, msg_selecao = self.avaliar_e_selecionar_imagem(candidatas)
            if not img_produto:
                return None, f"❌ Seleção falhou: {msg_selecao}"
            
            # 4. Processar para sorteio
            buffer_processado, msg_processamento = self.processar_imagem_sorteio(img_produto)
            if not buffer_processado:
                return None, f"❌ Processamento falhou: {msg_processamento}"
            
            # 5. Upload para Catbox
            url_final, msg_upload = self.upload_catbox(buffer_processado)
            if not url_final:
                return None, f"❌ Upload falhou: {msg_upload}"
            
            logger.info(f"🎉 SUCESSO: {url_final}")
            return url_final, "✅ Produto processado com sucesso"
            
        except Exception as e:
            logger.error(f"❌ Erro geral: {e}")
            return None, f"❌ Erro geral: {str(e)}"

# ================================
# GERENCIADOR GOOGLE SHEETS CORRIGIDO
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
            
            if not os.path.exists(CREDENCIAIS_PATH):
                logger.error(f"❌ Arquivo de credenciais não encontrado: {CREDENCIAIS_PATH}")
                return False
            
            creds = ServiceAccountCredentials.from_json_keyfile_name(CREDENCIAIS_PATH, scope)
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
                logger.error("❌ Planilha não conectada")
                return []
            
            # Ler todas as linhas
            dados = self.planilha.get_all_records()
            produtos_pendentes = []
            
            for i, linha in enumerate(dados, start=2):  # Linha 2 = primeira linha de dados
                # CORREÇÃO: Verificar colunas corretas
                # Coluna G = link do produto (onde você fornece o link)
                # Coluna E = url_imagem_processada (onde vai o resultado)
                
                # Tentar diferentes nomes de colunas possíveis
                link_produto = (linha.get('G') or 
                              linha.get('link_produto') or 
                              linha.get('Link Produto') or 
                              linha.get('URL Produto') or '').strip()
                
                imagem_processada = (linha.get('E') or 
                                   linha.get('url_imagem_processada') or 
                                   linha.get('URL Imagem Processada') or 
                                   linha.get('Imagem Processada') or '').strip()
                
                # Se tem link do produto mas não tem imagem processada
                if link_produto and not imagem_processada:
                    nome_produto = (linha.get('nome') or 
                                  linha.get('Nome') or 
                                  linha.get('Produto') or 
                                  linha.get('produto') or 
                                  f'Produto linha {i}')
                    
                    produtos_pendentes.append({
                        'linha': i,
                        'url': link_produto,
                        'produto': nome_produto
                    })
                    logger.info(f"📋 Produto pendente linha {i}: {nome_produto}")
            
            logger.info(f"📊 Total de produtos pendentes: {len(produtos_pendentes)}")
            return produtos_pendentes
            
        except Exception as e:
            logger.error(f"❌ Erro ao obter produtos pendentes: {e}")
            return []
    
    def atualizar_imagem_processada(self, linha, url_imagem):
        """Atualiza a coluna E com a URL da imagem processada"""
        try:
            if not self.planilha:
                logger.error("❌ Planilha não conectada")
                return False
            
            # Coluna E = 5ª coluna (url_imagem_processada)
            self.planilha.update_cell(linha, 5, url_imagem)
            logger.info(f"✅ Linha {linha} atualizada: {url_imagem}")
            return True
            
        except Exception as e:
            logger.error(f"❌ Erro ao atualizar planilha linha {linha}: {e}")
            return False

# ================================
# INSTÂNCIAS GLOBAIS
# ================================

processador = ProcessadorSorteioV5()
sheets_manager = GoogleSheetsManager()

# ================================
# FUNÇÕES DE AUTOMAÇÃO
# ================================

def processar_planilha_automatico():
    """Função que processa a planilha automaticamente"""
    try:
        logger.info("🔄 INICIANDO PROCESSAMENTO AUTOMÁTICO")
        sistema_status["status"] = "Processando planilha..."
        
        # Obter produtos pendentes
        produtos = sheets_manager.obter_produtos_pendentes()
        
        if not produtos:
            logger.info("ℹ️ Nenhum produto pendente encontrado")
            sistema_status["status"] = "Aguardando produtos pendentes"
            return
        
        logger.info(f"📋 Produtos pendentes: {len(produtos)}")
        
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
                        logger.error(f"❌ Erro ao atualizar planilha: {produto['produto']}")
                else:
                    sistema_status["erros"] += 1
                    logger.error(f"❌ Erro ao processar {produto['produto']}: {mensagem}")
                
                # Pausa entre processamentos
                time.sleep(3)
                
            except Exception as e:
                sistema_status["erros"] += 1
                logger.error(f"❌ Erro ao processar {produto.get('produto', 'desconhecido')}: {e}")
        
        sistema_status["ultima_execucao"] = datetime.now().isoformat()
        sistema_status["status"] = "Aguardando próxima execução"
        logger.info("✅ PROCESSAMENTO AUTOMÁTICO CONCLUÍDO")
        
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
            time.sleep(60)
    
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
        <title>Sistema Processador de Sorteios V5.0</title>
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
            .version { background: #e7f3ff; padding: 15px; border-radius: 10px; margin: 20px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🎯 Sistema Processador de Sorteios V5.0</h1>
                <p>Extração por código + Validação de fundo branco</p>
            </div>
            
            <div class="version">
                <h4>🔧 CORREÇÕES V5.0 IMPLEMENTADAS:</h4>
                <ul>
                    <li>✅ Extração por código NATBRA-XXXXX (não semântica)</li>
                    <li>✅ Validação de fundo branco ≥60% obrigatória</li>
                    <li>✅ Processamento conforme especificações do PDF</li>
                    <li>✅ Mapeamento correto colunas E/G</li>
                </ul>
            </div>
            
            <div class="status-card success">
                <h3>✅ Sistema V5.0 Online e Funcionando!</h3>
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
        "message": "Sistema V5.0 funcionando",
        "versao": "5.0",
        "timestamp": datetime.now().isoformat()
    })

@app.route('/api/sorteios/status')
def status_detalhado():
    """Status detalhado do sistema"""
    return jsonify({
        "sistema": sistema_status,
        "versao": "5.0",
        "google_sheets": {
            "conectado": sheets_manager.planilha is not None,
            "planilha_id": PLANILHA_ID
        },
        "processador": {
            "ativo": True,
            "versao": "5.0",
            "extracao": "Por código NATBRA-XXXXX",
            "validacao": "Fundo branco ≥60%"
        },
        "timestamp": datetime.now().isoformat()
    })

@app.route('/api/sorteios/processar-planilha', methods=['GET', 'POST'])
def processar_planilha_manual():
    """Processa a planilha manualmente"""
    try:
        thread = threading.Thread(target=processar_planilha_automatico, daemon=True)
        thread.start()
        
        return jsonify({
            "mensagem": "Processamento da planilha V5.0 iniciado",
            "sucesso": True,
            "versao": "5.0",
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
        
        url_imagem, mensagem = processador.processar_produto_completo(url_produto)
        
        if url_imagem:
            return jsonify({
                "mensagem": mensagem,
                "url_imagem": url_imagem,
                "sucesso": True,
                "versao": "5.0",
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
    logger.info("🚀 INICIANDO SISTEMA V5.0 CORRIGIDO")
    
    # Iniciar scheduler
    iniciar_scheduler()
    
    # Executar primeira verificação após 30 segundos
    def primeira_execucao():
        time.sleep(30)
        processar_planilha_automatico()
    
    threading.Thread(target=primeira_execucao, daemon=True).start()
    
    # Iniciar servidor
    port = int(os.environ.get('PORT', 5000))
    logger.info(f"🚀 Servidor V5.0 iniciando na porta {port}")
    app.run(host='0.0.0.0', port=port, debug=False)
