const logger = require('../config/logger');
const database = require('../config/database');
const DateUtils = require('../utils/date');
const GoogleSheetsService = require('../services/google-sheets');
const ScraperService = require('../services/scraper');
const ImageGeneratorService = require('../services/image-generator-simple');
const metricsService = require('../services/metrics');

class SorteiosModule {
  constructor() {
    this.googleSheets = new GoogleSheetsService();
    this.scraper = new ScraperService();
    this.imageGenerator = new ImageGeneratorService();
    this.textosBase = [];
    this.cupomAtual = null;
  }

  /**
   * Processar sorteios diários (chamado pelo agendador)
   */
  async processarSorteiosDiarios(executionId) {
    const startTime = Date.now();
    
    try {
      logger.info('🎯 Iniciando processamento diário de sorteios...');
      
      // 1. Buscar sorteios de hoje na planilha
      const sorteiosPlanilha = await this.googleSheets.getSorteiosProcessadosHoje();
      
      if (sorteiosPlanilha.length === 0) {
        logger.info('ℹ️ Nenhum sorteio encontrado para hoje');
        metricsService.recordSorteioProcessado('no_sorteios');
        return;
      }

      logger.info(`📊 ${sorteiosPlanilha.length} sorteios encontrados na planilha`);

      // 2. Processar cada sorteio
      const resultados = [];
      for (const sorteio of sorteiosPlanilha) {
        try {
          const resultado = await this.processarSorteioIndividual(sorteio);
          resultados.push(resultado);
          metricsService.recordSorteioProcessado('success');
        } catch (error) {
          logger.error(`❌ Erro ao processar sorteio ${sorteio.codigo}:`, error);
          metricsService.recordSorteioProcessado('error');
        }
      }

      // 3. Registrar estatísticas
      const duration = (Date.now() - startTime) / 1000;
      metricsService.recordJobDuration('sorteios-diarios', 'completed', duration);
      
      logger.info(`✅ Processamento concluído: ${resultados.length}/${sorteiosPlanilha.length} sorteios processados`);
      
      return {
        total: sorteiosPlanilha.length,
        processados: resultados.length,
        executionId
      };

    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      metricsService.recordJobDuration('sorteios-diarios', 'failed', duration);
      
      logger.error('❌ Erro no processamento diário de sorteios:', error);
      throw error;
    }
  }

  /**
   * Processar um sorteio individual
   */
  async processarSorteioIndividual(sorteioBase) {
    const { codigo } = sorteioBase;
    
    try {
      logger.info(`🎯 Processando sorteio individual: ${codigo}`);

      // 1. Verificar se já foi processado
      const jaProcessado = await this.verificarSeJaProcessado(codigo);
      if (jaProcessado) {
        logger.info(`ℹ️ Sorteio ${codigo} já foi processado hoje`);
        return { codigo, status: 'already_processed' };
      }

      // 2. Fazer scraping dos dados atualizados
      const dadosCompletos = await this.scraper.obterDadosCompletos(sorteioBase);

      // 3. Gerar imagem
      const imagePath = await this.imageGenerator.gerarImagemSorteio(dadosCompletos);

      // 4. Preparar mensagem
      const mensagem = await this.prepararMensagem(dadosCompletos);

      // 5. Enviar para grupos ativos
      const resultadoEnvio = await this.enviarParaGrupos(dadosCompletos, imagePath, mensagem);

      // 6. Registrar como processado
      await this.registrarComoProcessado(dadosCompletos);

      logger.info(`✅ Sorteio ${codigo} processado com sucesso`);
      
      return {
        codigo,
        status: 'success',
        ganhador: dadosCompletos.ganhador,
        gruposEnviados: resultadoEnvio.sucessos.length,
        imagePath
      };

    } catch (error) {
      logger.error(`❌ Erro ao processar sorteio ${codigo}:`, error);
      throw error;
    }
  }

  /**
   * Verificar se sorteio já foi processado
   */
  async verificarSeJaProcessado(codigo) {
    const db = await database.getConnection();
    const hoje = DateUtils.getHojeBrasil();
    
    const resultado = await db.get(`
      SELECT codigo_sorteio 
      FROM sorteios_processados 
      WHERE codigo_sorteio = ? 
      AND date(processed_at) = date('now')
    `, [codigo]);

    return !!resultado;
  }

  /**
   * Registrar sorteio como processado
   */
  async registrarComoProcessado(dadosSorteio) {
    const db = await database.getConnection();
    
    await db.run(`
      INSERT OR REPLACE INTO sorteios_processados 
      (codigo_sorteio, data_sorteio, nome_premio, ganhador, processed_at)
      VALUES (?, ?, ?, ?, datetime('now', 'utc'))
    `, [
      dadosSorteio.codigo,
      dadosSorteio.data,
      dadosSorteio.premio,
      dadosSorteio.ganhador
    ]);

    logger.info(`📝 Sorteio ${dadosSorteio.codigo} registrado como processado`);
  }

