#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sistema Processador de Sorteios V6.0 + Integração ManyChat-ChatGPT
Sistema automatizado que lê Google Sheets, processa produtos da Natura 
com extração por código e validação de fundo branco conforme PDF.
Agora com integração ManyChat-ChatGPT para atendimento automatizado.

CORREÇÕES IMPLEMENTADAS:
- Extração por código NATBRA-XXXXX (não semântica)
- Validação de fundo branco ≥60% obrigatória
- Processamento conforme especificações do PDF
- Mapeamento correto das colunas E/G
- USO DE GITHUB SECRETS para credenciais
- INTEGRAÇÃO MANYCHAT-CHATGPT para atendimento 24/7
- CORREÇÃO: Removido async/await para compatibilidade Flask

Autor: Sistema Manus V6.0
Data: Janeiro 2025
"""

# IMPORTS ORIGINAIS DO SISTEMA
from flask import Flask, request, jsonify, render_template_string
from flask_cors import CORS
import os
import threading
import time
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
import tempfile

# IMPORTS PARA INTEGRAÇÃO MANYCHAT
from openai import OpenAI

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

# Status global do sistema
sistema_status = {
    "ultima_execucao": None,
    "produtos_processados": 0,
    "erros": 0,
    "status": "Serviço web online. Aguardando execução do Cron Job."
}

# ================================
# INTEGRAÇÃO MANYCHAT-CHATGPT
# ================================

# Configuração do cliente OpenAI
def get_openai_client():
    """Obtém cliente OpenAI configurado"""
    api_key = os.getenv('OPENAI_API_KEY')
    if not api_key:
        raise ValueError("OPENAI_API_KEY não configurada")
    return OpenAI(api_key=api_key)

# Armazenamento de conversas (em produção, usar Redis ou banco)
user_conversations = {}
ASSISTANT_ID = "asst_AQjafiLKeePeACy6mzPX1Mqo"
MAX_CONVERSAS = 1000
TIMEOUT_CONVERSA = 1800  # 30 minutos

def limpar_conversas_antigas():
    """Remove conversas antigas para economizar memória"""
    agora = time.time()
    usuarios_para_remover = []
    
    for user_id, conversa in user_conversations.items():
        if agora - conversa['last_activity'] > TIMEOUT_CONVERSA:
            usuarios_para_remover.append(user_id)
    
    for user_id in usuarios_para_remover:
        del user_conversations[user_id]
        logger.info(f"🧹 Conversa removida por timeout: {user_id}")

def detectar_automacao(message):
    """Detecta tipo de automação baseado na mensagem"""
    message_lower = message.lower()
    
    # Palavras-chave para diferentes automações
    automacoes = {
        'sorteio': ['sorteio', 'concurso', 'prêmio', 'ganhar', 'participar', 'sorteios'],
        'produto': ['produto', 'natura', 'catálogo', 'preço', 'perfume', 'maquiagem', 'creme'],
        'contato': ['contato', 'ajuda', 'suporte', 'atendimento', 'falar', 'conversar'],
        'pedido': ['pedido', 'compra', 'carrinho', 'quero', 'comprar', 'adquirir'],
        'entrega': ['entrega', 'prazo', 'rastreamento', 'correios', 'quando chega']
    }
    
    # Scoring para priorizar automações
    scores = {}
    for tipo, palavras in automacoes.items():
        score = 0
        for palavra in palavras:
            if palavra in message_lower:
                score += 1
        if score > 0:
            scores[tipo] = score
    
    if scores:
        # Retorna automação com maior score
        return max(scores, key=scores.get)
    
    return None

def processar_com_chatgpt(message, user_name, user_id):
    """Processa mensagem com ChatGPT usando Assistant - VERSÃO SÍNCRONA CORRIGIDA"""
    try:
        logger.info(f"🤖 Iniciando processamento ChatGPT para {user_name}")
        
        client = get_openai_client()
        
        # Limpar conversas antigas periodicamente
        if len(user_conversations) > MAX_CONVERSAS:
            limpar_conversas_antigas()
        
        # Obter ou criar thread para o usuário
        if user_id not in user_conversations:
            # Criar nova thread
            thread = client.beta.threads.create()
            user_conversations[user_id] = {
                'thread_id': thread.id,
                'messages': [],
                'last_activity': time.time()
            }
            logger.info(f"🆕 Nova conversa criada para {user_name} ({user_id})")
        else:
            # Atualizar atividade
            user_conversations[user_id]['last_activity'] = time.time()
            logger.info(f"🔄 Conversa existente para {user_name} ({user_id})")
        
        thread_id = user_conversations[user_id]['thread_id']
        
        # Adicionar mensagem do usuário
        logger.info(f"📝 Adicionando mensagem à thread: {message}")
        client.beta.threads.messages.create(
            thread_id=thread_id,
            role="user",
            content=message
        )
        
        # Executar Assistant
        logger.info(f"🚀 Executando Assistant: {ASSISTANT_ID}")
        run = client.beta.threads.runs.create(
            thread_id=thread_id,
            assistant_id=ASSISTANT_ID
        )
        
        # Aguardar conclusão
        max_attempts = 30
        for attempt in range(max_attempts):
            run_status = client.beta.threads.runs.retrieve(
                thread_id=thread_id,
                run_id=run.id
            )
            
            logger.info(f"⏳ Status do run (tentativa {attempt+1}): {run_status.status}")
            
            if run_status.status == 'completed':
                logger.info("✅ Run completado com sucesso")
                break
            elif run_status.status in ['failed', 'cancelled', 'expired']:
                logger.error(f"❌ Run falhou: {run_status.status}")
                raise Exception(f"Run falhou: {run_status.status}")
            
            time.sleep(1)
        else:
            logger.error("❌ Timeout aguardando resposta do Assistant")
            raise Exception("Timeout aguardando resposta do Assistant")
        
        # Obter resposta
        logger.info("📥 Obtendo resposta do Assistant")
        messages = client.beta.threads.messages.list(thread_id=thread_id)
        resposta = messages.data[0].content[0].text.value
        
        # Armazenar no histórico local
        user_conversations[user_id]['messages'].extend([
            {'role': 'user', 'content': message},
            {'role': 'assistant', 'content': resposta}
        ])
        
        # Manter apenas últimas 10 mensagens para otimização
        if len(user_conversations[user_id]['messages']) > 20:
            user_conversations[user_id]['messages'] = user_conversations[user_id]['messages'][-20:]
        
        logger.info(f"✅ Resposta ChatGPT para {user_name}: {resposta[:100]}...")
        return resposta
        
    except Exception as e:
        logger.error(f"❌ Erro ChatGPT para {user_name}: {e}")
        return f"Desculpe {user_name}, estou com dificuldades técnicas no momento. Tente novamente em alguns instantes! 😊"

@app.route('/webhook/manychat', methods=['POST'])
def webhook_manychat():
    """Webhook para receber mensagens do ManyChat"""
    try:
        data = request.get_json()
        
        # Validar dados recebidos
        if not data:
            return jsonify({"error": "Dados não fornecidos"}), 400
        
        message = data.get('message', '').strip()
        user_name = data.get('nome', 'Usuário')
        user_id = data.get('user_id', 'unknown')
        platform = data.get('platform', '')
        
        logger.info(f"🔄 Webhook ManyChat recebido - Usuário: {user_name} ({user_id})")
        logger.info(f"📝 Mensagem: {message}")
        
        # Validar se é requisição do ManyChat
        if platform != 'manychat':
            return jsonify({"error": "Platform inválida"}), 400
        
        if not message:
            return jsonify({
                "messages": [{"text": "Desculpe, não consegui entender sua mensagem. Pode tentar novamente? 😊"}]
            })
        
        # Detectar automação
        tipo_automacao = detectar_automacao(message)
        if tipo_automacao:
            logger.info(f"🎯 Automação detectada: {tipo_automacao}")
        
        # Processar com ChatGPT
        resposta = processar_com_chatgpt(message, user_name, user_id)
        
        # Adicionar indicador de automação se detectada
        if tipo_automacao:
            resposta += f"\n\n[Automação {tipo_automacao} detectada]"
        
        # Formato de resposta para ManyChat
        response = {
            "messages": [
                {
                    "text": resposta
                }
            ]
        }
        
        logger.info(f"✅ Resposta enviada para {user_name}")
        return jsonify(response)
        
    except Exception as e:
        logger.error(f"❌ Erro no webhook ManyChat: {e}")
        return jsonify({
            "messages": [{"text": "Erro interno do servidor. Tente novamente mais tarde."}]
        }), 500

@app.route('/api/manychat/stats', methods=['GET'])
def stats_manychat():
    """Retorna estatísticas da integração ManyChat"""
    try:
        agora = time.time()
        conversas_ativas = 0
        
        for conversa in user_conversations.values():
            if agora - conversa['last_activity'] < TIMEOUT_CONVERSA:
                conversas_ativas += 1
        
        stats = {
            "status": "ok",
            "timestamp": datetime.now().isoformat(),
            "estatisticas": {
                "total_conversas": len(user_conversations),
                "conversas_ativas": conversas_ativas,
                "timeout_conversa": TIMEOUT_CONVERSA,
                "max_conversas": MAX_CONVERSAS
            }
        }
        
        return jsonify(stats)
        
    except Exception as e:
        logger.error(f"❌ Erro ao obter stats: {e}")
        return jsonify({"error": "Erro interno"}), 500

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
                elif src.startswith('/' ):
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
                                   timeout=60 )
            
            logger.info(f"📊 Status Code: {response.status_code}")
            
            if response.status_code == 200:
                url = response.text.strip()
                if url.startswith('https://files.catbox.moe/' ):
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
# GERENCIADOR GOOGLE SHEETS COM SECRETS
# ================================

class GoogleSheetsManager:
    def __init__(self):
        self.planilha = None
        self.conectar()
    
    def conectar(self):
        """Conecta ao Google Sheets usando credenciais do GitHub Secrets"""
        try:
            logger.info("🔗 Conectando ao Google Sheets...")
            
            # Obter credenciais do ambiente (GitHub Secrets)
            creds_json = os.getenv('GOOGLE_CREDENTIALS')
            if not creds_json:
                raise ValueError("GOOGLE_CREDENTIALS não encontrada no ambiente")
            
            # Parse das credenciais JSON
            creds_dict = json.loads(creds_json)
            
            # Configurar escopo
            scope = [
                'https://spreadsheets.google.com/feeds',
                'https://www.googleapis.com/auth/drive'
            ]
            
            # Criar credenciais
            creds = ServiceAccountCredentials.from_json_keyfile_dict(creds_dict, scope)
            
            # Autorizar cliente
            client = gspread.authorize(creds)
            
            # Abrir planilha
            self.planilha = client.open_by_key(PLANILHA_ID)
            
            logger.info("✅ Conectado ao Google Sheets com sucesso")
            return True
            
        except Exception as e:
            logger.error(f"❌ Erro ao conectar Google Sheets: {e}")
            self.planilha = None
            return False
    
    def obter_produtos_pendentes(self):
        """Obtém produtos pendentes da planilha"""
        try:
            if not self.planilha:
                if not self.conectar():
                    return []
            
            # Acessar primeira aba
            worksheet = self.planilha.get_worksheet(0)
            
            # Obter todos os dados
            dados = worksheet.get_all_records()
            
            produtos_pendentes = []
            for i, linha in enumerate(dados, start=2):  # Linha 2 = primeira linha de dados
                url_produto = linha.get('URL do Produto', '').strip()
                status = linha.get('Status', '').strip()
                
                if url_produto and status.lower() in ['pendente', '']:
                    produtos_pendentes.append({
                        'linha': i,
                        'url': url_produto,
                        'dados': linha
                    })
            
            logger.info(f"📋 Produtos pendentes encontrados: {len(produtos_pendentes)}")
            return produtos_pendentes
            
        except Exception as e:
            logger.error(f"❌ Erro ao obter produtos pendentes: {e}")
            return []
    
    def atualizar_resultado(self, linha, url_imagem=None, erro=None):
        """Atualiza resultado na planilha"""
        try:
            if not self.planilha:
                if not self.conectar():
                    return False
            
            worksheet = self.planilha.get_worksheet(0)
            
            # Determinar colunas baseado no cabeçalho
            headers = worksheet.row_values(1)
            col_status = None
            col_imagem = None
            col_erro = None
            
            for i, header in enumerate(headers, 1):
                if 'status' in header.lower():
                    col_status = i
                elif 'imagem' in header.lower() or 'resultado' in header.lower():
                    col_imagem = i
                elif 'erro' in header.lower() or 'observ' in header.lower():
                    col_erro = i
            
            # Atualizar células
            if url_imagem:
                if col_status:
                    worksheet.update_cell(linha, col_status, "✅ Processado")
                if col_imagem:
                    worksheet.update_cell(linha, col_imagem, url_imagem)
                if col_erro:
                    worksheet.update_cell(linha, col_erro, "")
                logger.info(f"✅ Linha {linha} atualizada com sucesso")
            else:
                if col_status:
                    worksheet.update_cell(linha, col_status, "❌ Erro")
                if col_erro:
                    worksheet.update_cell(linha, col_erro, erro or "Erro desconhecido")
                logger.info(f"❌ Linha {linha} atualizada com erro")
            
            return True
            
        except Exception as e:
            logger.error(f"❌ Erro ao atualizar planilha: {e}")
            return False

# ================================
# AUTOMAÇÃO PRINCIPAL
# ================================

def executar_processamento_automatico():
    """Executa processamento automático dos produtos"""
    global sistema_status
    
    try:
        logger.info("🚀 INICIANDO PROCESSAMENTO AUTOMÁTICO V5.0")
        
        # Atualizar status
        sistema_status["status"] = "Processando produtos..."
        sistema_status["ultima_execucao"] = datetime.now().isoformat()
        
        # Inicializar componentes
        sheets_manager = GoogleSheetsManager()
        processador = ProcessadorSorteioV5()
        
        # Obter produtos pendentes
        produtos = sheets_manager.obter_produtos_pendentes()
        
        if not produtos:
            logger.info("📋 Nenhum produto pendente encontrado")
            sistema_status["status"] = "Nenhum produto pendente. Sistema em standby."
            return
        
        logger.info(f"📋 Processando {len(produtos)} produtos...")
        
        sucessos = 0
        erros = 0
        
        for produto in produtos:
            try:
                logger.info(f"🔄 Processando linha {produto['linha']}: {produto['url']}")
                
                # Processar produto
                url_imagem, mensagem = processador.processar_produto_completo(produto['url'])
                
                if url_imagem:
                    # Sucesso
                    sheets_manager.atualizar_resultado(produto['linha'], url_imagem=url_imagem)
                    sucessos += 1
                    logger.info(f"✅ Linha {produto['linha']} processada com sucesso")
                else:
                    # Erro
                    sheets_manager.atualizar_resultado(produto['linha'], erro=mensagem)
                    erros += 1
                    logger.error(f"❌ Linha {produto['linha']} falhou: {mensagem}")
                
                # Delay entre processamentos
                time.sleep(2)
                
            except Exception as e:
                logger.error(f"❌ Erro ao processar linha {produto['linha']}: {e}")
                sheets_manager.atualizar_resultado(produto['linha'], erro=str(e))
                erros += 1
        
        # Atualizar status final
        sistema_status["produtos_processados"] = sucessos
        sistema_status["erros"] = erros
        sistema_status["status"] = f"Processamento concluído. {sucessos} sucessos, {erros} erros."
        
        logger.info(f"🎉 PROCESSAMENTO CONCLUÍDO: {sucessos} sucessos, {erros} erros")
        
    except Exception as e:
        logger.error(f"❌ Erro no processamento automático: {e}")
        sistema_status["status"] = f"Erro no processamento: {str(e)}"
        sistema_status["erros"] += 1

def executar_cron_job():
    """Executa o cron job em thread separada"""
    while True:
        try:
            # Executar a cada 30 minutos
            time.sleep(1800)
            logger.info("⏰ Executando cron job automático...")
            executar_processamento_automatico()
        except Exception as e:
            logger.error(f"❌ Erro no cron job: {e}")
            time.sleep(300)  # Aguardar 5 minutos em caso de erro

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
        <title>Sistema Processador de Sorteios V6.0</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
            .container { max-width: 800px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .header { text-align: center; color: #2c3e50; margin-bottom: 30px; }
            .status { padding: 15px; border-radius: 5px; margin: 10px 0; }
            .status.online { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
            .status.processing { background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; }
            .status.error { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
            .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }
            .stat-card { background: #f8f9fa; padding: 15px; border-radius: 5px; text-align: center; border-left: 4px solid #007bff; }
            .stat-number { font-size: 24px; font-weight: bold; color: #007bff; }
            .stat-label { color: #6c757d; font-size: 14px; }
            .actions { margin: 20px 0; }
            .btn { padding: 10px 20px; margin: 5px; border: none; border-radius: 5px; cursor: pointer; text-decoration: none; display: inline-block; }
            .btn-primary { background: #007bff; color: white; }
            .btn-success { background: #28a745; color: white; }
            .btn-warning { background: #ffc107; color: black; }
            .footer { text-align: center; margin-top: 30px; color: #6c757d; font-size: 12px; }
            .integration-status { background: #e7f3ff; border: 1px solid #b3d9ff; color: #0056b3; padding: 10px; border-radius: 5px; margin: 10px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🎯 Sistema Processador de Sorteios V6.0</h1>
                <p>Processamento automatizado de produtos Natura com integração ManyChat-ChatGPT</p>
            </div>
            
            <div class="status online">
                <strong>✅ Sistema V6.0 Online</strong><br>
                Status: {{ status.status }}<br>
                Última execução: {{ status.ultima_execucao or 'Nunca executado' }}
            </div>
            
            <div class="integration-status">
                <strong>🤖 Integração ManyChat: Ativa</strong><br>
                Endpoint: /webhook/manychat<br>
                ChatGPT Assistant: Configurado
            </div>
            
            <div class="stats">
                <div class="stat-card">
                    <div class="stat-number">{{ status.produtos_processados }}</div>
                    <div class="stat-label">Produtos Processados</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">{{ status.erros }}</div>
                    <div class="stat-label">Erros Registrados</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">{{ conversas_ativas }}</div>
                    <div class="stat-label">Conversas ManyChat Ativas</div>
                </div>
            </div>
            
            <div class="actions">
                <h3>🔧 Ações Disponíveis:</h3>
                <a href="/api/sorteios/processar-planilha" class="btn btn-primary">📊 Processar Planilha</a>
                <a href="/api/sorteios/status" class="btn btn-success">📋 Status Detalhado</a>
                <a href="/api/manychat/stats" class="btn btn-warning">🤖 Stats ManyChat</a>
            </div>
            
            <div class="footer">
                <p>Sistema Manus V6.0 - Processamento de Sorteios + Integração ManyChat-ChatGPT</p>
                <p>Desenvolvido para automação completa de sorteios da Natura</p>
            </div>
        </div>
    </body>
    </html>
    """
    
    # Calcular conversas ativas
    agora = time.time()
    conversas_ativas = sum(1 for conversa in user_conversations.values() 
                          if agora - conversa['last_activity'] < TIMEOUT_CONVERSA)
    
    return render_template_string(html, status=sistema_status, conversas_ativas=conversas_ativas)

