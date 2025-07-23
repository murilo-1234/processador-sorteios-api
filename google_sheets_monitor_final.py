# -*- coding: utf-8 -*-
"""
Monitor Google Sheets para Sistema de Sorteios
Integrado com automação Manychat
CORRIGIDO: Usa coluna F para URL da planilha de participantes
"""

import logging
import gspread
from datetime import datetime, timedelta
from google.oauth2.service_account import Credentials
from config_final import *

class GoogleSheetsMonitor:
    def __init__(self):
        self.gc = None
        self.planilha_sorteios = None
        self.planilha_template = None
        self.logger = logging.getLogger(__name__)
        
    def inicializar_conexao(self):
        """Inicializa conexão com Google Sheets"""
        try:
            # Configura credenciais
            scopes = [
                'https://www.googleapis.com/auth/spreadsheets',
                'https://www.googleapis.com/auth/drive'
            ]
            
            credentials = Credentials.from_service_account_file(
                GOOGLE_CREDENTIALS_PATH, 
                scopes=scopes
            )
            
            self.gc = gspread.authorize(credentials)
            
            # Abre planilhas
            self.planilha_sorteios = self.gc.open_by_key(PLANILHA_SORTEIOS_ID)
            self.planilha_template = self.gc.open_by_key(PLANILHA_TEMPLATE_ID)
            
            self.logger.info("✅ Conexão Google Sheets estabelecida")
            return True
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao conectar Google Sheets: {e}")
            return False
    
    def obter_dados_sorteios(self):
        """Obtém todos os dados da planilha de sorteios"""
        try:
            worksheet = self.planilha_sorteios.sheet1
            dados = worksheet.get_all_records()
            
            self.logger.info(f"📊 {len(dados)} sorteios encontrados na planilha")
            return dados
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao obter dados de sorteios: {e}")
            return []
    
    def verificar_novos_sorteios(self):
        """Verifica se há novos sorteios para criar planilhas"""
        try:
            dados = self.obter_dados_sorteios()
            novos_sorteios = []
            
            for i, sorteio in enumerate(dados, start=2):  # Linha 2 é a primeira com dados
                # Verifica se campos A, B, C, D estão preenchidos e F está vazio
                # CORREÇÃO: Mudou de 'url_planilha' para verificar coluna F
                if (sorteio.get('ad') and 
                    sorteio.get('nome') and 
                    sorteio.get('data') and 
                    sorteio.get('hora') and 
                    not sorteio.get('url_planilha')):  # COLUNA F
                    
                    sorteio['linha'] = i
                    novos_sorteios.append(sorteio)
            
            if novos_sorteios:
                self.logger.info(f"🆕 {len(novos_sorteios)} novos sorteios detectados")
            
            return novos_sorteios
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao verificar novos sorteios: {e}")
            return []
    
    def criar_planilha_participantes(self, sorteio):
        """Cria planilha de participantes baseada no template"""
        try:
            nome_sorteio = sorteio.get('nome', f"Sorteio {sorteio.get('ad')}")
            
            # Copia template
            nova_planilha = self.gc.copy(
                PLANILHA_TEMPLATE_ID,
                title=f"Participantes - {nome_sorteio}",
                copy_permissions=True
            )
            
            # Obtém URL da nova planilha
            url_planilha = f"https://docs.google.com/spreadsheets/d/{nova_planilha.id}/edit"
            
            self.logger.info(f"📋 Planilha criada: {nome_sorteio}")
            return url_planilha
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao criar planilha: {e}")
            return None
    
    def atualizar_url_planilha(self, linha, url_planilha):
        """Atualiza campo F com URL da planilha criada"""
        try:
            worksheet = self.planilha_sorteios.sheet1
            # CORREÇÃO: Mudou de coluna 5 (E) para coluna 6 (F)
            worksheet.update_cell(linha, 6, url_planilha)  # Coluna F = 6
            
            self.logger.info(f"✅ URL atualizada na coluna F, linha {linha}")
            return True
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao atualizar URL: {e}")
            return False
    
    def processar_novos_sorteios(self):
        """Processa todos os novos sorteios encontrados"""
        try:
            novos_sorteios = self.verificar_novos_sorteios()
            processados = 0
            
            for sorteio in novos_sorteios:
                # Cria planilha de participantes
                url_planilha = self.criar_planilha_participantes(sorteio)
                
                if url_planilha:
                    # Atualiza campo F na planilha principal
                    if self.atualizar_url_planilha(sorteio['linha'], url_planilha):
                        processados += 1
                        self.logger.info(f"✅ Sorteio processado: {sorteio.get('nome')}")
            
            if processados > 0:
                self.logger.info(f"🎯 {processados} novos sorteios processados")
            
            return processados
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao processar novos sorteios: {e}")
            return 0
    
    def verificar_sorteios_finalizados(self):
        """Verifica se há sorteios que acabaram de finalizar"""
        try:
            dados = self.obter_dados_sorteios()
            agora = datetime.now()
            sorteios_finalizados = []
            
            for sorteio in dados:
                if not all([sorteio.get('data'), sorteio.get('hora')]):
                    continue
                
                try:
                    # Converte data e hora para datetime
                    data_str = sorteio.get('data')
                    hora_str = sorteio.get('hora')
                    
                    # Tenta diferentes formatos de data
                    for formato_data in ['%d/%m/%Y', '%Y-%m-%d', '%d-%m-%Y']:
                        try:
                            data_sorteio = datetime.strptime(data_str, formato_data)
                            break
                        except ValueError:
                            continue
                    else:
                        self.logger.warning(f"⚠️ Formato de data inválido: {data_str}")
                        continue
                    
                    # Tenta diferentes formatos de hora
                    for formato_hora in ['%H:%M', '%H:%M:%S']:
                        try:
                            hora_sorteio = datetime.strptime(hora_str, formato_hora).time()
                            break
                        except ValueError:
                            continue
                    else:
                        self.logger.warning(f"⚠️ Formato de hora inválido: {hora_str}")
                        continue
                    
                    # Combina data e hora
                    datetime_sorteio = datetime.combine(data_sorteio.date(), hora_sorteio)
                    
                    # Verifica se o sorteio finalizou nos últimos 10 minutos
                    diferenca = agora - datetime_sorteio
                    if timedelta(0) <= diferenca <= timedelta(minutes=10):
                        sorteios_finalizados.append(sorteio)
                        self.logger.info(f"🎯 Sorteio finalizado: {sorteio.get('nome')}")
                
                except Exception as e:
                    self.logger.warning(f"⚠️ Erro ao processar sorteio {sorteio.get('nome')}: {e}")
                    continue
            
            return sorteios_finalizados
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao verificar sorteios finalizados: {e}")
            return []
    
    def obter_proximo_sorteio(self):
        """Obtém dados do próximo sorteio (data mais próxima no futuro)"""
        try:
            dados = self.obter_dados_sorteios()
            agora = datetime.now()
            proximo_sorteio = None
            menor_diferenca = None
            
            for sorteio in dados:
                # CORREÇÃO: Mudou para verificar 'url_planilha' (coluna F)
                if not all([sorteio.get('data'), sorteio.get('hora'), sorteio.get('url_planilha')]):
                    continue
                
                try:
                    # Converte data e hora
                    data_str = sorteio.get('data')
                    hora_str = sorteio.get('hora')
                    
                    # Tenta diferentes formatos
                    for formato_data in ['%d/%m/%Y', '%Y-%m-%d', '%d-%m-%Y']:
                        try:
                            data_sorteio = datetime.strptime(data_str, formato_data)
                            break
                        except ValueError:
                            continue
                    else:
                        continue
                    
                    for formato_hora in ['%H:%M', '%H:%M:%S']:
                        try:
                            hora_sorteio = datetime.strptime(hora_str, formato_hora).time()
                            break
                        except ValueError:
                            continue
                    else:
                        continue
                    
                    datetime_sorteio = datetime.combine(data_sorteio.date(), hora_sorteio)
                    
                    # Verifica se é no futuro
                    if datetime_sorteio > agora:
                        diferenca = datetime_sorteio - agora
                        
                        if menor_diferenca is None or diferenca < menor_diferenca:
                            menor_diferenca = diferenca
                            proximo_sorteio = sorteio
                
                except Exception as e:
                    continue
            
            if proximo_sorteio:
                self.logger.info(f"📅 Próximo sorteio: {proximo_sorteio.get('nome')}")
            
            return proximo_sorteio
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao obter próximo sorteio: {e}")
            return None
    
    def obter_dados_para_automacao(self):
        """Obtém dados necessários para atualização das automações"""
        try:
            proximo_sorteio = self.obter_proximo_sorteio()
            
            if not proximo_sorteio:
                return None
            
            dados = {
                'sorteio_id': proximo_sorteio.get('ad'),
                'nome': proximo_sorteio.get('nome'),
                'data': proximo_sorteio.get('data'),
                'hora': proximo_sorteio.get('hora'),
                # CORREÇÃO: Mudou para 'url_planilha' (coluna F)
                'url_planilha': proximo_sorteio.get('url_planilha')
            }
            
            self.logger.info(f"📋 Dados para automação: {dados['nome']}")
            return dados
            
        except Exception as e:
            self.logger.error(f"❌ Erro ao obter dados para automação: {e}")
            return None
    
    def executar_verificacao_completa(self):
        """Executa verificação completa: novos sorteios + finalizados"""
        try:
            self.logger.info("🔍 Iniciando verificação completa")
            
            resultados = {
                'novos_processados': 0,
                'sorteios_finalizados': [],
                'proximo_sorteio': None,
                'dados_automacao': None
            }
            
            # Processa novos sorteios
            resultados['novos_processados'] = self.processar_novos_sorteios()
            
            # Verifica sorteios finalizados
            resultados['sorteios_finalizados'] = self.verificar_sorteios_finalizados()
            
            # Se há sorteios finalizados, obtém dados para automação
            if resultados['sorteios_finalizados']:
                resultados['proximo_sorteio'] = self.obter_proximo_sorteio()
                resultados['dados_automacao'] = self.obter_dados_para_automacao()
            
            self.logger.info("✅ Verificação completa concluída")
            return resultados
            
        except Exception as e:
            self.logger.error(f"❌ Erro na verificação completa: {e}")
            return None
    
    def testar_conexao(self):
        """Testa conexão e acesso às planilhas"""
        try:
            if not self.inicializar_conexao():
                return False
            
            # Testa acesso à planilha de sorteios
            dados = self.obter_dados_sorteios()
            if not isinstance(dados, list):
                return False
            
            # Testa acesso ao template
            template_info = self.planilha_template.sheet1.get('A1')
            
            self.logger.info("✅ Teste de conexão bem-sucedido")
            return True
            
        except Exception as e:
            self.logger.error(f"❌ Teste de conexão falhou: {e}")
            return False

# Função de conveniência
def executar_monitoramento():
    """Executa monitoramento completo das planilhas"""
    try:
        monitor = GoogleSheetsMonitor()
        
        if not monitor.inicializar_conexao():
            return {'erro': 'Falha na conexão Google Sheets'}
        
        return monitor.executar_verificacao_completa()
        
    except Exception as e:
        logging.error(f"❌ Erro no monitoramento: {e}")
        return {'erro': str(e)}

if __name__ == "__main__":
    # Teste básico
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
    
    monitor = GoogleSheetsMonitor()
    if monitor.testar_conexao():
        print("✅ GoogleSheetsMonitor funcionando corretamente")
        
        # Executa verificação de teste
        resultados = monitor.executar_verificacao_completa()
        print(f"📊 Resultados: {resultados}")
    else:
        print("❌ Erro na conexão Google Sheets")
