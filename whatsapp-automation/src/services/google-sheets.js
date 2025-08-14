const path = require('path');
const { google } = require('googleapis');
const logger = require('../config/logger');
const DateUtils = require('../utils/date');

class GoogleSheetsService {
  constructor() {
    this.sheets = null;
    this.auth = null;
    this.spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    this.isInitialized = false;
  }

  /**
   * Inicializar serviço Google Sheets
   */
  async initialize() {
    try {
      logger.info('📊 Inicializando Google Sheets...');

      // Configurar autenticação via variável de ambiente ou arquivo
      let authConfig;
      
      if (process.env.GOOGLE_SHEETS_CREDENTIALS) {
        // Usar credenciais da variável de ambiente (produção)
        const credentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
        authConfig = {
          credentials,
          scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
        };
      } else {
        // Usar arquivo de credenciais (desenvolvimento)
        const credentialsPath = process.env.GOOGLE_SHEETS_CREDENTIALS_PATH || './src/config/google-credentials.json';
        authConfig = {
          keyFile: credentialsPath,
          scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
        };
      }

      this.auth = new google.auth.GoogleAuth(authConfig);

      // Criar cliente Sheets
      this.sheets = google.sheets({ version: 'v4', auth: this.auth });

      // Testar conexão
      await this.testConnection();

      this.isInitialized = true;
      logger.info('✅ Google Sheets inicializado com sucesso');

    } catch (error) {
      logger.error('❌ Erro ao inicializar Google Sheets:', error);
      throw error;
    }
  }

  /**
   * Testar conexão com a planilha
   */
  async testConnection() {
    try {
      const response = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId
      });