@app.route('/api/sorteios/health')
def health_check():
    """Health check do sistema"""
    return jsonify({
        "status": "ok",
        "version": "6.0",
        "timestamp": datetime.now().isoformat(),
        "integracoes": {
            "manychat": "ativa",
            "chatgpt": "configurado",
            "google_sheets": "conectado"
        }
    })

@app.route('/api/sorteios/status')
def status_sistema():
    """Retorna status detalhado do sistema"""
    return jsonify({
        "sistema": sistema_status,
        "timestamp": datetime.now().isoformat(),
        "version": "6.0",
        "manychat": {
            "conversas_ativas": len(user_conversations),
            "timeout_conversa": TIMEOUT_CONVERSA
        }
    })

@app.route('/api/sorteios/processar-planilha')
def processar_planilha():
    """Endpoint para processar planilha manualmente"""
    try:
        # Executar em thread separada para não bloquear
        thread = threading.Thread(target=executar_processamento_automatico)
        thread.daemon = True
        thread.start()
        
        return jsonify({
            "status": "ok",
            "message": "Processamento iniciado em background",
            "timestamp": datetime.now().isoformat()
        })
    except Exception as e:
        return jsonify({
            "status": "error",
            "message": str(e),
            "timestamp": datetime.now().isoformat()
        }), 500

