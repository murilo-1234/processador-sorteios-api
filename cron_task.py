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

# Importa as classes e instâncias necessárias do arquivo principal da aplicação.
# Certifique-se de que o nome do arquivo (app) está correto.
try:
    from app import sheets_manager, processador, sistema_status
except ImportError as e:
    print(f"Erro: Não foi possível importar de 'app.py': {e}. Certifique-se de que o arquivo existe e não há erros de importação circular.")
    exit(1)

# Configura um logger específico para a execução do Cron Job
logging.basicConfig(level=logging.INFO, format='[%(asctime)s] [CRON JOB] [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

def executar_tarefa_de_processamento():
    """
    Função principal que executa toda a lógica de verificação e processamento.
    É o ponto de entrada para o Cron Job.
    """
    logger.info("==================================================")
    logger.info("🚀 INICIANDO TAREFA AGENDADA DE PROCESSAMENTO")
    logger.info("==================================================")

    # Atualiza o status global para refletir a execução do Cron
    sistema_status["status"] = "Executando verificação agendada..."

    # Verifica a dependência mais crítica antes de começar
    if not os.environ.get('GOOGLE_CREDENTIALS'):
        logger.error("🔥 ERRO CRÍTICO: Variável de ambiente GOOGLE_CREDENTIALS não encontrada! A tarefa não pode continuar.")
        sistema_status["status"] = "Erro: GOOGLE_CREDENTIALS não configurada no Cron Job."
        return

    try:
        # 1. Obter produtos pendentes da planilha
        logger.info("🔍 Buscando produtos pendentes na planilha...")
        produtos_pendentes = sheets_manager.obter_produtos_pendentes()
        
        if not produtos_pendentes:
            logger.info("✅ Nenhum produto pendente encontrado. Tarefa concluída.")
            sistema_status["status"] = "Verificação concluída, nenhum produto pendente."
            sistema_status["ultima_execucao"] = datetime.now().isoformat()
            return
        
        logger.info(f"📋 Encontrado(s) {len(produtos_pendentes)} produto(s) para processar.")
        sistema_status["status"] = f"Processando {len(produtos_pendentes)} produto(s)..."
        
        # 2. Iterar e processar cada produto encontrado
        produtos_processados_nesta_execucao = 0
        erros_nesta_execucao = 0

        for produto in produtos_pendentes:
            linha_num = produto['linha']
            nome_prod = produto['produto']
            url_prod = produto['url']
            
            logger.info(f"--- Processando: '{nome_prod}' (Linha {linha_num}) ---")
            
            try:
                # Executa o fluxo completo de processamento para um produto
                url_imagem_final, mensagem = processador.processar_produto_completo(url_prod)
                
                if url_imagem_final:
                    # Se o processamento foi bem-sucedido, atualiza a planilha
                    sucesso_update = sheets_manager.atualizar_imagem_processada(linha_num, url_imagem_final)
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
        sistema_status["ultima_execucao"] = datetime.now().isoformat()
        sistema_status["produtos_processados"] += produtos_processados_nesta_execucao
        sistema_status["erros"] += erros_nesta_execucao
        sistema_status["status"] = f"Execução concluída: {produtos_processados_nesta_execucao} sucesso(s), {erros_nesta_execucao} erro(s)."
        logger.info(f"📊 Resumo da execução: {produtos_processados_nesta_execucao} sucesso(s), {erros_nesta_execucao} erro(s).")

    except Exception as e:
        logger.error(f"🔥 ERRO FATAL na execução principal da tarefa: {e}", exc_info=True)
        sistema_status["status"] = f"Erro fatal no Cron Job: {e}"

    finally:
        logger.info("==================================================")
        logger.info("🏁 TAREFA AGENDADA FINALIZADA")
        logger.info("==================================================")


if __name__ == '__main__':
    # Este bloco é executado quando o script é chamado diretamente pelo Render
    executar_tarefa_de_processamento()
