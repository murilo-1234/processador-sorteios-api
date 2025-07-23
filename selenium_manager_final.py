# -*- coding: utf-8 -*-
"""
Gerenciador Selenium para Automação Manychat
Busca blocos por texto visível (não por IDs)
"""

import time
import json
import re
import logging
from datetime import datetime, timedelta
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.common.exceptions import (
    TimeoutException, NoSuchElementException, 
    WebDriverException, ElementNotInteractableException
)
from config_final import *

class SeleniumManager:
    def __init__(self):
        self.driver = None
        self.wait = None
        self.logger = logging.getLogger(__name__)
        
    def inicializar_driver(self):
        """Inicializa o driver Chrome com configurações otimizadas"""
        try:
            chrome_options = Options()
            
            # Adiciona todas as opções configuradas
            for option in CHROME_OPTIONS:
                chrome_options.add_argument(option)
            
            # Configura diretório de dados do usuário para manter sessão
            chrome_options.add_argument(f'--user-data-dir={CHROME_USER_DATA_DIR}')
            
            # Configurações adicionais para Render.com
            chrome_options.add_argument('--disable-background-timer-throttling')
            chrome_options.add_argument('--disable-backgrounding-occluded-windows')
            chrome_options.add_argument('--disable-renderer-backgrounding')
            
            self.driver = webdriver.Chrome(options=chrome_options)
            self.driver.implicitly_wait(SELENIUM_IMPLICIT_WAIT)
            self.wait = WebDriverWait(self.driver, SELENIUM_TIMEOUT)
            
            self.logger.info("✅ Driver Chrome inicializado com sucesso")
            return True
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao inicializar driver: {e}")
            return False
    
    def verificar_sessao_ativa(self):
        """Verifica se a sessão do Manychat está ativa"""
        try:
            if not self.driver:
                return False
                
            # Navega para página principal do Manychat
            self.driver.get("https://app.manychat.com/")
            time.sleep(3)
            
            # Verifica se está logado (não redirecionou para login)
            current_url = self.driver.current_url
            if 'login' in current_url.lower() or 'auth' in current_url.lower():
                self.logger.warning("🚨 Sessão expirada - necessário novo login")
                return False
            
            self.logger.info("✅ Sessão Manychat ativa")
            return True
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao verificar sessão: {e}")
            return False
    
    def encontrar_blocos_por_texto(self, textos_busca, timeout=10):
        """Encontra blocos na página usando lista de textos possíveis"""
        blocos_encontrados = []
        
        for texto in textos_busca:
            for seletor_template in SELETORES_BLOCO:
                try:
                    seletor = seletor_template.format(texto)
                    elementos = self.driver.find_elements(By.XPATH, seletor)
                    
                    for elemento in elementos:
                        if elemento.is_displayed() and elemento not in blocos_encontrados:
                            blocos_encontrados.append(elemento)
                            self.logger.debug(f"🔍 Bloco encontrado: '{texto}' via seletor {seletor}")
                
                except Exception as e:
                    self.logger.debug(f"Seletor falhou: {seletor} - {e}")
                    continue
        
        self.logger.info(f"📊 Encontrados {len(blocos_encontrados)} blocos")
        return blocos_encontrados
    
    def atualizar_blocos_condicionais(self, automacao, data_sorteio):
        """Atualiza todos os blocos condicionais de uma automação"""
        try:
            self.logger.info(f"📅 Atualizando blocos condicionais para {automacao}")
            
            # Calcula as datas
            data_base = datetime.strptime(data_sorteio, "%d/%m/%Y")
            datas = {
                'dia_sorteio': data_base.strftime("%d/%m/%Y"),
                'dia_sorteio_menos_1': (data_base - timedelta(days=1)).strftime("%d/%m/%Y"),
                'dia_sorteio_menos_2': (data_base - timedelta(days=2)).strftime("%d/%m/%Y"),
                'dia_sorteio_menos_3': (data_base - timedelta(days=3)).strftime("%d/%m/%Y")
            }
            
            blocos_atualizados = 0
            
            # Atualiza cada tipo de bloco condicional
            for tipo_bloco, nova_data in datas.items():
                textos_busca = BLOCOS_CONDICIONAIS[tipo_bloco]
                blocos = self.encontrar_blocos_por_texto(textos_busca)
                
                for i, bloco in enumerate(blocos, 1):
                    if self.atualizar_bloco_condicional(bloco, nova_data, f"{tipo_bloco}_{i}"):
                        blocos_atualizados += 1
            
            self.logger.info(f"✅ {blocos_atualizados} blocos condicionais atualizados")
            return blocos_atualizados
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao atualizar blocos condicionais: {e}")
            return 0
    
    def atualizar_bloco_condicional(self, bloco, nova_data, nome_bloco):
        """Atualiza um bloco condicional específico"""
        try:
            # Clica no bloco para abrir editor
            self.driver.execute_script("arguments[0].click();", bloco)
            time.sleep(2)
            
            # Procura campo de data
            campo_data = None
            for seletor in SELETORES_CAMPO_DATA:
                try:
                    campo_data = self.wait.until(EC.element_to_be_clickable((By.XPATH, seletor)))
                    break
                except TimeoutException:
                    continue
            
            if not campo_data:
                self.logger.warning(f"⚠️ Campo de data não encontrado em {nome_bloco}")
                return False
            
            # Limpa e insere nova data
            campo_data.clear()
            campo_data.send_keys(nova_data)
            time.sleep(1)
            
            # Salva alterações
            if self.salvar_alteracoes():
                self.logger.info(f"✏️ Bloco '{nome_bloco}' atualizado → {nova_data}")
                return True
            
            return False
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao atualizar bloco {nome_bloco}: {e}")
            return False
    
    def atualizar_blocos_planilha(self, automacao, url_planilha):
        """Atualiza blocos de planilha com URL e mapeamentos"""
        try:
            self.logger.info(f"📊 Atualizando blocos de planilha para {automacao}")
            
            blocos = self.encontrar_blocos_por_texto(BLOCOS_PLANILHA)
            blocos_atualizados = 0
            
            for i, bloco in enumerate(blocos, 1):
                if self.atualizar_bloco_planilha(bloco, automacao, url_planilha, f"planilha_{i}"):
                    blocos_atualizados += 1
            
            self.logger.info(f"✅ {blocos_atualizados} blocos de planilha atualizados")
            return blocos_atualizados
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao atualizar blocos de planilha: {e}")
            return 0
    
    def atualizar_bloco_planilha(self, bloco, automacao, url_planilha, nome_bloco):
        """Atualiza um bloco de planilha específico"""
        try:
            # Clica no bloco para abrir editor
            self.driver.execute_script("arguments[0].click();", bloco)
            time.sleep(3)
            
            # Atualiza URL da planilha
            if not self.atualizar_url_planilha(url_planilha):
                return False
            
            # Configura mapeamentos
            if not self.configurar_mapeamentos_planilha(automacao):
                return False
            
            # Salva alterações
            if self.salvar_alteracoes():
                self.logger.info(f"✏️ Bloco '{nome_bloco}' atualizado com nova planilha")
                return True
            
            return False
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao atualizar bloco planilha {nome_bloco}: {e}")
            return False
    
    def atualizar_url_planilha(self, url_planilha):
        """Atualiza URL da planilha no campo específico"""
        try:
            # Procura campo de planilha (pode ter diferentes seletores)
            seletores_planilha = [
                "//input[contains(@placeholder, 'planilha')]",
                "//input[contains(@placeholder, 'Planilha')]",
                "//input[contains(@placeholder, 'spreadsheet')]",
                "//input[@type='url']",
                "//input[contains(@class, 'url')]"
            ]
            
            campo_planilha = None
            for seletor in seletores_planilha:
                try:
                    campo_planilha = self.driver.find_element(By.XPATH, seletor)
                    if campo_planilha.is_displayed():
                        break
                except NoSuchElementException:
                    continue
            
            if not campo_planilha:
                self.logger.warning("⚠️ Campo de URL da planilha não encontrado")
                return False
            
            # Atualiza URL
            campo_planilha.clear()
            campo_planilha.send_keys(url_planilha)
            time.sleep(1)
            
            return True
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao atualizar URL da planilha: {e}")
            return False
    
    def configurar_mapeamentos_planilha(self, automacao):
        """Configura mapeamentos de campos da planilha"""
        try:
            # Monta mapeamentos completos
            mapeamentos = CAMPOS_FIXOS_MAPEAMENTO.copy()
            campo_variavel = CAMPOS_VARIAVEIS_MAPEAMENTO.get(automacao)
            
            if campo_variavel:
                mapeamentos[campo_variavel] = COLUNA_DESTINO_VARIAVEL
            
            # Aplica cada mapeamento
            for campo_manychat, coluna_sheets in mapeamentos.items():
                self.aplicar_mapeamento_campo(campo_manychat, coluna_sheets)
            
            return True
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao configurar mapeamentos: {e}")
            return False
    
    def aplicar_mapeamento_campo(self, campo_manychat, coluna_sheets):
        """Aplica mapeamento de um campo específico"""
        try:
            # Procura campo do Manychat
            seletor_campo = f"//div[contains(text(), '{campo_manychat}')]"
            campo = self.driver.find_element(By.XPATH, seletor_campo)
            
            # Clica no campo
            campo.click()
            time.sleep(1)
            
            # Procura dropdown ou campo de mapeamento
            seletor_mapeamento = f"//option[contains(text(), '{coluna_sheets}')]"
            opcao = self.driver.find_element(By.XPATH, seletor_mapeamento)
            opcao.click()
            
            self.logger.debug(f"🔗 Mapeamento: {campo_manychat} → {coluna_sheets}")
            
        except Exception as e:
            self.logger.debug(f"⚠️ Mapeamento falhou: {campo_manychat} → {coluna_sheets}: {e}")
    
    def atualizar_blocos_acao(self, automacao, novo_sorteio_id):
        """Atualiza blocos de ação com novo sorteio_id"""
        try:
            self.logger.info(f"🎬 Atualizando blocos de ação para {automacao}")
            
            blocos = self.encontrar_blocos_por_texto(BLOCOS_ACAO)
            blocos_atualizados = 0
            
            for i, bloco in enumerate(blocos, 1):
                if self.atualizar_bloco_acao(bloco, novo_sorteio_id, f"acao_{i}"):
                    blocos_atualizados += 1
            
            self.logger.info(f"✅ {blocos_atualizados} blocos de ação atualizados")
            return blocos_atualizados
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao atualizar blocos de ação: {e}")
            return 0
    
    def atualizar_bloco_acao(self, bloco, novo_sorteio_id, nome_bloco):
        """Atualiza um bloco de ação específico"""
        try:
            # Clica no bloco para abrir editor
            self.driver.execute_script("arguments[0].click();", bloco)
            time.sleep(3)
            
            # Procura campo de corpo/JSON
            campo_json = None
            seletores_json = [
                "//textarea[contains(@class, 'json')]",
                "//textarea[contains(@placeholder, 'JSON')]",
                "//textarea[contains(@placeholder, 'corpo')]",
                "//textarea",
                "//*[@contenteditable='true']"
            ]
            
            for seletor in seletores_json:
                try:
                    campo_json = self.driver.find_element(By.XPATH, seletor)
                    if campo_json.is_displayed():
                        break
                except NoSuchElementException:
                    continue
            
            if not campo_json:
                self.logger.warning(f"⚠️ Campo JSON não encontrado em {nome_bloco}")
                return False
            
            # Obtém conteúdo atual
            conteudo_atual = campo_json.get_attribute('value') or campo_json.text
            
            # Atualiza sorteio_id no JSON
            padrao = r'"sorteio_id":\s*"[^"]*"'
            novo_conteudo = re.sub(padrao, f'"sorteio_id": "{novo_sorteio_id}"', conteudo_atual)
            
            if novo_conteudo == conteudo_atual:
                self.logger.warning(f"⚠️ sorteio_id não encontrado no JSON de {nome_bloco}")
                return False
            
            # Atualiza campo
            campo_json.clear()
            campo_json.send_keys(novo_conteudo)
            time.sleep(1)
            
            # Salva alterações
            if self.salvar_alteracoes():
                self.logger.info(f"✏️ Bloco '{nome_bloco}' atualizado → sorteio_id: {novo_sorteio_id}")
                return True
            
            return False
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao atualizar bloco ação {nome_bloco}: {e}")
            return False
    
    def salvar_alteracoes(self):
        """Salva alterações usando botão de salvar"""
        try:
            for seletor in SELETORES_BOTAO_SALVAR:
                try:
                    botao = self.wait.until(EC.element_to_be_clickable((By.XPATH, seletor)))
                    botao.click()
                    time.sleep(2)
                    self.logger.debug("💾 Alterações salvas")
                    return True
                except TimeoutException:
                    continue
            
            self.logger.warning("⚠️ Botão salvar não encontrado")
            return False
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao salvar: {e}")
            return False
    
    def navegar_para_automacao(self, automacao):
        """Navega para uma automação específica"""
        try:
            url = AUTOMACOES_URLS.get(automacao)
            if not url or url.startswith('URL_DA_AUTOMACAO'):
                self.logger.error(f"❌ URL da automação {automacao} não configurada")
                return False
            
            self.logger.info(f"🌐 Navegando para automação {automacao}")
            self.driver.get(url)
            time.sleep(5)
            
            # Verifica se carregou corretamente
            if 'manychat.com' not in self.driver.current_url:
                self.logger.error(f"❌ Falha ao carregar automação {automacao}")
                return False
            
            self.logger.info(f"✅ Automação {automacao} carregada")
            return True
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao navegar para {automacao}: {e}")
            return False
    
    def processar_automacao_completa(self, automacao, data_sorteio, url_planilha, sorteio_id):
        """Processa uma automação completa (todos os blocos)"""
        try:
            self.logger.info(f"🚀 Iniciando processamento completo: {automacao}")
            
            # Navega para automação
            if not self.navegar_para_automacao(automacao):
                return False
            
            resultados = {
                'condicionais': 0,
                'planilha': 0,
                'acao': 0
            }
            
            # Atualiza blocos condicionais
            resultados['condicionais'] = self.atualizar_blocos_condicionais(automacao, data_sorteio)
            
            # Atualiza blocos de planilha
            resultados['planilha'] = self.atualizar_blocos_planilha(automacao, url_planilha)
            
            # Atualiza blocos de ação
            resultados['acao'] = self.atualizar_blocos_acao(automacao, sorteio_id)
            
            total_atualizados = sum(resultados.values())
            self.logger.info(f"✅ Automação {automacao} concluída: {total_atualizados} blocos atualizados")
            
            return total_atualizados > 0
            
        except Exception as e:
            self.logger.error(f"❌ Erro no processamento de {automacao}: {e}")
            return False
    
    def fechar_driver(self):
        """Fecha o driver e limpa recursos"""
        try:
            if self.driver:
                self.driver.quit()
                self.driver = None
                self.wait = None
                self.logger.info("🔒 Driver fechado")
        except Exception as e:
            self.logger.error(f"❌ Erro ao fechar driver: {e}")
    
    def __enter__(self):
        """Context manager - entrada"""
        if self.inicializar_driver():
            return self
        raise Exception("Falha ao inicializar driver")
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager - saída"""
        self.fechar_driver()

# Função de conveniência
def processar_todas_automacoes(data_sorteio, url_planilha, sorteio_id):
    """Processa todas as automações configuradas"""
    resultados = {}
    
    try:
        with SeleniumManager() as selenium:
            if not selenium.verificar_sessao_ativa():
                return {'erro': 'Sessão Manychat expirada'}
            
            for automacao in AUTOMACOES_URLS.keys():
                if AUTOMACOES_URLS[automacao].startswith('URL_DA_AUTOMACAO'):
                    resultados[automacao] = {'erro': 'URL não configurada'}
                    continue
                
                sucesso = selenium.processar_automacao_completa(
                    automacao, data_sorteio, url_planilha, sorteio_id
                )
                resultados[automacao] = {'sucesso': sucesso}
        
        return resultados
        
    except Exception as e:
        logging.error(f"❌ Erro geral no processamento: {e}")
        return {'erro': str(e)}

if __name__ == "__main__":
    # Teste básico
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
    
    # Testa inicialização
    with SeleniumManager() as selenium:
        print("✅ SeleniumManager funcionando corretamente")

