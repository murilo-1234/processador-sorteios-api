#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sistema Processador de Sorteios V6.0 + Integração ManyChat-ChatGPT Multiplataforma
Sistema automatizado que lê Google Sheets, processa produtos da Natura 
com extração por código e validação de fundo branco conforme PDF.
Agora com integração ManyChat-ChatGPT para atendimento automatizado em:
- WhatsApp (platform: manychat)
- Instagram (platform: instagram) 
- Messenger (platform: messenger)

CORREÇÕES IMPLEMENTADAS:
- Extração por código NATBRA-XXXXX (não semântica)
- Validação de fundo branco ≥60% obrigatória
- Processamento conforme especificações do PDF
- Mapeamento correto das colunas E/G
- USO DE GITHUB SECRETS para credenciais
- INTEGRAÇÃO MANYCHAT-CHATGPT para atendimento 24/7
- ASSISTANTS API com assistente específico asst_AQjafiLKeePeACy6mzPX1Mqo
- CORREÇÃO RUNS ATIVOS para conversas fluidas
- SUPORTE MULTIPLATAFORMA: WhatsApp, Instagram, Messenger

Autor: Sistema Manus V6.0
Data: Janeiro 2025
"""

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
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import io
import re
from urllib.parse import urljoin
import gspread
from oauth2client.service_account import ServiceAccountCredentials
import tempfile
import numpy as np

from openai import OpenAI

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# ================================
# CONFIGURAÇÕES GLOBAIS
# ================================
PLANILHA_ID = "1D84AsjVlCeXmW2hJEIVKBj6EHWe4xYfB6wd-JpHf_Ug"

sistema_status = {
    "ultima_execucao": None,
    "produtos_processados": 0,
    "erros": 0,
    "status": "Serviço web online. Aguardando execução do Cron Job."
}

# ================================
# INTEGRAÇÃO MANYCHAT-CHATGPT
# ================================
def get_openai_client():
    api_key = os.getenv('OPENAI_API_KEY')
    if not api_key:
        raise ValueError("OPENAI_API_KEY não configurada")
    return OpenAI(api_key=api_key)

user_conversations = {}
ASSISTANT_ID = "asst_AQjafiLKeePeACy6mzPX1Mqo"
MAX_CONVERSAS = 1000
TIMEOUT_CONVERSA = 1800  # 30 min

def limpar_conversas_antigas():
    agora = time.time()
    usuarios_para_remover = []
    for user_id, conversa in user_conversations.items():
        if agora - conversa['last_activity'] > TIMEOUT_CONVERSA:
            usuarios_para_remover.append(user_id)
    for user_id in usuarios_para_remover:
        del user_conversations[user_id]
        logger.info(f"🧹 Conversa removida por timeout: {user_id}")

def detectar_automacao(message):
    message_lower = message.lower()
    automacoes = {
        'sorteio': ['sorteio', 'concurso', 'prêmio', 'ganhar', 'participar', 'sorteios'],
        'produto': ['produto', 'natura', 'catálogo', 'preço', 'perfume', 'maquiagem', 'creme'],
        'contato': ['contato', 'ajuda', 'suporte', 'atendimento', 'falar', 'conversar'],
        'pedido': ['pedido', 'compra', 'carrinho', 'quero', 'comprar', 'adquirir'],
        'entrega': ['entrega', 'prazo', 'rastreamento', 'correios', 'quando chega']
    }
    scores = {}
    for tipo, palavras in automacoes.items():
        score = 0
        for palavra in palavras:
            if palavra in message_lower:
                score += 1
        if score > 0:
            scores[tipo] = score
    if scores:
        return max(scores, key=scores.get)
    return None

def processar_com_chatgpt(message, user_name, user_id):
    try:
        logger.info(f"🤖 Iniciando processamento ChatGPT para {user_name}")
        client = get_openai_client()
        logger.info("✅ Cliente OpenAI criado")

        logger.info(f"🎯 Usando assistente: {ASSISTANT_ID}")
        global user_conversations

        current_time = time.time()
        expired_users = [uid for uid, conv in user_conversations.items() 
                         if current_time - conv.get('last_activity', 0) > 1800]
        for uid in expired_users:
            del user_conversations[uid]
            logger.info(f"🧹 Conversa expirada removida: {uid}")

        if user_id not in user_conversations:
            logger.info(f"🆕 Criando nova thread para {user_name}")
            thread = client.beta.threads.create()
            user_conversations[user_id] = {'thread_id': thread.id, 'last_activity': current_time}
            logger.info(f"✅ Thread criada: {thread.id}")
        else:
            thread_id = user_conversations[user_id]['thread_id']
            user_conversations[user_id]['last_activity'] = current_time
            logger.info(f"🔄 Usando thread existente: {thread_id}")

        thread_id = user_conversations[user_id]['thread_id']

        logger.info("🔍 Verificando runs ativos na thread")
        try:
            active_runs = client.beta.threads.runs.list(thread_id=thread_id, limit=5)
            for run in active_runs.data:
                if run.status in ['queued', 'in_progress']:
                    logger.info(f"⏳ Run ativo encontrado: {run.id} (status: {run.status})")
                    wait_attempts = 30
                    for attempt in range(wait_attempts):
                        run_status = client.beta.threads.runs.retrieve(thread_id=thread_id, run_id=run.id)
                        if run_status.status not in ['queued', 'in_progress']:
                            logger.info(f"✅ Run anterior terminou: {run_status.status}")
                            break
                        time.sleep(1)
                    if attempt >= wait_attempts - 1:
                        logger.warning("⚠️ Timeout aguardando run anterior - cancelando")
                        try:
                            client.beta.threads.runs.cancel(thread_id=thread_id, run_id=run.id)
                            logger.info("🚫 Run anterior cancelado")
                        except:
                            logger.warning("⚠️ Não foi possível cancelar run anterior")
                    break
            logger.info("✅ Thread livre para nova mensagem")
        except Exception as e:
            logger.warning(f"⚠️ Erro verificando runs ativos: {e}")

        logger.info("📝 Adicionando mensagem à thread")
        client.beta.threads.messages.create(thread_id=thread_id, role="user", content=f"{user_name}: {message}")

        logger.info(f"🚀 Executando assistente {ASSISTANT_ID}")
        run = client.beta.threads.runs.create(thread_id=thread_id, assistant_id=ASSISTANT_ID)

        logger.info("⏳ Aguardando resposta do assistente...")
        max_attempts = 30
        attempt = 0
        while attempt < max_attempts:
            run_status = client.beta.threads.runs.retrieve(thread_id=thread_id, run_id=run.id)
            if run_status.status == 'completed':
                logger.info("✅ Assistente concluído")
                break
            elif run_status.status in ['failed', 'cancelled', 'expired']:
                logger.error(f"❌ Assistente falhou: {run_status.status}")
                raise Exception(f"Assistente falhou: {run_status.status}")
            time.sleep(1)
            attempt += 1
        if attempt >= max_attempts:
            logger.error("❌ Timeout aguardando assistente")
            raise Exception("Timeout aguardando resposta do assistente")

        logger.info("📥 Obtendo resposta do assistente")
        messages = client.beta.threads.messages.list(thread_id=thread_id, order="desc", limit=1)
        if not messages.data:
            logger.error("❌ Nenhuma resposta encontrada")
            raise Exception("Nenhuma resposta encontrada")

        resposta = messages.data[0].content[0].text.value
        logger.info("✅ Resposta recebida do assistente")
        logger.info(f"✅ Resposta para {user_name}: {resposta[:50]}...")
        return resposta
    except Exception as e:
        logger.error(f"❌ Erro ChatGPT: {e}")
        return f"Desculpe {user_name}, estou com dificuldades técnicas. Tente novamente! 😊"

@app.route('/webhook/manychat', methods=['GET', 'POST'])
def webhook_manychat():
    try:
        logger.info(f"🔄 Webhook ManyChat - Método: {request.method}")
        if request.method == 'GET':
            logger.info("📋 Requisição GET recebida - Webhook funcionando")
            return jsonify({"status": "ok", "message": "Webhook ManyChat funcionando", "method": "GET",
                            "endpoint": "/webhook/manychat"})
        data = request.get_json()
        if not data:
            logger.warning("⚠️ Dados não fornecidos na requisição POST")
            return jsonify({"error": "Dados não fornecidos"}), 400

        message = data.get('message', '').strip()
        user_name = data.get('nome', 'Usuário')
        user_id = data.get('user_id', 'unknown')
        platform = data.get('platform', '')

        logger.info(f"🔄 Webhook recebido - Usuário: {user_name} ({user_id}) - Platform: {platform}")
        logger.info(f"📝 Mensagem: {message}")

        valid_platforms = ['manychat', 'instagram', 'messenger']
        if platform not in valid_platforms:
            logger.warning(f"⚠️ Platform inválida: {platform}. Plataformas suportadas: {valid_platforms}")
            return jsonify({"error": f"Platform inválida. Suportadas: {valid_platforms}"}), 400

        if not message:
            return jsonify({"messages": [{"text": "Desculpe, não consegui entender sua mensagem. Pode tentar novamente? 😊"}]})

        logger.info("🔍 Iniciando detecção de automação")
        tipo_automacao = detectar_automacao(message)
        if tipo_automacao:
            logger.info(f"🎯 Automação detectada: {tipo_automacao}")
        else:
            logger.info("📝 Nenhuma automação específica detectada")

        logger.info("🚀 CHAMANDO FUNÇÃO processar_com_chatgpt")
        logger.info(f"📋 Parâmetros: message='{message}', user_name='{user_name}', user_id='{user_id}'")
        try:
            resposta = processar_com_chatgpt(message, user_name, user_id)
            logger.info(f"✅ FUNÇÃO processar_com_chatgpt RETORNOU: {resposta[:50]}...")
        except Exception as e:
            logger.error(f"❌ ERRO NA FUNÇÃO processar_com_chatgpt: {e}")
            logger.error(f"❌ Tipo do erro: {type(e).__name__}")
            resposta = f"Desculpe {user_name}, estou com dificuldades técnicas. Tente novamente! 😊"

        if tipo_automacao:
            resposta += f"\n\n[Automação {tipo_automacao} detectada]"
            logger.info(f"🏷️ Adicionado indicador de automação: {tipo_automacao}")

        response = {"messages": [{"text": resposta}]}
        logger.info(f"✅ Resposta enviada para {user_name}")
        logger.info(f"📤 JSON resposta: {response}")
        return jsonify(response)
    except Exception as e:
        logger.error(f"❌ Erro no webhook ManyChat: {e}")
        return jsonify({"messages": [{"text": "Erro interno do servidor. Tente novamente mais tarde."}]}), 500

@app.route('/api/manychat/stats', methods=['GET'])
def stats_manychat():
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
# PROCESSADOR DE IMAGENS V5.0
# ================================
class ProcessadorSorteioV5:
    # limiar de não-branco para recorte; ajuste fino se necessário
    WHITE_T = 18

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept-Language': 'pt-BR,pt;q=0.9',
            'Referer': 'https://www.minhaloja.natura.com/'
        })
        logger.info("🎯 PROCESSADOR V5.0 INICIADO - Extração por código + validação fundo branco")

    def extrair_codigo_produto(self, url):
        try:
            m = re.search(r'((?:NATBRA|AVNBRA)-?\d+)', url, re.IGNORECASE)
            if m:
                bruto = m.group(1).upper()
                codigo = re.sub(r'^(NATBRA|AVNBRA)-?(\d+)$', r'\1-\2', bruto)
                logger.info(f"📋 Código extraído: {codigo}")
                return codigo
            else:
                logger.error("❌ Código NATBRA não encontrado na URL")
                return None
        except Exception as e:
            logger.error(f"❌ Erro ao extrair código: {e}")
            return None

    def validar_fundo_branco(self, img):
        try:
            if img.mode != 'RGB':
                img = img.convert('RGB')
            width, height = img.size
            pixels_brancos = 0
            pixels_amostrados = 0
            border_size = min(width, height) // 10

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
        try:
            logger.info(f"🔍 Buscando imagens para código: {codigo_produto}")
            response = self.session.get(url, timeout=20)
            if response.status_code != 200:
                return [], "Erro ao acessar página do produto"

            soup = BeautifulSoup(response.content, 'html.parser')
            html_text = response.text
            candidatas = []
            vistos = set()

            def lixo(u: str) -> bool:
                if not u:
                    return True
                ul = u.lower()
                if 'images.rede.natura.net' in ul:
                    return True
                if 'logo' in ul:
                    return True
                if 'banner' in ul:
                    return True
                if '/produtosjoia/background/' in ul:
                    return True
                if 'bannerjoia' in ul:
                    return True
                return False

            def add_cand(src, motivo, prio):
                if not src:
                    return
                if src.startswith('//'):
                    src = 'https:' + src
                if src.startswith('/'):
                    src = urljoin(url, src)
                src_clean = (src.split('?')[0] or '').strip()
                if not src_clean or lixo(src_clean):
                    return
                if src_clean not in vistos:
                    vistos.add(src_clean)
                    candidatas.append({'url': src_clean, 'score': 0, 'motivo': motivo, 'prio': prio})
                    logger.info(f"✅ Candidata ({motivo}): {src_clean}")

            def pick_srcset(val):
                try:
                    return val.split(',')[-1].strip().split(' ')[0]
                except Exception:
                    return None

            cdn_patterns = [
                r'https://production\.na01\.natura\.com/[^\s"\'\)]+/(?:Produtos|produtos)/(?:NATBRA|AVNBRA)-\d+_[1-4]\.(?:jpg|png)',
                r'https://production\.na01\.natura\.com/[^\s"\'\)]+/(?:NATBRA|AVNBRA)-\d+_[1-4]\.(?:jpg|png)'
            ]
            for pat in cdn_patterns:
                for m in re.findall(pat, html_text):
                    add_cand(m, 'regex CDN', 0)

            imgs = soup.find_all('img')
            for img in imgs:
                for attr in ('src', 'data-src', 'data-lazy-src', 'data-original', 'data-image'):
                    v = img.get(attr)
                    if v and (codigo_produto in v or codigo_produto.replace('-', '') in v):
                        add_cand(v, f'Contém código {codigo_produto}', 1)
                for attr in ('srcset', 'data-srcset'):
                    v = img.get(attr)
                    if v and (codigo_produto in v or codigo_produto.replace('-', '') in v):
                        add_cand(pick_srcset(v), f'srcset contém código {codigo_produto}', 1)

            for source in soup.find_all('source'):
                v = source.get('srcset') or source.get('data-srcset')
                if v and (codigo_produto in v or codigo_produto.replace('-', '') in v):
                    add_cand(pick_srcset(v), f'<source> contém código {codigo_produto}', 1)

            for el in soup.select('[style*="background-image"]'):
                style = el.get('style', '')
                for m in re.findall(r'url\(([^)]+)\)', style):
                    m = m.strip('\'" ')
                    if codigo_produto in m or codigo_produto.replace('-', '') in m:
                        add_cand(m, 'background-image contém código', 1)

            for lk in soup.select('link[rel="preload"][as="image"]'):
                add_cand(lk.get('href'), 'link preload image', 2)

            if not candidatas:
                for s in soup.select('script[type="application/ld+json"]'):
                    try:
                        data = json.loads(s.string or '')
                        img_field = data.get('image')
                        if isinstance(img_field, str):
                            add_cand(img_field, 'json-ld image', 2)
                        elif isinstance(img_field, list) and img_field:
                            add_cand(img_field[0], 'json-ld image[0]', 2)
                    except Exception:
                        continue

            if not candidatas:
                for sel in ('.product-gallery img', '.swiper-slide img', '.glide__slide img', '[data-testid="thumbnail"] img'):
                    for g in soup.select(sel):
                        add_cand(g.get('src') or g.get('data-src') or pick_srcset(g.get('srcset') or ''), f'galeria {sel}', 3)
                for source in soup.select('picture source'):
                    add_cand(pick_srcset(source.get('srcset') or ''), 'picture source', 3)

            if not candidatas:
                m = soup.find('meta', {'property': 'og:image'}) or soup.find('meta', {'name': 'twitter:image'})
                add_cand(m.get('content') if m else None, 'meta image', 4)

            if not candidatas:
                logger.error("❌ Nenhuma imagem candidata encontrada na página")
                return [], "Nenhuma imagem candidata encontrada na página"

            candidatas.sort(key=lambda x: x.get('prio', 99))
            logger.info(f"📋 Candidatas encontradas: {len(candidatas)}")
            return candidatas, "Candidatas extraídas com sucesso"
        except Exception as e:
            logger.error(f"❌ Erro ao extrair imagens: {e}")
            return [], f"Erro na extração: {str(e)}"

    def avaliar_e_selecionar_imagem(self, candidatas):
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
        try:
            logger.info("🎨 Processando imagem para sorteio...")
            img_produto.thumbnail((540, 540), Image.Resampling.LANCZOS)
            canvas = Image.new('RGB', (600, 600), (255, 255, 255))
            produto_width, produto_height = img_produto.size
            pos_x = (600 - produto_width) // 2
            pos_y = (600 - produto_height) // 2
            if img_produto.mode == 'RGBA':
                canvas.paste(img_produto, (pos_x, pos_y), img_produto)
            else:
                canvas.paste(img_produto, (pos_x, pos_y))
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
            cor_vermelha = (139, 0, 0)
            cor_contorno = (255, 255, 255)

            texto_superior = "Ganhe esse Top!"
            bbox_superior = draw.textbbox((0, 0), texto_superior, font=fonte_media)
            largura_superior = bbox_superior[2] - bbox_superior[0]
            x_superior = (600 - largura_superior) // 2
            y_superior = 20
            for dx in range(-4, 5):
                for dy in range(-4, 5):
                    if dx != 0 or dy != 0:
                        draw.text((x_superior + dx, y_superior + dy), texto_superior, font=fonte_media, fill=cor_contorno)
            draw.text((x_superior, y_superior), texto_superior, font=fonte_media, fill=cor_vermelha)

            texto_inferior = "Sorteio"
            bbox_inferior = draw.textbbox((0, 0), texto_inferior, font=fonte_grande)
            largura_inferior = bbox_inferior[2] - bbox_inferior[0]
            altura_inferior = bbox_inferior[3] - bbox_inferior[1]
            x_inferior = (600 - largura_inferior) // 2
            y_inferior = 600 - altura_inferior - 20
            for dx in range(-6, 7):
                for dy in range(-6, 7):
                    if dx != 0 or dy != 0:
                        draw.text((x_inferior + dx, y_inferior + dy), texto_inferior, font=fonte_grande, fill=cor_contorno)
            draw.text((x_inferior, y_inferior), texto_inferior, font=fonte_grande, fill=cor_vermelha)

            buffer = io.BytesIO()
            canvas.save(buffer, format='PNG', quality=95)
            buffer.seek(0)
            logger.info("✅ Imagem processada com sucesso")
            return buffer, "Imagem processada conforme PDF"
        except Exception as e:
            logger.error(f"❌ Erro ao processar imagem: {e}")
            return None, f"Erro no processamento: {str(e)}"

    # Vertical 1080x1920: recorte do fundo branco + escala até caber em 800×min(2*1500, 1920-2*margem)
    def processar_imagem_vertical_1080x1920(self, img_produto):
        try:
            logger.info("🎨 Processando imagem vertical 1080x1920 (sem texto)...")
            canvas_w, canvas_h = 1080, 1920
            canvas = Image.new('RGB', (canvas_w, canvas_h), (255, 255, 255))

            # Box útil e margens
            box_w = 800
            base_max_h = 1500
            margem_px = int(0.05 * min(canvas_w, canvas_h))  # 5% do lado menor
            max_h_canvas = canvas_h - 2 * margem_px
            box_h = min(2 * base_max_h, max_h_canvas)  # dobra e prende ao canvas

            # Garantir RGB
            if img_produto.mode not in ('RGB', 'RGBA'):
                img_produto = img_produto.convert('RGB')

            w0, h0 = img_produto.size
            if w0 <= 0 or h0 <= 0:
                raise ValueError("Dimensões inválidas da imagem do produto")

            # -------- 1) Máscara de não-branco e recorte --------
            if img_produto.mode == 'RGBA':
                base_rgb = Image.new('RGB', (w0, h0), (255, 255, 255))
                base_rgb.paste(img_produto, mask=img_produto.split()[-1])
                rgb = base_rgb
            else:
                rgb = img_produto

            arr = np.asarray(rgb, dtype=np.uint8)
            # distância para branco
            dist = np.maximum.reduce([255 - arr[..., 0], 255 - arr[..., 1], 255 - arr[..., 2]])
            mask = (dist > self.WHITE_T).astype(np.uint8) * 255

            # dilatação leve para fechar falhas finas
            mask_img = Image.fromarray(mask, mode='L').filter(ImageFilter.MaxFilter(3))
            mask = np.array(mask_img) > 0

            rows = np.where(mask.any(axis=1))[0]
            cols = np.where(mask.any(axis=0))[0]

            crop_img = rgb
            used_crop = False
            if rows.size > 0 and cols.size > 0:
                top, bottom = int(rows[0]), int(rows[-1])
                left, right = int(cols[0]), int(cols[-1])

                # padding 2%
                pad = int(0.02 * min(w0, h0))
                top = max(0, top - pad)
                left = max(0, left - pad)
                bottom = min(h0, bottom + pad)
                right = min(w0, right + pad)

                # checar se o recorte é significativo
                if (right - left) > 10 and (bottom - top) > 10:
                    crop_img = rgb.crop((left, top, right, bottom))
                    used_crop = True

            cw, ch = crop_img.size

            # -------- 2) Escalas: antiga vs nova --------
            old_scale = min(box_w / float(w0), box_h / float(h0))
            new_scale_base = min(box_w / float(cw), box_h / float(ch))

            # alvo: no mínimo o permitido pelo recorte; se couber, tente >= 2x da escala antiga
            target_scale = new_scale_base
            if new_scale_base >= 2.0 * old_scale:
                target_scale = new_scale_base
            else:
                # tentar forçar 2x, respeitando limites do box
                target_scale = min(2.0 * old_scale, new_scale_base)

            new_w = max(1, int(round(cw * target_scale)))
            new_h = max(1, int(round(ch * target_scale)))

            logger.info(
                f"📐 1080x1920 | box {box_w}x{box_h} | origem {w0}x{h0} | "
                f"{'crop ' if used_crop else ''}{cw}x{ch} | "
                f"esc_old {old_scale:.3f} esc_new {new_scale_base:.3f} "
                f"-> final {new_w}x{new_h}"
            )

            img_redim = crop_img.resize((new_w, new_h), Image.Resampling.LANCZOS)

            # -------- 3) Centralização --------
            pos_x = (canvas_w - new_w) // 2
            pos_y = (canvas_h - new_h) // 2
            canvas.paste(img_redim, (pos_x, pos_y))

            buffer = io.BytesIO()
            canvas.save(buffer, format='PNG', quality=95)
            buffer.seek(0)
            logger.info("✅ Imagem 1080x1920 pronta")
            return buffer, "Imagem 1080x1920 gerada"
        except Exception as e:
            logger.error(f"❌ Erro no processamento 1080x1920: {e}")
            return None, f"Erro no processamento 1080x1920: {str(e)}"

    def upload_catbox(self, buffer_imagem, nome_arquivo='sorteio.png'):
        try:
            logger.info("📤 Upload para Catbox.moe...")
            buffer_imagem.seek(0)
            files = {'fileToUpload': (nome_arquivo, buffer_imagem, 'image/png')}
            data = {'reqtype': 'fileupload'}
            headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
            response = requests.post('https://catbox.moe/user/api.php', files=files, data=data, headers=headers, timeout=60)
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
        try:
            logger.info(f"🚀 PROCESSAMENTO V5.0: {url_produto}")
            codigo = self.extrair_codigo_produto(url_produto)
            if not codigo:
                return None, None, "❌ Código NATBRA não encontrado na URL"
            candidatas, msg_extracao = self.extrair_imagens_por_codigo(url_produto, codigo)
            if not candidatas:
                return None, None, f"❌ Extração falhou: {msg_extracao}"
            img_produto, msg_selecao = self.avaliar_e_selecionar_imagem(candidatas)
            if not img_produto:
                return None, None, f"❌ Seleção falhou: {msg_selecao}"

            img_base1 = img_produto.copy()
            img_base2 = img_produto.copy()

            buffer_600, msg_processamento_600 = self.processar_imagem_sorteio(img_base1)
            if not buffer_600:
                return None, None, f"❌ Processamento falhou (600x600): {msg_processamento_600}"
            url_600, msg_upload_600 = self.upload_catbox(buffer_600, nome_arquivo='sorteio_600.png')
            if not url_600:
                return None, None, f"❌ Upload falhou (600x600): {msg_upload_600}"

            buffer_1080, msg_processamento_1080 = self.processar_imagem_vertical_1080x1920(img_base2)
            if not buffer_1080:
                logger.error(f"⚠️ Falha ao gerar 1080x1920: {msg_processamento_1080}")
                return url_600, None, "✅ 600x600 ok; 1080x1920 falhou"
            url_1080, msg_upload_1080 = self.upload_catbox(buffer_1080, nome_arquivo='sorteio_1080x1920.png')
            if not url_1080:
                logger.error(f"⚠️ Falha upload 1080x1920: {msg_upload_1080}")
                return url_600, None, "✅ 600x600 ok; upload 1080x1920 falhou"

            logger.info(f"🎉 SUCESSO: 600x600={url_600} | 1080x1920={url_1080}")
            return url_600, url_1080, "✅ Produto processado com sucesso"
        except Exception as e:
            logger.error(f"❌ Erro geral: {e}")
            return None, None, f"❌ Erro geral: {str(e)}"

# ================================
# GERENCIADOR GOOGLE SHEETS
# ================================
class GoogleSheetsManager:
    def __init__(self):
        self.planilha = None
        self.conectar()
    
    def conectar(self):
        try:
            logger.info("🔗 Conectando ao Google Sheets...")
            creds_json = os.getenv('GOOGLE_CREDENTIALS')
            if not creds_json:
                raise ValueError("GOOGLE_CREDENTIALS não encontrada no ambiente")
            creds_dict = json.loads(creds_json)
            scope = ['https://spreadsheets.google.com/feeds', 'https://www.googleapis.com/auth/drive']
            creds = ServiceAccountCredentials.from_json_keyfile_dict(creds_dict, scope)
            client = gspread.authorize(creds)
            self.planilha = client.open_by_key(PLANILHA_ID)
            logger.info("✅ Conectado ao Google Sheets com sucesso")
            return True
        except Exception as e:
            logger.error(f"❌ Erro ao conectar Google Sheets: {e}")
            self.planilha = None
            return False
    
    def obter_produtos_pendentes(self):
        try:
            if not self.planilha and not self.conectar():
                return []
            worksheet = self.planilha.get_worksheet(0)
            dados = worksheet.get_all_records()
            produtos_pendentes = []
            for i, linha in enumerate(dados, start=2):
                url_produto = linha.get('URL do Produto', '').strip()
                status = linha.get('Status', '').strip()
                if url_produto and status.lower() in ['pendente', '']:
                    produtos_pendentes.append({'linha': i, 'url': url_produto, 'dados': linha})
            logger.info(f"📋 Produtos pendentes encontrados: {len(produtos_pendentes)}")
            return produtos_pendentes
        except Exception as e:
            logger.error(f"❌ Erro ao obter produtos pendentes: {e}")
            return []
    
    def atualizar_resultado(self, linha, url_imagem=None, erro=None, url_imagem2=None):
        try:
            if not self.planilha and not self.conectar():
                return False
            worksheet = self.planilha.get_worksheet(0)
            headers = worksheet.row_values(1)
            col_status = None
            col_imagem = None
            col_erro = None
            col_imagem2 = None
            for i, header in enumerate(headers, 1):
                h = header.lower()
                if 'status' in h:
                    col_status = i
                elif ('imagem' in h or 'resultado' in h) and col_imagem is None:
                    col_imagem = i
                elif 'erro' in h or 'observ' in h:
                    col_erro = i
                if ('produto 2' in h) or ('url do produto 2' in h):
                    col_imagem2 = i

            if url_imagem:
                if col_status:
                    worksheet.update_cell(linha, col_status, "✅ Processado")
                if col_imagem:
                    worksheet.update_cell(linha, col_imagem, url_imagem)
                if url_imagem2 and col_imagem2:
                    worksheet.update_cell(linha, col_imagem2, url_imagem2)
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
    global sistema_status
    try:
        logger.info("🚀 INICIANDO PROCESSAMENTO AUTOMÁTICO V5.0")
        sistema_status["status"] = "Processando produtos..."
        sistema_status["ultima_execucao"] = datetime.now().isoformat()
        sheets_manager = GoogleSheetsManager()
        processador = ProcessadorSorteioV5()
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
                url_imagem, url_imagem2, mensagem = processador.processar_produto_completo(produto['url'])
                if url_imagem:
                    sheets_manager.atualizar_resultado(produto['linha'], url_imagem=url_imagem, url_imagem2=url_imagem2)
                    sucessos += 1
                    logger.info(f"✅ Linha {produto['linha']} processada com sucesso")
                else:
                    sheets_manager.atualizar_resultado(produto['linha'], erro=mensagem)
                    erros += 1
                    logger.error(f"❌ Linha {produto['linha']} falhou: {mensagem}")
                time.sleep(2)
            except Exception as e:
                logger.error(f"❌ Erro ao processar linha {produto['linha']}: {e}")
                sheets_manager.atualizar_resultado(produto['linha'], erro=str(e))
                erros += 1
        sistema_status["produtos_processados"] = sucessos
        sistema_status["erros"] = erros
        sistema_status["status"] = f"Processamento concluído. {sucessos} sucessos, {erros} erros."
        logger.info(f"🎉 PROCESSAMENTO CONCLUÍDO: {sucessos} sucessos, {erros} erros")
    except Exception as e:
        logger.error(f"❌ Erro no processamento automático: {e}")
        sistema_status["status"] = f"Erro no processamento: {str(e)}"
        sistema_status["erros"] += 1

def executar_cron_job():
    while True:
        try:
            time.sleep(1800)
            logger.info("⏰ Executando cron job automático...")
            executar_processamento_automatico()
        except Exception as e:
            logger.error(f"❌ Erro no cron job: {e}")
            time.sleep(300)

# ================================
# ROTAS DA API
# ================================
@app.route('/')
def dashboard():
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
    agora = time.time()
    conversas_ativas = sum(1 for conversa in user_conversations.values() 
                           if agora - conversa['last_activity'] < TIMEOUT_CONVERSA)
    return render_template_string(html, status=sistema_status, conversas_ativas=conversas_ativas)

@app.route('/api/sorteios/health')
def health_check():
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
    return jsonify({
        "sistema": sistema_status,
        "timestamp": datetime.now().isoformat(),
        "version": "6.0",
        "manychat": {
            "conversas_ativas": len(user_conversations),
            "timeout_conversa": TIMEOUT_CONVERSA
        }
    })

# aceitar GET e POST para o cron HTTP
@app.route('/api/sorteios/processar-planilha', methods=['GET', 'POST'])
def processar_planilha():
    try:
        thread = threading.Thread(target=executar_processamento_automatico, daemon=True)
        thread.start()
        return jsonify({
            "status": "ok",
            "message": "Processamento iniciado em background",
            "timestamp": datetime.now().isoformat()
        }), 202
    except Exception as e:
        return jsonify({
            "status": "error",
            "message": str(e),
            "timestamp": datetime.now().isoformat()
        }), 500

@app.route('/api/sorteios/processar-produto', methods=['POST'])
def processar_produto():
    try:
        data = request.get_json()
        url_produto = data.get('url')
        if not url_produto:
            return jsonify({"error": "URL do produto é obrigatória"}), 400
        processador = ProcessadorSorteioV5()
        url_imagem, url_imagem2, mensagem = processador.processar_produto_completo(url_produto)
        if url_imagem:
            return jsonify({"status": "success", "url_imagem": url_imagem, "url_imagem2": url_imagem2, "message": mensagem,
                            "timestamp": datetime.now().isoformat()})
        else:
            return jsonify({"status": "error", "message": mensagem,
                            "timestamp": datetime.now().isoformat()}), 400
    except Exception as e:
        return jsonify({"status": "error", "message": str(e),
                        "timestamp": datetime.now().isoformat()}), 500

# ================================
# INICIALIZAÇÃO DO SISTEMA
# ================================
if __name__ == '__main__':
    logger.info("🚀 INICIANDO SISTEMA PROCESSADOR DE SORTEIOS V6.0")
    logger.info("🤖 Integração ManyChat-ChatGPT: ATIVA")
    cron_thread = threading.Thread(target=executar_cron_job, daemon=True)
    cron_thread.start()
    logger.info("⏰ Cron job iniciado")
    port = int(os.environ.get('PORT', 5000))
    logger.info(f"🌐 Servidor iniciando na porta {port}")
    app.run(host='0.0.0.0', port=port, debug=False)
