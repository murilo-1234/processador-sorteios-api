// src/modules/sorteios.js
const fs = require('fs');
const logger = require('../config/logger');
const database = require('../config/database');
const DateUtils = require('../utils/date');
const GoogleSheetsService = require('../services/google-sheets');
const ScraperService = require('../services/scraper');
const ImageGeneratorService = require('../services/image-generator-simple');
const metricsService = require('../services/metrics');

// ===== Helpers de JID / parsing de números (compat com app.js) =====
function phoneToJid(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (s.includes('@')) return s;
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}
function parsePhonesToJids(value) {
  if (!value) return [];
  return String(value)
    .split(/[,\s;]+/) // vírgula, espaço ou ponto-e-vírgula
    .map((s) => s.trim())
    .filter(Boolean)
    .map((v) => (v.includes('@') ? v : phoneToJid(v)))
    .filter(Boolean);
}

const SEND_DELAY_MS = Math.max(0, Number(process.env.WA_SEND_DELAY_MS || 30000));
const MAX_TARGETS = Math.max(0, Number(process.env.WA_MAX_TARGETS || 0)); // 0 = sem limite
const ENV_POST_TO = (process.env.WA_POST_TO || '').trim(); // lista de JIDs/telefones (override de grupos)
const POST_TO_JIDS = parsePhonesToJids(ENV_POST_TO);

class SorteiosModule {
  constructor() {
    this.googleSheets = new GoogleSheetsService();
    this.scraper = new ScraperService();
    this.imageGenerator = new ImageGeneratorService();
    this.textosBase = [];
    this.cupomAtual = null;
  }

  /**
   * Monitorar sorteios elegíveis para processamento (novo método)
   */
  async monitorarSorteiosElegiveis(executionId) {
    const startTime = Date.now();

    try {
      logger.info('🔍 Iniciando monitoramento de sorteios elegíveis...');

      // 1. Buscar sorteios elegíveis na planilha
      const sorteiosElegiveis = await this.googleSheets.getSorteiosElegiveis();

      if (sorteiosElegiveis.length === 0) {
        logger.info('ℹ️ Nenhum sorteio elegível encontrado para processamento');
        metricsService.recordSorteioProcessado('no_eligible');
        return { processados: 0, total: 0 };
      }

      logger.info(`🎯 ${sorteiosElegiveis.length} sorteios elegíveis encontrados`);

      // 2. Processar cada sorteio elegível
      const resultados = [];
      for (const sorteio of sorteiosElegiveis) {
        try {
          logger.info(`🔄 Processando sorteio elegível: ${sorteio.codigo} (${sorteio.motivoElegivel})`);

          const resultado = await this.processarSorteioElegivel(sorteio);
          resultados.push(resultado);
          metricsService.recordSorteioProcessado('success');
        } catch (error) {
          logger.error(`❌ Erro ao processar sorteio elegível ${sorteio.codigo}:`, error);
          metricsService.recordSorteioProcessado('error');
        }
      }

      // 3. Registrar estatísticas
      const duration = (Date.now() - startTime) / 1000;
      metricsService.recordJobDuration('monitor-sorteios', 'completed', duration);

      logger.info(`✅ Monitoramento concluído: ${resultados.length}/${sorteiosElegiveis.length} sorteios processados`);

      return {
        total: sorteiosElegiveis.length,
        processados: resultados.length,
        resultados,
        executionId,
      };
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      metricsService.recordJobDuration('monitor-sorteios', 'failed', duration);

      logger.error('❌ Erro no monitoramento de sorteios elegíveis:', error);
      throw error;
    }
  }