  /**
   * Preparar mensagem personalizada
   */
  async prepararMensagem(dadosSorteio) {
    try {
      // 1. Obter textos base
      const textosBase = await this.obterTextosBase();
      
      if (textosBase.length === 0) {
        throw new Error('Nenhum texto base encontrado');
      }

      // 2. Selecionar texto aleatório
      const textoEscolhido = textosBase[Math.floor(Math.random() * textosBase.length)];

      // 3. Obter cupom atual
      const cupom = await this.obterCupomAtual();

      // 4. Substituir variáveis
      let mensagem = textoEscolhido.texto_template;
      
      mensagem = mensagem.replace(/{NOME_GANHADOR}/g, dadosSorteio.ganhador);
      mensagem = mensagem.replace(/{PREMIO}/g, dadosSorteio.premio);
      mensagem = mensagem.replace(/{LINK_RESULTADO}/g, dadosSorteio.urlCompleta);
      mensagem = mensagem.replace(/{CUPOM}/g, cupom || 'PEGAJ');
      mensagem = mensagem.replace(/{DATA_SORTEIO}/g, dadosSorteio.data);
      mensagem = mensagem.replace(/{CODIGO_SORTEIO}/g, dadosSorteio.codigo);

      logger.info(`📝 Mensagem preparada para sorteio ${dadosSorteio.codigo}`);
      return mensagem;

    } catch (error) {
      logger.error('❌ Erro ao preparar mensagem:', error);
      
      // Mensagem padrão em caso de erro
      return `🎉 Parabéns ${dadosSorteio.ganhador}! 
Você ganhou o ${dadosSorteio.premio}!

🔗 Veja o resultado completo:
${dadosSorteio.urlCompleta}

📞 Fale comigo no WhatsApp: (48) 9 9178-4733`;
    }
  }

  /**
   * Obter textos base do banco
   */
  async obterTextosBase() {
    const db = await database.getConnection();
    
    const textos = await db.all(`
      SELECT * FROM textos_sorteios 
      WHERE ativo = 1 
      ORDER BY id
    `);

    return textos;
  }

  /**
   * Obter cupom atual
   */
  async obterCupomAtual() {
    const db = await database.getConnection();
    
    const cupom = await db.get(`
      SELECT cupom1 FROM cupons_atuais 
      ORDER BY atualizado_em DESC 
      LIMIT 1
    `);

    return cupom?.cupom1 || 'PEGAJ';
  }

  /**
   * Enviar para grupos ativos
   */
  async enviarParaGrupos(dadosSorteio, imagePath, mensagem) {
    try {
      // 1. Obter grupos ativos
      const gruposAtivos = await this.obterGruposAtivos();
      
      if (gruposAtivos.length === 0) {
        logger.warn('⚠️ Nenhum grupo ativo encontrado');
        return { sucessos: [], erros: [] };
      }

      logger.info(`📤 Enviando para ${gruposAtivos.length} grupos ativos...`);

      // 2. Obter cliente WhatsApp
      const whatsappClient = require('../app').locals?.whatsappClient;
      if (!whatsappClient || !whatsappClient.isConnected) {
        throw new Error('WhatsApp não está conectado');
      }

      // 3. Enviar para cada grupo
      const sucessos = [];
      const erros = [];

      for (const grupo of gruposAtivos) {
        try {
          // Criar chave de idempotência
          const idempotencyKey = `${dadosSorteio.codigo}-${grupo.jid}-${DateUtils.getHojeBrasil()}`;
          
          // Verificar se já foi enviado
          const jaEnviado = await this.verificarSeJaEnviado(idempotencyKey);
          if (jaEnviado) {
            logger.info(`ℹ️ Mensagem já enviada para grupo ${grupo.nome}`);
            continue;
          }

          // Registrar tentativa de envio
          await this.registrarTentativaEnvio(idempotencyKey, dadosSorteio.codigo, grupo.jid);

          // Enviar mensagem
          const resultado = await whatsappClient.sendImageMessage(
            grupo.jid,
            imagePath,
            mensagem,
            { quoted: null }
          );

          // Atualizar status como enviado
          await this.atualizarStatusEnvio(idempotencyKey, 'sent', resultado.key.id);
          
          sucessos.push({
            grupo: grupo.nome,
            jid: grupo.jid,
            messageId: resultado.key.id
          });

          metricsService.recordMessageSent(grupo.nome, dadosSorteio.codigo);
          logger.info(`✅ Enviado para grupo: ${grupo.nome}`);

          // Pausa entre envios
          await this.sleep(30000); // 30 segundos

        } catch (error) {
          await this.atualizarStatusEnvio(idempotencyKey, 'failed_perm', null, error.message);
          
          erros.push({
            grupo: grupo.nome,
            jid: grupo.jid,
            erro: error.message
          });

          metricsService.recordMessageFailed(grupo.nome, error.name || 'unknown', dadosSorteio.codigo);
          logger.error(`❌ Erro ao enviar para grupo ${grupo.nome}:`, error);
        }
      }

      logger.info(`📊 Envio concluído: ${sucessos.length} sucessos, ${erros.length} erros`);
      
      return { sucessos, erros };

    } catch (error) {
      logger.error('❌ Erro ao enviar para grupos:', error);
      throw error;
    }
  }

