#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tarefa Agendada (Cron Job) para o Sistema Processador de Sorteios V5.0.
Executada pelo agendador do Render para verificar e processar produtos pendentes
na planilha do Google Sheets.

Autor: Sistema Manus V5.0
Data: Julho 2025
"""

import logging
import os
import time
from datetime import datetime

# -----------------------------------------------------------------------------
# IMPORTAÇÃO RESILIENTE (mantém compatibilidade com refactors no main.py)
# -----------------------------------------------------------------------------
# Objetivo:
# 1) Tentar exatamente o que você já tinha: from main import sheets_manager, processador, sistema_status
# 2) Se não existir mais no main, tentar importar dos módulos diretos (sheets_manager.py, image_processor.py, processor.py, state.py)
# 3) Se vierem classes (SheetsManager/Processador), instanciar aqui.
# 4) Evitar importação circular: só importar o que precisa, sem puxar endpoints/app web.

sheets_manager = None
processador = None
sistema_status = None

def _tentar_importar_do_main():
    global sheets_manager, processador, sistema_status
    try:
        import main  # não explode se existir mas não tiver os nomes
        # pega símbolos se existirem
        if getattr(main, "sheets_manager", None):
            sheets_manager = main.sheets_manager
        if getattr(main, "processador", None):
            processador = main.processador
        if getattr(main, "sistema_status", None):
            sistema_status = main.sistema_status
        return True
    except Exception:
        return False

def _tentar_importar_modulos_diretos():
    """Fallback: importa módulos diretos e instancia se necessário."""
    global sheets_manager, processador, sistema_status

    # sheets_manager
    if sheets_manager is None:
        # tentativas de nomes comuns
        for modname, clsname in [
            ("sheets_manager", "SheetsManager"),
            ("utils.sheets_manager", "SheetsManager"),
            ("managers.sheets_manager", "SheetsManager")
        ]:
            try:
                mod = __import__(modname, fromlist=[clsname])
                cls = getattr(mod, clsname, None)
                if cls:
                    sheets_manager = cls()
                    break
            except Exception:
                pass

    # processador (image processor)
    if processador is None:
        for modname, clsname in [
            ("image_processor", "Processador"),
            ("processor", "Processador"),
            ("processador", "Processador"),
            ("utils.image_processor", "Processador")
        ]:
            try:
                mod = __import__(modname, fromlist=[clsname])
                cls = getattr(mod, clsname, None)
                if cls:
                    processador = cls()
                    break
            except Exception:
                pass

    # sistema_status (dict de estado)
    if sistema_status is None:
        # 1) tentar de um módulo de estado dedicado
        for modname, varname in [
            ("state", "sistema_status"),
            ("utils.state", "sistema_status"),
            ("status", "sistema_status")
        ]:
            try:
                mod = __import__(modname, fromlist=[varname])
                val = getattr(mod, varname, None)
                if isinstance(val, dict):
                    sistema_status = val
                    break
            except Exception:
                pass

        # 2) se ainda não existir, cria um dicionário local (compatível)
        if sistema_status is None:
            sistema_status = {
                "status": "Idle",
                "ultima_execucao": None,
                "produtos_processados": 0,
                "erros": 0,
            }

# Tenta importar do main; se não conseguir todos os símbolos, completa com fallbacks
_main_ok = _tentar_importar_do_main()
_tentar_importar_modulos_diretos()

# Validação final: garantir que temos objetos utilizáveis
if sheets_manager is None or processador is None or sistema_status is None:
    print("Erro: Não foi possível obter 'sheets_manager', 'processador' e/ou 'sistema_status'. "
          "Verifique se os módulos/classes existem. Evitando falha silenciosa.")
    exit(1)

# -----------------------------------------------------------------------------
# LOGGING
# -----------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="[%(asctime)s] [CRON JOB] [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# -----------------------------------------------------------------------------
# FUNÇÃO PRINCIPAL
# -----------------------------------------------------------------------------
def executar_tarefa_de_processamento():
    """
    Função principal que executa toda a lógica de verificação e processamento.
    É o ponto de entrada para o Cron Job.
    """
    logger.info("==================================================")
    logger.info("🚀 INICIANDO TAREFA AGENDADA DE PROCESSAMENTO")
    logger.info("==================================================")

    # Atualiza o status global para refletir a execução do Cron
    try:
        sistema_status["status"] = "Executando verificação agendada..."
    except Exception:
        pass  # se for um mapping custom, ignore

    # Verifica a dependência mais crítica antes de começar
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
                    # Se o processamento foi bem-sucedido, atualiza a planilha
                    sucesso_update = False
                    # Tenta assinatura clássica:
                    if hasattr(sheets_manager, "atualizar_imagem_processada"):
                        sucesso_update = sheets_manager.atualizar_imagem_processada(linha_num, url_imagem_final)
                    else:
                        # fallback para uma assinatura alternativa comum
                        if hasattr(sheets_manager, "atualizar_resultado"):
                            sucesso_update = sheets_manager.atualizar_resultado(linha_num, url_imagem_final, erro=None)

                    if sucesso_update:
                        logger.info(f"✔️ SUCESSO: Produto '{nome_prod}' processado e planilha atualizada.")
                        produtos_processados_nesta_execucao += 1
                    else:
                        logger.error(f"❌ FALHA: Produto '{nome_prod}' processado, mas erro ao atualizar a planilha.")
                        erros_nesta_execucao += 1
                else:
                    # Se o processamento da imagem falhou
                    logger.error(f"❌ FALHA ao processar '{nome_prod}'. Motivo: {mensagem}")
                    erros_nesta_execucao += 1

                # Pausa para evitar sobrecarga e bloqueios
                time.sleep(5)

            except Exception as e:
                logger.error(f"🔥 ERRO INESPERADO ao processar o item '{nome_prod}': {e}", exc_info=True)
                erros_nesta_execucao += 1

        # Atualiza o status global com o resultado da execução
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