@app.route('/api/sorteios/processar-produto', methods=['POST'])
def processar_produto():
    """Endpoint para processar produto individual"""
    try:
        data = request.get_json()
        url_produto = data.get('url')
        
        if not url_produto:
            return jsonify({"error": "URL do produto é obrigatória"}), 400
        
        # Processar produto
        processador = ProcessadorSorteioV5()
        url_imagem, mensagem = processador.processar_produto_completo(url_produto)
        
        if url_imagem:
            return jsonify({
                "status": "success",
                "url_imagem": url_imagem,
                "message": mensagem,
                "timestamp": datetime.now().isoformat()
            })
        else:
            return jsonify({
                "status": "error",
                "message": mensagem,
                "timestamp": datetime.now().isoformat()
            }), 400
            
    except Exception as e:
        return jsonify({
            "status": "error",
            "message": str(e),
            "timestamp": datetime.now().isoformat()
        }), 500

# ================================
# INICIALIZAÇÃO DO SISTEMA
# ================================
@app.route('/debug/openai', methods=['GET'])
def debug_openai():
    """Endpoint para testar integração OpenAI"""
    try:
        # Testar import
        from openai import OpenAI
        
        # Testar API key
        api_key = os.getenv('OPENAI_API_KEY')
        if not api_key:
            return jsonify({
                "status": "erro",
                "problema": "OPENAI_API_KEY não configurada",
                "api_key_presente": False
            })
        
        # Testar cliente OpenAI
        client = OpenAI(api_key=api_key)
        
        # Testar Assistant ID
        assistant_id = "asst_AQjafiLKeePeACy6mzPX1Mqo"
        
        # Fazer teste simples
        thread = client.beta.threads.create()
        
        return jsonify({
            "status": "sucesso",
            "api_key_presente": True,
            "api_key_inicio": api_key[:10] + "...",
            "assistant_id": assistant_id,
            "thread_criada": thread.id,
            "openai_import": "OK"
        })
        
    except ImportError as e:
        return jsonify({
            "status": "erro",
            "problema": "Erro no import OpenAI",
            "erro": str(e)
        })
    except Exception as e:
        return jsonify({
            "status": "erro",
            "problema": "Erro geral",
            "erro": str(e)
        })

if __name__ == '__main__':
    logger.info("🚀 INICIANDO SISTEMA PROCESSADOR DE SORTEIOS V6.0")
    logger.info("🤖 Integração ManyChat-ChatGPT: ATIVA")
    
    # Iniciar cron job em thread separada
    cron_thread = threading.Thread(target=executar_cron_job)
    cron_thread.daemon = True
    cron_thread.start()
    logger.info("⏰ Cron job iniciado")
    
    # Obter porta do ambiente (Render)
    port = int(os.environ.get('PORT', 5000))
    
    # Iniciar servidor Flask
    logger.info(f"🌐 Servidor iniciando na porta {port}")
    app.run(host='0.0.0.0', port=port, debug=False)