  /**
   * Obter grupos ativos
   */
  async obterGruposAtivos() {
    const db = await database.getConnection();
    
    const grupos = await db.all(`
      SELECT jid, nome 
      FROM grupos_whatsapp 
      WHERE ativo_sorteios = 1 AND enabled = 1
      ORDER BY nome
    `);

    return grupos;
  }

  /**
   * Verificar se mensagem já foi enviada
   */
  async verificarSeJaEnviado(idempotencyKey) {
    const db = await database.getConnection();
    
    const resultado = await db.get(`
      SELECT id FROM envios_whatsapp 
      WHERE idempotency_key = ? AND status IN ('sent', 'delivered')
    `, [idempotencyKey]);

    return !!resultado;
  }

  /**
   * Registrar tentativa de envio
   */
  async registrarTentativaEnvio(idempotencyKey, codigoSorteio, grupoJid) {
    const db = await database.getConnection();
    
    await db.run(`
      INSERT OR IGNORE INTO envios_whatsapp 
      (idempotency_key, codigo_sorteio, grupo_jid, status, tentativas)
      VALUES (?, ?, ?, 'pending', 0)
    `, [idempotencyKey, codigoSorteio, grupoJid]);
  }

  /**
   * Atualizar status de envio
   */
  async atualizarStatusEnvio(idempotencyKey, status, messageKeyId = null, erro = null) {
    const db = await database.getConnection();
    
    await db.run(`
      UPDATE envios_whatsapp 
      SET status = ?, message_key_id = ?, ultimo_erro = ?, 
          enviado_em = CASE WHEN ? = 'sent' THEN datetime('now', 'utc') ELSE enviado_em END
      WHERE idempotency_key = ?
    `, [status, messageKeyId, erro, status, idempotencyKey]);
  }

  /**
   * Processar sorteio manualmente (para testes)
   */
  async processarSorteioManual(codigoSorteio) {
    try {
      logger.info(`🔧 Processamento manual do sorteio: ${codigoSorteio}`);

      // 1. Fazer scraping
      const dadosScraping = await this.scraper.scrapeSorteio(codigoSorteio);

      // 2. Criar dados base
      const dadosBase = {
        codigo: codigoSorteio,
        data: DateUtils.getHojeBrasil(),
        premio: dadosScraping.premio,
        urlResultado: dadosScraping.urlCompleta
      };

      // 3. Processar
      const resultado = await this.processarSorteioIndividual(dadosBase);
      
      logger.info(`✅ Processamento manual concluído para ${codigoSorteio}`);
      return resultado;

    } catch (error) {
      logger.error(`❌ Erro no processamento manual de ${codigoSorteio}:`, error);
      throw error;
    }
  }

  /**
   * Obter estatísticas de sorteios
   */
  async obterEstatisticas() {
    const db = await database.getConnection();
    
    const stats = await db.get(`
      SELECT 
        COUNT(*) as total_processados,
        COUNT(CASE WHEN date(processed_at) = date('now') THEN 1 END) as hoje,
        COUNT(CASE WHEN date(processed_at) = date('now', '-1 day') THEN 1 END) as ontem,
        COUNT(CASE WHEN date(processed_at) >= date('now', '-7 days') THEN 1 END) as ultima_semana
      FROM sorteios_processados
    `);

    const envios = await db.get(`
      SELECT 
        COUNT(*) as total_envios,
        COUNT(CASE WHEN status = 'sent' THEN 1 END) as enviados,
        COUNT(CASE WHEN status LIKE 'failed%' THEN 1 END) as falhados
      FROM envios_whatsapp
      WHERE date(created_at) >= date('now', '-7 days')
    `);

    return {
      sorteios: stats,
      envios: envios,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = SorteiosModule;

