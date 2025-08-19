#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tarefa Agendada (Cron Job) para o Sistema Processador de Sorteios V5.0.
Este script é executado de forma independente pelo agendador do Render (ou outro serviço cron)
para verificar e processar produtos pendentes na planilha do Google Sheets.

Autor: Sistema Manus V5.0
Data: Julho 2025
"""

import logging
import os
import time
from datetime import datetime

# ---------------------- LOGGING ----------------------
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [CRON JOB] [%(levelname)s] %(message)s"
)
logger = logging.getLogger(__name__)

# ====================================================
# BLOCO DE IMPORTAÇÃO RESILIENTE
# ====================================================
# Objetivo:
# 1) Tentar seu import original: from main import sheets_manager, processador, sistema_status
# 2) Se falhar, tentar módulos diretos e instanciar
# 3) Se nada disso existir, usar fallback HTTP (chama a API)
sheets_manager = None
processador = None
sistema_status = None
MODO = "direto"  # "direto" usa objetos Python; "http" dispara endpoint

def _tentar_importar_do_main():
    global sheets_manager, processador, sistema_status
    try:
        from main import sheets_manager as sm, processador as pr, sistema_status as st
        sheets_manager, processador, sistema_status = sm, pr, st
        logger.info("✅ Import ok: objetos vindos de main.py")
        return True
    except Exception as e:
        logger.warning(f"⚠️  Falha ao importar de main.py: {e}")
        return False

def _tentar_importar_modulos_diretos():
    """Fallback: importa módulos diretos e instancia classes comuns."""
    global sheets_manager, processador, sistema_status
    ok = False

    # sheets_manager
    if sheets_manager is None:
        for modname, clsname in [
            ("sheets_manager", "SheetsManager"),
            ("utils.sheets_manager", "SheetsManager"),
            ("managers.sheets_manager", "SheetsManager"),
        ]:
            try:
                mod = __import__(modname, fromlist=[clsname])
                cls = getattr(mod, clsname, None)
                if cls:
                    sheets_manager = cls()
                    ok = True
                    logger.info(f"✅ Import ok: {modname}.{clsname}")
                    break
            except Exception:
                pass

    # processador (image processor)
    if processador is None:
        for modname, clsname in [
            ("image_processor", "Processador"),
            ("processor", "Processador"),
            ("processador", "Processador"),
            ("utils.image_processor", "Processador"),
        ]:
            try:
                mod = __import__(modname, fromlist=[clsname])
                cls = getattr(mod, clsname, None)
                if cls:
                    processador = cls()
                    ok = True
                    logger.info(f"✅ Import ok: {modname}.{clsname}")
                    break
            except Exception:
                pass

    # sistema_status (dict)
    if sistema_status is None:
        for modname, varname in [
            ("state", "sistema_status"),
            ("utils.state", "sistema_status"),
            ("status", "sistema_status"),
        ]:
            try:
                mod = __import__(modname, fromlist=[varname])
                val = getattr(mod, varname, None)
                if isinstance(val, dict):
                    sistema_status = val
                    ok = True
                    logger.info(f"✅ Import ok: {modname}.{varname}")
                    break
            except Exception:
                pass

        if sistema_status is None:
            sistema_status = {
                "status": "Idle",
                "ultima_execucao": None,
                "produtos_processados": 0,
                "erros": 0,
            }

    return ok

def _configurar_modo():
    global MODO
    if _tentar_importar_do_main():
        MODO = "direto"
        return
    if _tentar_importar_modulos_diretos():
        MODO = "direto"
        return
    MODO = "http"
    logger.warning("🔁 Entrando em modo Fallback HTTP (não foram encontrados módulos Python compatíveis).")

_configurar_modo()

# ====================================================
# FALLBACK HTTP (caso não tenhamos objetos Python)
# ====================================================
def _headers():
    h = {"User-Agent": "processador-cron-job/1.0"}
    token = os.getenv("API_TOKEN", "")
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h

def _processar_via_http():
    """Dispara a API pública /api/sorteios/processar-planilha (com retries)"""
    import requests

    base = (os.getenv("API_BASE_URL") or "").rstrip("/")
    path = os.getenv("API_PATH", "/api/sorteios/processar-planilha")
    url = f"{base}{path}"
    if not base:
        logger.error("❌ API_BASE_URL não definido. Configure a ENV no cron job.")
        return

    timeout = int(os.getenv("HTTP_TIMEOUT", "25"))
    retries = int(os.getenv("HTTP_RETRIES", "3"))
    backoff = float(os.getenv("HTTP_BACKOFF", "2.0"))

    logger.info(f"➡️  Chamada HTTP: {url}")

    last_exc = None
    for attempt in range(1, retries + 1):
        try:
            resp = requests.get(url, timeout=timeout, headers=_headers())
            if 200 <= resp.status_code < 300:
                logger.info(f"✅ HTTP {resp.status_code}: {resp.text[:300]}")
                return
            logger.warning(f"⚠️  HTTP {resp.status_code}: {resp.text[:300]}")
        except Exception as e:
            last_exc = e
            logger.warning(f"⚠️  Erro na tentativa {attempt}: {e}")

        if attempt < retries:
            sleep_s = backoff * attempt
            logger.info(f"⏳ Retry em {sleep_s:.1f}s…")
            time.sleep(sleep_s)

    if last_exc:
        logger.error(f"❌ Falhou após {retries} tentativas: {last_exc}")

# ====================================================
# SUA FUNÇÃO ORIGINAL (mantida)
# ====================================================
def executar_tarefa_de_processamento():
    """
    Função principal que executa toda a lógica de verificação e processamento.
    É o ponto de entrada para o Cron Job.
    """
    logger.info("==================================================")
    logger.info("🚀 INICIANDO TAREFA AGENDADA DE PROCESSAMENTO")
    logger.info("==================================================")

    # Se estamos no modo HTTP, dispare o endpoint e encerre
    if MODO == "http":
        _processar_via_http()
        logger.info("🏁 TAREFA AGENDADA FINALIZADA (modo HTTP)")
        logger.info("==================================================")
        return

    # MODO DIRETO (objetos Python disponíveis)
    try:
        sistema_status["status"] = "Executando verificação agendada..."
    except Exception:
        pass

    # Verifica dependência crítica
    if not os.environ.get('GOOGLE_CREDENTIALS'):
        logger.error("🔥 ERRO CRÍTICO: Variável de ambiente GOOGLE_CREDENTIALS não encontrada! A tarefa não pode continuar.")
        try:
            sistema_status["status"] = "Erro: GOOGLE_CREDENTIALS não configurada no Cron Job."
        except Exception:
            pass
        return

    try:
        # 1. Obter produtos pendentes da planilha
        logger.info("🔍 Buscando produtos pendentes na planilha...")
        produtos_pendentes = sheets_manager.obter_produtos_pendentes()

        if not produtos_pendentes:
            logger.info("✅ Nenhum produto pendente encontrado. Tarefa concluída.")
            try:
                sistema_status["status"] = "Verificação concluída, nenhum produto pendente."
                sistema_status["ultima_execucao"] = datetime.now().isoformat()
            except Exception:
                pass
            return

        logger.info(f"📋 Encontrado(s) {len(produtos_pendentes)} produto(s) para processar.")
        try:
            sistema_status["status"] = f"Processando {len(produtos_pendentes)} produto(s)..."
        except Exception:
            pass

        # 2. Iterar e processar cada produto encontrado
        produtos_processados_nesta_execucao = 0
        erros_nesta_execucao = 0

        for produto in produtos_pendentes:
            linha_num = produto.get('linha')
            nome_prod = produto.get('produto') or produto.get('nome') or ""
            url_prod = produto.get('url') or produto.get('URL') or ""

            logger.info(f"--- Processando: '{nome_prod}' (Linha {linha_num}) ---")

            try:
                # Executa o fluxo completo de processamento para um produto
                url_imagem_final, mensagem = processador.processar_produto_completo(url_prod)

                if url_imagem_final:
                    # Atualiza a planilha (duas assinaturas suportadas)
                    sucesso_update = False
                    if hasattr(sheets_manager, "atualizar_imagem_processada"):
                        sucesso_update = sheets_manager.atualizar_imagem_processada(linha_num, url_imagem_final)
                    elif hasattr(sheets_manager, "atualizar_resultado"):
                        sucesso_update = sheets_manager.atualizar_resultado(linha_num, url_imagem_final, erro=None)

                    if sucesso_update:
                        logger.info(f"✔️ SUCESSO: Produto '{nome_prod}' processado e planilha atualizada.")
                        produtos_processados_nesta_execucao += 1
                    else:
                        logger.error(f"❌ FALHA: Produto '{nome_prod}' processado, mas erro ao atualizar a planilha.")
                        erros_nesta_execucao += 1
                else:
                    logger.error(f"❌ FALHA ao processar '{nome_prod}'. Motivo: {mensagem}")
                    erros_nesta_execucao += 1

                # Pausa anti-bloqueio
                time.sleep(5)

            except Exception as e:
                logger.error(f"🔥 ERRO INESPERADO ao processar o item '{nome_prod}': {e}", exc_info=True)
                erros_nesta_execucao += 1

        # 3. Atualiza status
        try:
            sistema_status["ultima_execucao"] = datetime.now().isoformat()
            sistema_status["produtos_processados"] = int(sistema_status.get("produtos_processados", 0)) + produtos_processados_nesta_execucao
            sistema_status["erros"] = int(sistema_status.get("erros", 0)) + erros_nesta_execucao
            sistema_status["status"] = f"Execução concluída: {produtos_processados_nesta_execucao} sucesso(s), {erros_nesta_execucao} erro(s)."
        except Exception:
            pass

        logger.info(f"📊 Resumo da execução: {produtos_processados_nesta_execucao} sucesso(s), {erros_nesta_execucao} erro(s).")

    except Exception as e:
        logger.error(f"🔥 ERRO FATAL na execução principal da tarefa: {e}", exc_info=True)
        try:
            sistema_status["status"] = f"Erro fatal no Cron Job: {e}"
        except Exception:
            pass

    finally:
        logger.info("==================================================")
        logger.info("🏁 TAREFA AGENDADA FINALIZADA")
        logger.info("==================================================")


if __name__ == '__main__':
    executar_tarefa_de_processamento()