      logger.info(`📋 Conectado à planilha: ${response.data.properties.title}`);
      return true;

    } catch (error) {
      logger.error('❌ Erro ao testar conexão com Google Sheets:', error);
      throw new Error(`Falha na conexão com Google Sheets: ${error.message}`);
    }
  }

  /**
   * Obter dados de sorteios da planilha
   */
  async getSorteiosData(range = 'Sorteios!A:Z') {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      logger.info(`📊 Buscando dados da planilha: ${range}`);

      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: range,
        valueRenderOption: 'FORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING'
      });

      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        logger.warn('⚠️ Nenhum dado encontrado na planilha');
        return [];
      }

      // Primeira linha são os cabeçalhos
      const headers = rows[0];
      const data = rows.slice(1);

      // Converter para objetos
      const sorteios = data.map((row, index) => {
        const sorteio = {};
        headers.forEach((header, colIndex) => {
          sorteio[header] = row[colIndex] || '';
        });
        sorteio._rowIndex = index + 2; // +2 porque começamos da linha 2 (header é linha 1)
        return sorteio;
      });

      logger.info(`📊 ${sorteios.length} sorteios encontrados na planilha`);
      return sorteios;

    } catch (error) {
      logger.error('❌ Erro ao buscar dados da planilha:', error);
      throw error;
    }
  }

  /**
   * Buscar sorteios de uma data específica
   */
  async getSorteiosPorData(data) {
    try {
      const todosSorteios = await this.getSorteiosData();
      
      // Filtrar por data
      const sorteiosDaData = todosSorteios.filter(sorteio => {
        const dataSorteio = this.extrairDataSorteio(sorteio);
        return DateUtils.normalizarDataPlanilha(dataSorteio) === DateUtils.normalizarDataPlanilha(data);
      });

      logger.info(`🎯 ${sorteiosDaData.length} sorteios encontrados para a data ${data}`);
      return sorteiosDaData;

    } catch (error) {
      logger.error(`❌ Erro ao buscar sorteios da data ${data}:`, error);
      throw error;
    }
  }

  /**
   * Buscar sorteios de hoje
   */
  async getSorteiosHoje() {
    const hoje = DateUtils.getHojeBrasil();
    return await this.getSorteiosPorData(hoje);
  }

  /**
   * Buscar sorteios de ontem
   */
  async getSorteiosOntem() {
    const ontem = DateUtils.getOntemBrasil();
    return await this.getSorteiosPorData(ontem);
  }

  /**
   * Extrair data do sorteio do objeto
   */
  extrairDataSorteio(sorteio) {
    // Tentar diferentes campos que podem conter a data
    const camposData = ['Data', 'Data do Sorteio', 'data', 'data_sorteio', 'Data Sorteio'];
    
    for (const campo of camposData) {
      if (sorteio[campo]) {
        return sorteio[campo];
      }
    }

    logger.warn('⚠️ Campo de data não encontrado no sorteio:', Object.keys(sorteio));
    return null;
  }

  /**
   * Extrair código do sorteio
   */
  extrairCodigoSorteio(sorteio) {
    const camposCodigo = ['Código', 'codigo', 'Codigo Sorteio', 'ID', 'id'];
    
    for (const campo of camposCodigo) {
      if (sorteio[campo]) {
        return sorteio[campo];
      }
    }

    logger.warn('⚠️ Campo de código não encontrado no sorteio:', Object.keys(sorteio));
    return null;
  }

  /**
   * Extrair nome do prêmio
   */
  extrairNomePremio(sorteio) {
    const camposPremio = ['Prêmio', 'premio', 'Nome do Prêmio', 'Produto', 'produto'];
    
    for (const campo of camposPremio) {
      if (sorteio[campo]) {
        return sorteio[campo];
      }
    }

    logger.warn('⚠️ Campo de prêmio não encontrado no sorteio:', Object.keys(sorteio));
    return 'Prêmio não especificado';
  }

  /**
   * Extrair URL do resultado
   */
  extrairUrlResultado(sorteio) {
    const camposUrl = ['URL Resultado', 'url_resultado', 'Link', 'link', 'URL'];
    
    for (const campo of camposUrl) {
      if (sorteio[campo]) {
        return sorteio[campo];
      }
    }

    // Se não encontrar URL, tentar construir baseado no código
    const codigo = this.extrairCodigoSorteio(sorteio);
    if (codigo) {
      return `https://sorteios-info.murilo1234.workers.dev/resultado/${codigo}`;
    }

    logger.warn('⚠️ URL do resultado não encontrada para o sorteio:', Object.keys(sorteio));
    return null;
  }

  /**
   * Validar dados do sorteio
   */
  validarSorteio(sorteio) {
    const erros = [];

    const codigo = this.extrairCodigoSorteio(sorteio);
    if (!codigo) {
      erros.push('Código do sorteio não encontrado');
    }

    const data = this.extrairDataSorteio(sorteio);
    if (!data) {
      erros.push('Data do sorteio não encontrada');
    } else if (!DateUtils.isDataValida(data)) {
      erros.push(`Data do sorteio inválida: ${data}`);
    }

    const premio = this.extrairNomePremio(sorteio);
    if (!premio) {
      erros.push('Nome do prêmio não encontrado');
    }

    return {
      valido: erros.length === 0,
      erros
    };
  }

  /**
   * Processar dados do sorteio para formato padronizado
   */
  processarSorteio(sorteio) {
    const validacao = this.validarSorteio(sorteio);
    
    if (!validacao.valido) {
      logger.warn(`⚠️ Sorteio inválido:`, validacao.erros);
      return null;
    }

    return {
      codigo: this.extrairCodigoSorteio(sorteio),
      data: DateUtils.normalizarDataPlanilha(this.extrairDataSorteio(sorteio)),
      premio: this.extrairNomePremio(sorteio),
      urlResultado: this.extrairUrlResultado(sorteio),
      dadosOriginais: sorteio,
      processadoEm: new Date().toISOString()
    };
  }

  /**
   * Obter sorteios processados de hoje
   */
  async getSorteiosProcessadosHoje() {
    try {
      const sorteiosHoje = await this.getSorteiosHoje();
      const sorteiosProcessados = [];

      for (const sorteio of sorteiosHoje) {
        const processado = this.processarSorteio(sorteio);
        if (processado) {
          sorteiosProcessados.push(processado);
        }
      }

      logger.info(`✅ ${sorteiosProcessados.length} sorteios válidos processados de hoje`);
      return sorteiosProcessados;

    } catch (error) {
      logger.error('❌ Erro ao processar sorteios de hoje:', error);
      throw error;
    }
  }

  /**
   * Obter sorteios processados de ontem
   */
  async getSorteiosProcessadosOntem() {
    try {
      const sorteiosOntem = await this.getSorteiosOntem();
      const sorteiosProcessados = [];

      for (const sorteio of sorteiosOntem) {
        const processado = this.processarSorteio(sorteio);
        if (processado) {
          sorteiosProcessados.push(processado);
        }
      }

      logger.info(`✅ ${sorteiosProcessados.length} sorteios válidos processados de ontem`);
      return sorteiosProcessados;

    } catch (error) {
      logger.error('❌ Erro ao processar sorteios de ontem:', error);
      throw error;
    }
  }

  /**
   * Obter informações da planilha
   */
  async getSpreadsheetInfo() {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      const response = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId
      });

      const info = {
        title: response.data.properties.title,
        locale: response.data.properties.locale,
        timeZone: response.data.properties.timeZone,
        sheets: response.data.sheets.map(sheet => ({
          title: sheet.properties.title,
          sheetId: sheet.properties.sheetId,
          rowCount: sheet.properties.gridProperties.rowCount,
          columnCount: sheet.properties.gridProperties.columnCount
        }))
      };

      return info;

    } catch (error) {
      logger.error('❌ Erro ao obter informações da planilha:', error);
      throw error;
    }
  }

  /**
   * Health check do serviço
   */
  async healthCheck() {
    try {
      if (!this.isInitialized) {
        return { status: 'error', message: 'Serviço não inicializado' };
      }

      await this.testConnection();
      
      return { 
        status: 'ok', 
        spreadsheetId: this.spreadsheetId,
        initialized: this.isInitialized
      };

    } catch (error) {
      return { 
        status: 'error', 
        message: error.message 
      };
    }
  }
}

module.exports = GoogleSheetsService;