  /**
   * Processar um sorteio elegível (já passou do horário + 5 min)
   */
  async processarSorteioElegivel(sorteioElegivel) {
    const { codigo } = sorteioElegivel;

    try {
      logger.info(`🎯 Processando sorteio elegível: ${codigo}`);

      // 1. Verificar novamente se já foi processado (double-check)
      const jaProcessado = await this.verificarSeJaProcessado(codigo);
      if (jaProcessado) {
        logger.info(`ℹ️ Sorteio ${codigo} já foi processado (double-check)`);
        return { codigo, status: 'already_processed' };
      }

      // 2. Fazer scraping dos dados atualizados
      const dadosCompletos = await this.scraper.obterDadosCompletos(sorteioElegivel);

      // 3. Gerar imagem
      const imagePath = await this.imageGenerator.gerarImagemSorteio(dadosCompletos);

      // 4. Preparar mensagem
      const mensagem = await this.prepararMensagem(dadosCompletos);

      // 5. Enviar para grupos/targets
      const resultadoEnvio = await this.enviarParaGrupos(dadosCompletos, imagePath, mensagem);

      // 6. Registrar como processado no banco local
      await this.registrarComoProcessado(dadosCompletos);

      // 7. Marcar como postado na planilha Google Sheets
      await this.googleSheets.marcarComoPostado(codigo, new Date());

      logger.info(`✅ Sorteio elegível ${codigo} processado com sucesso`);

      return {
        codigo,
        status: 'success',
        ganhador: dadosCompletos.ganhador,
        gruposEnviados: resultadoEnvio.sucessos.length,
        imagePath,
        horarioOriginal: sorteioElegivel.horarioCompleto,
        horarioProcessamento: new Date(),
      };
    } catch (error) {
      logger.error(`❌ Erro ao processar sorteio elegível ${codigo}:`, error);
      throw error;
    }
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
        executionId,
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

      // 5. Enviar para grupos/targets
      const resultadoEnvio = await this.enviarParaGrupos(dadosCompletos, imagePath, mensagem);

      // 6. Registrar como processado
      await this.registrarComoProcessado(dadosCompletos);

      logger.info(`✅ Sorteio ${codigo} processado com sucesso`);

      return {
        codigo,
        status: 'success',
        ganhador: dadosCompletos.ganhador,
        gruposEnviados: resultadoEnvio.sucessos.length,
        imagePath,
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

    await db.run(`
      CREATE TABLE IF NOT EXISTS sorteios_processados (
        codigo_sorteio TEXT PRIMARY KEY,
        data_sorteio TEXT,
        nome_premio TEXT,
        ganhador TEXT,
        processed_at TEXT
      )
    `);

    const resultado = await db.get(
      `
      SELECT codigo_sorteio
      FROM sorteios_processados
      WHERE codigo_sorteio = ?
        AND date(processed_at) = date('now')
    `,
      [codigo]
    );

    return !!resultado;
  }

  /**
   * Registrar sorteio como processado
   */
  async registrarComoProcessado(dadosSorteio) {
    const db = await database.getConnection();

    await db.run(`
      CREATE TABLE IF NOT EXISTS sorteios_processados (
        codigo_sorteio TEXT PRIMARY KEY,
        data_sorteio TEXT,
        nome_premio TEXT,
        ganhador TEXT,
        processed_at TEXT
      )
    `);

    await db.run(
      `
      INSERT OR REPLACE INTO sorteios_processados
      (codigo_sorteio, data_sorteio, nome_premio, ganhador, processed_at)
      VALUES (?, ?, ?, ?, datetime('now', 'utc'))
    `,
      [dadosSorteio.codigo, dadosSorteio.data, dadosSorteio.premio, dadosSorteio.ganhador]
    );

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
      mensagem = mensagem.replace(/{LINK_RESULTADO}/g, dadosSorteio.urlCompleta || dadosSorteio.urlResultado || '');
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
${dadosSorteio.urlCompleta || dadosSorteio.urlResultado || ''}

📞 Fale comigo no WhatsApp: (48) 9 9178-4733`;
    }
  }

  /**
   * Obter textos base do banco
   */
  async obterTextosBase() {
    const db = await database.getConnection();

    await db.run(`
      CREATE TABLE IF NOT EXISTS textos_sorteios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        texto_template TEXT NOT NULL,
        ativo INTEGER DEFAULT 1
      )
    `);

    const textos = await db.all(
      `
      SELECT * FROM textos_sorteios
      WHERE ativo = 1
      ORDER BY id
    `
    );

    return textos;
  }

  /**
   * Obter cupom atual
   */
  async obterCupomAtual() {
    const db = await database.getConnection();

    await db.run(`
      CREATE TABLE IF NOT EXISTS cupons_atuais (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cupom1 TEXT,
        cupom2 TEXT,
        atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const cupom = await db.get(
      `
      SELECT cupom1 FROM cupons_atuais
      ORDER BY atualizado_em DESC
      LIMIT 1
    `
    );

    return cupom?.cupom1 || 'PEGAJ';
  }

  /**
   * Retorna lista de destinos (override por WA_POST_TO; senão usa grupos ativos)
   */
  async getPostTargets() {
    if (POST_TO_JIDS.length) {
      // Lista direta da ENV
      const uniq = [...new Set(POST_TO_JIDS)];
      return uniq.map((jid, i) => ({ jid, nome: `destino ${i + 1}` }));
    }
    // fallback: grupos ativos do banco
    const gruposAtivos = await this.obterGruposAtivos();
    return gruposAtivos.map((g) => ({ jid: g.jid, nome: g.nome }));
  }

  /**
   * Enviar para grupos/destinos
   */
  async enviarParaGrupos(dadosSorteio, imagePath, mensagem) {
    try {
      // 1) destinos
      let destinos = await this.getPostTargets();
      if (!destinos.length) {
        logger.warn('⚠️ Nenhum destino/grupo ativo encontrado');
        return { sucessos: [], erros: [] };
      }
      if (MAX_TARGETS > 0 && destinos.length > MAX_TARGETS) {
        destinos = destinos.slice(0, MAX_TARGETS);
      }

      logger.info(`📤 Enviando para ${destinos.length} destino(s)...`);

      // 2) obter transporte: preferir admin sock; fallback: cliente interno; compat: cliente no app
      const { sock, whatsappClient } = await this._resolveTransport();

      if (!sock && !whatsappClient) {
        throw new Error('Não há sessão do WhatsApp disponível para envio');
      }

      // 3) loop de envios
      const sucessos = [];
      const erros = [];

      for (const dest of destinos) {
        const { jid, nome } = dest;
        let idempotencyKey = `${dadosSorteio.codigo}-${jid}-${DateUtils.getHojeBrasil()}`;

        try {
          // Verificar se já foi enviado
          const jaEnviado = await this.verificarSeJaEnviado(idempotencyKey);
          if (jaEnviado) {
            logger.info(`ℹ️ Mensagem já enviada para destino ${nome}`);
            continue;
          }

          // Registrar tentativa de envio
          await this.registrarTentativaEnvio(idempotencyKey, dadosSorteio.codigo, jid);

          // Enviar
          const result = await this._sendOne({ sock, whatsappClient, jid, imagePath, mensagem });

          // Atualizar status como enviado
          const messageId =
            result?.key?.id ||
            result?.messageID ||
            result?.id ||
            null;
          await this.atualizarStatusEnvio(idempotencyKey, 'sent', messageId);

          sucessos.push({ grupo: nome, jid, messageId });
          metricsService.recordMessageSent(nome, dadosSorteio.codigo);
          logger.info(`✅ Enviado para: ${nome}`);

          // Pausa entre envios
          if (SEND_DELAY_MS > 0) await this.sleep(SEND_DELAY_MS);
        } catch (error) {
          await this.atualizarStatusEnvio(idempotencyKey, 'failed_perm', null, error.message);
          erros.push({ grupo: nome, jid, erro: error.message });
          metricsService.recordMessageFailed(nome, error.name || 'unknown', dadosSorteio.codigo);
          logger.error(`❌ Erro ao enviar para ${nome}:`, error);
        }
      }

      logger.info(`📊 Envio concluído: ${sucessos.length} sucessos, ${erros.length} erros`);

      return { sucessos, erros };
    } catch (error) {
      logger.error('❌ Erro ao enviar para grupos/destinos:', error);
      throw error;
    }
  }

  /**
   * Resolver transporte de envio (tolerante)
   * - Tenta admin bundle (/admin-wa-bundle.js)
   * - Tenta app.locals.whatsappClient (compat)
   * - Tenta cliente interno exposto em ../services/whatsapp-client, se houver singleton
   */
  async _resolveTransport() {
    // 1) Admin bundle (preferido)
    try {
      const admin = require('../admin-wa-bundle.js');
      if (admin?.getStatus && admin?.getSock) {
        const st = await admin.getStatus();
        if (st?.connected) {
          return { sock: admin.getSock(), whatsappClient: null };
        }
      }
    } catch (_) {}

    // 2) App.locals.whatsappClient (compat com projeto existente)
    try {
      const appMaybe = require('../app');
      const wc = appMaybe?.locals?.whatsappClient;
      if (wc?.isConnected && wc?.sock) {
        return { sock: wc.sock, whatsappClient: wc };
      }
      if (wc?.isConnected && typeof wc.sendImageMessage === 'function') {
        return { sock: null, whatsappClient: wc };
      }
    } catch (_) {}

    // 3) Outro singleton opcional
    try {
      const singleton = require('../services/whatsapp-singleton');
      if (singleton?.sock) return { sock: singleton.sock, whatsappClient: singleton };
    } catch (_) {}

    return { sock: null, whatsappClient: null };
  }

  /**
   * Envio unitário com compatibilidade
   */
  async _sendOne({ sock, whatsappClient, jid, imagePath, mensagem }) {
    // Preferir método do cliente (se existir)
    if (whatsappClient && typeof whatsappClient.sendImageMessage === 'function') {
      return whatsappClient.sendImageMessage(jid, imagePath, mensagem, { quoted: null });
    }

    // Fallback: enviar direto pelo Baileys
    if (sock) {
      const exists = imagePath && fs.existsSync(imagePath);
      if (exists) {
        return sock.sendMessage(jid, { image: { url: imagePath }, caption: mensagem });
      }
      // Se imagem não existir por algum motivo, manda texto para não travar operação
      return sock.sendMessage(jid, { text: mensagem });
    }

    throw new Error('Transporte de WhatsApp indisponível');
  }

  /**
   * Obter grupos ativos
   */
  async obterGruposAtivos() {
    const db = await database.getConnection();

    await db.run(`
      CREATE TABLE IF NOT EXISTS grupos_whatsapp (
        jid TEXT PRIMARY KEY,
        nome TEXT,
        ativo_sorteios INTEGER DEFAULT 1,
        enabled INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const grupos = await db.all(
      `
      SELECT jid, nome
      FROM grupos_whatsapp
      WHERE ativo_sorteios = 1 AND enabled = 1
      ORDER BY nome
    `
    );

    return grupos;
  }

  /**
   * Verificar se mensagem já foi enviada
   */
  async verificarSeJaEnviado(idempotencyKey) {
    const db = await database.getConnection();

    await db.run(`
      CREATE TABLE IF NOT EXISTS envios_whatsapp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT UNIQUE,
        codigo_sorteio TEXT,
        grupo_jid TEXT,
        status TEXT DEFAULT 'pending',
        tentativas INTEGER DEFAULT 0,
        message_key_id TEXT,
        ultimo_erro TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        enviado_em TEXT
      )
    `);

    const resultado = await db.get(
      `
      SELECT id FROM envios_whatsapp
      WHERE idempotency_key = ? AND status IN ('sent', 'delivered')
    `,
      [idempotencyKey]
    );

    return !!resultado;
  }

  /**
   * Registrar tentativa de envio
   */
  async registrarTentativaEnvio(idempotencyKey, codigoSorteio, grupoJid) {
    const db = await database.getConnection();

    await db.run(`
      CREATE TABLE IF NOT EXISTS envios_whatsapp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT UNIQUE,
        codigo_sorteio TEXT,
        grupo_jid TEXT,
        status TEXT DEFAULT 'pending',
        tentativas INTEGER DEFAULT 0,
        message_key_id TEXT,
        ultimo_erro TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        enviado_em TEXT
      )
    `);

    await db.run(
      `
      INSERT OR IGNORE INTO envios_whatsapp
      (idempotency_key, codigo_sorteio, grupo_jid, status, tentativas)
      VALUES (?, ?, ?, 'pending', 0)
    `,
      [idempotencyKey, codigoSorteio, grupoJid]
    );

    // incrementa tentativas a cada registro de tentativa
    await db.run(
      `
      UPDATE envios_whatsapp
      SET tentativas = COALESCE(tentativas, 0) + 1
      WHERE idempotency_key = ?
    `,
      [idempotencyKey]
    );
  }

  /**
   * Atualizar status de envio
   */
  async atualizarStatusEnvio(idempotencyKey, status, messageKeyId = null, erro = null) {
    const db = await database.getConnection();

    await db.run(
      `
      UPDATE envios_whatsapp
      SET status = ?, message_key_id = ?, ultimo_erro = ?,
          enviado_em = CASE WHEN ? = 'sent' THEN datetime('now', 'utc') ELSE enviado_em END
      WHERE idempotency_key = ?
    `,
      [status, messageKeyId, erro, status, idempotencyKey]
    );
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
        urlResultado: dadosScraping.urlCompleta,
        urlCompleta: dadosScraping.urlCompleta,
        ganhador: dadosScraping.ganhador || dadosScraping.nome || '',
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

    await db.run(`
      CREATE TABLE IF NOT EXISTS sorteios_processados (
        codigo_sorteio TEXT PRIMARY KEY,
        data_sorteio TEXT,
        nome_premio TEXT,
        ganhador TEXT,
        processed_at TEXT
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS envios_whatsapp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT UNIQUE,
        codigo_sorteio TEXT,
        grupo_jid TEXT,
        status TEXT DEFAULT 'pending',
        tentativas INTEGER DEFAULT 0,
        message_key_id TEXT,
        ultimo_erro TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        enviado_em TEXT
      )
    `);

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
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = SorteiosModule;
