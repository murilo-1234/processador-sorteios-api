const axios = require('axios');
const logger = require('../config/logger');
const metricsService = require('./metrics');

class ScraperService {
  constructor() {
    this.baseUrl = 'https://sorteios-info.murilo1234.workers.dev';
    this.timeout = 30000; // 30 segundos
    this.retryAttempts = 3;
    this.retryDelay = 2000; // 2 segundos
  }

  /**
   * Fazer scraping dos dados de um sorteio
   */
  async scrapeSorteio(codigoSorteio) {
    const url = `${this.baseUrl}/resultado/${codigoSorteio}`;
    
    try {
      logger.info(`🔍 Fazendo scraping do sorteio: ${codigoSorteio}`);
      
      const dados = await this.fetchWithRetry(url);
      const resultado = this.parsearResultado(dados, codigoSorteio);
      
      logger.info(`✅ Scraping concluído para sorteio ${codigoSorteio}`);
      return resultado;
      
    } catch (error) {
      logger.error(`❌ Erro no scraping do sorteio ${codigoSorteio}:`, error);
      metricsService.recordScrapingError('sorteios-info', error.name || 'unknown');
      throw error;
    }
  }

  /**
   * Fazer requisição HTTP com retry
   */
  async fetchWithRetry(url, attempt = 1) {
    try {
      const response = await axios.get(url, {
        timeout: this.timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        }
      });

      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response.data;

    } catch (error) {
      if (attempt < this.retryAttempts) {
        logger.warn(`⚠️ Tentativa ${attempt} falhou, tentando novamente em ${this.retryDelay}ms...`);
        await this.sleep(this.retryDelay);
        return this.fetchWithRetry(url, attempt + 1);
      }
      
      throw error;
    }
  }

  /**
   * Parsear resultado HTML para extrair dados
   */
  parsearResultado(html, codigoSorteio) {
    try {
      // Extrair dados usando regex (método mais simples para este caso)
      const resultado = {
        codigo: codigoSorteio,
        ganhador: this.extrairGanhador(html),
        premio: this.extrairPremio(html),
        dataRealizacao: this.extrairDataRealizacao(html),
        horaRealizacao: this.extrairHoraRealizacao(html),
        totalParticipantes: this.extrairTotalParticipantes(html),
        urlCompleta: `${this.baseUrl}/resultado/${codigoSorteio}`,
        scrapedAt: new Date().toISOString()
      };

      // Validar dados extraídos
      this.validarResultado(resultado);
      
      return resultado;

    } catch (error) {
      logger.error(`❌ Erro ao parsear resultado do sorteio ${codigoSorteio}:`, error);
      throw new Error(`Falha no parsing: ${error.message}`);
    }
  }

  /**
   * Extrair nome do ganhador
   */
  extrairGanhador(html) {
    // Padrões possíveis para encontrar o ganhador
    const padroes = [
      /(?:ganhador|winner)[\s\S]*?<[^>]*>([^<]+)</i,
      /🎉\s*([^🎉\n]+)/i,
      /👑\s*([^👑\n]+)/i,
      /vencedor[:\s]*([^\n<]+)/i,
      /sorteado[:\s]*([^\n<]+)/i
    ];

    for (const padrao of padroes) {
      const match = html.match(padrao);
      if (match && match[1]) {
        const ganhador = match[1].trim();
        if (ganhador.length > 2 && ganhador.length < 100) {
          return ganhador;
        }
      }
    }

    // Tentar extrair de meta tags
    const metaMatch = html.match(/<meta[^>]*content="[^"]*ganhador[^"]*([^"]+)"/i);
    if (metaMatch && metaMatch[1]) {
      return metaMatch[1].trim();
    }

    throw new Error('Nome do ganhador não encontrado');
  }

  /**
   * Extrair nome do prêmio
   */
  extrairPremio(html) {
    const padroes = [
      /<title>([^<]+)</i,
      /(?:prêmio|premio|prize)[\s\S]*?<[^>]*>([^<]+)</i,
      /🎁\s*([^🎁\n]+)/i,
      /sorteio[:\s]*([^\n<]+)/i
    ];

    for (const padrao of padroes) {
      const match = html.match(padrao);
      if (match && match[1]) {
        let premio = match[1].trim();
        
        // Limpar título se necessário
        premio = premio.replace(/\s*-\s*sorteio.*$/i, '');
        premio = premio.replace(/\s*-\s*resultado.*$/i, '');
        
        if (premio.length > 5 && premio.length < 200) {
          return premio;
        }
      }
    }

    return 'Prêmio não especificado';
  }

  /**
   * Extrair data de realização
   */
  extrairDataRealizacao(html) {
    const padroes = [
      /(\d{1,2}\/\d{1,2}\/\d{4})/,
      /(\d{4}-\d{2}-\d{2})/,
      /(?:data|date)[\s\S]*?(\d{1,2}\/\d{1,2}\/\d{4})/i
    ];

    for (const padrao of padroes) {
      const match = html.match(padrao);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * Extrair hora de realização
   */
  extrairHoraRealizacao(html) {
    const padroes = [
      /(\d{1,2}:\d{2})/,
      /(?:hora|time)[\s\S]*?(\d{1,2}:\d{2})/i
    ];

    for (const padrao of padroes) {
      const match = html.match(padrao);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * Extrair total de participantes
   */
  extrairTotalParticipantes(html) {
    const padroes = [
      /(\d+)\s*participantes?/i,
      /total[:\s]*(\d+)/i,
      /(\d+)\s*inscritos?/i
    ];

    for (const padrao of padroes) {
      const match = html.match(padrao);
      if (match && match[1]) {
        return parseInt(match[1]);
      }
    }

    return null;
  }

  /**
   * Validar resultado extraído
   */
  validarResultado(resultado) {
    if (!resultado.ganhador || resultado.ganhador.length < 2) {
      throw new Error('Nome do ganhador inválido ou não encontrado');
    }

    if (!resultado.premio || resultado.premio.length < 5) {
      throw new Error('Nome do prêmio inválido ou não encontrado');
    }

    // Verificar se o ganhador não é um texto genérico
    const textosGenericos = [
      'não encontrado',
      'não disponível',
      'em breve',
      'aguarde',
      'loading',
      'carregando'
    ];

    const ganhadorLower = resultado.ganhador.toLowerCase();
    for (const texto of textosGenericos) {
      if (ganhadorLower.includes(texto)) {
        throw new Error(`Ganhador parece ser um texto genérico: ${resultado.ganhador}`);
      }
    }
  }

  /**
   * Verificar se um sorteio existe
   */
  async verificarSorteioExiste(codigoSorteio) {
    const url = `${this.baseUrl}/resultado/${codigoSorteio}`;
    
    try {
      const response = await axios.head(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      return response.status === 200;

    } catch (error) {
      if (error.response && error.response.status === 404) {
        return false;
      }
      
      logger.warn(`⚠️ Erro ao verificar existência do sorteio ${codigoSorteio}:`, error.message);
      return false;
    }
  }

  /**
   * Fazer scraping de múltiplos sorteios
   */
  async scrapeMultiplosSorteios(codigosSorteios) {
    const resultados = [];
    const erros = [];

    logger.info(`🔍 Iniciando scraping de ${codigosSorteios.length} sorteios...`);

    for (const codigo of codigosSorteios) {
      try {
        const resultado = await this.scrapeSorteio(codigo);
        resultados.push(resultado);
        
        // Pausa entre requisições para evitar rate limiting
        await this.sleep(1000);
        
      } catch (error) {
        erros.push({
          codigo,
          erro: error.message
        });
      }
    }

    logger.info(`✅ Scraping concluído: ${resultados.length} sucessos, ${erros.length} erros`);

    return {
      sucessos: resultados,
      erros: erros,
      total: codigosSorteios.length
    };
  }

  /**
   * Obter dados completos de um sorteio (planilha + scraping)
   */
  async obterDadosCompletos(sorteioBase) {
    try {
      // Fazer scraping dos dados atualizados
      const dadosScraping = await this.scrapeSorteio(sorteioBase.codigo);
      
      // Combinar dados da planilha com dados do scraping
      const dadosCompletos = {
        ...sorteioBase,
        ganhador: dadosScraping.ganhador,
        totalParticipantes: dadosScraping.totalParticipantes,
        dataRealizacao: dadosScraping.dataRealizacao || sorteioBase.data,
        horaRealizacao: dadosScraping.horaRealizacao,
        dadosScraping: dadosScraping,
        atualizadoEm: new Date().toISOString()
      };

      return dadosCompletos;

    } catch (error) {
      logger.error(`❌ Erro ao obter dados completos do sorteio ${sorteioBase.codigo}:`, error);
      throw error;
    }
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Health check do serviço
   */
  async healthCheck() {
    try {
      const testUrl = `${this.baseUrl}`;
      const response = await axios.get(testUrl, { timeout: 5000 });
      
      return {
        status: 'ok',
        baseUrl: this.baseUrl,
        responseTime: response.headers['x-response-time'] || 'unknown'
      };

    } catch (error) {
      return {
        status: 'error',
        message: error.message,
        baseUrl: this.baseUrl
      };
    }
  }
}

module.exports = ScraperService;

