// src/modules/sorteios.js

const path = require('path');
const logger = require('../config/logger');
const database = require('../config/database');
const DateUtils = require('../utils/date');
const GoogleSheetsService = require('../services/google-sheets');
const ScraperService = require('../services/scraper');
const ImageGeneratorService = require('../services/image-generator-simple');
const metricsService = require('../services/metrics');

// ===== Helpers de ENV/Parsing (sem interferir em outros módulos) =====
function envOn(v, def = false) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return def;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}
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
    .split(/[,\s;]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(v => (v.includes('@') ? v : phoneToJid(v)))
    .filter(Boolean);
}
const POST_DELAY_MS = Math.max(0, Number(process.env.WA_POST_DELAY_MS || 30_000));
const POST_JITTER_MS = Math.max(0, Number(process.env.WA_POST_JITTER_MS || 1_200));
const WA_POST_TO = [...new Set(parsePhonesToJids(process.env.WA_POST_TO))];
const WA_POST_TO_FORCE = envOn(process.env.WA_POST_TO_FORCE, false);

// ===== Adapter de envio tolerante (prefere Admin, cai no fallback) =====
async function getAdminSock() {
  const tryPaths = [
    // app.js usa '../admin-wa-bundle.js' a partir de src/app.js
    path.resolve(__dirname, '..', '..', 'admin-wa-bundle.js'),
    path.resolve(__dirname, '..', 'admin-wa-bundle.js'),
  ];
  for (const p of tryPaths) {
    try {
      const mod = require(p);
      if (mod && typeof mod.getStatus === 'function' && typeof mod.getSock === 'function') {
        const st = await mod.getStatus().catch(() => null);
        if (st?.connected) return mod.getSock();
      }
    } catch (_) {}
  }
  return null;
}
function getFallbackClientUnsafe() {
  // Mantém compatibilidade com código antigo que tentava acessar ../app.locals
  try {
    const appMod = require('../app');
    // suportar variações: app.locals.whatsappClient OU locals.whatsappClient
    return (
      appMod?.locals?.whatsappClient ||
      appMod?.app?.locals?.whatsappClient ||
      appMod?.whatsappClient ||
      null
    );
  } catch (_) {
    return null;
  }
}
async function resolveSendAdapter() {
  // 1) Admin conectado?
  const adminSock = await getAdminSock();
  if (adminSock) {
    return {
      mode: 'admin',
      isConnected: true,
      async sendImage(jid, imagePath, caption) {
        return adminSock.sendMessage(jid, { image: { url: imagePath }, caption });
      },
      async sendText(jid, text) {
        return adminSock.sendMessage(jid, { text });
      },
    };
  }

  // 2) Fallback (cliente interno), se exposto pela app
  const waClient = getFallbackClientUnsafe();
  if (waClient?.isConnected) {
    // mantém chamada antiga se existir; caso não, usa sock direto
    const canUseLegacy = typeof waClient.sendImageMessage === 'function';
    const sock = waClient.sock;
    return {
      mode: 'client',
      isConnected: true,
      async sendImage(jid, imagePath, caption) {
        if (canUseLegacy) {
          return waClient.sendImageMessage(jid, imagePath, caption, { quoted: null });
        }
        if (!sock) throw new Error('Sock indisponível no cliente fallback');
        return sock.sendMessage(jid, { image: { url: imagePath }, caption });
      },
      async sendText(jid, text) {
        if (waClient.sendToGroup) return waClient.sendToGroup(jid, text);
        if (!sock) throw new Error('Sock indisponível no cliente fallback');
        return sock.sendMessage(jid, { text });
      },
    };
  }

  return { mode: 'none', isConnected: false };
}

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

      // 5. Enviar para grupos/destinos
      const resultadoEnvio = await this.enviarParaDestinos(dadosCompletos, imagePath, mensagem);

      // 6. Registrar como processado no banco local
      await this.registrarComoProcessado(dadosCompletos);

      // 7. Marcar como postado na planilha Google Sheets
      try {
        await this.googleSheets.marcarComoPostado(codigo, new Date());
      } catch (e) {
        logger.warn(`⚠️ Falha ao marcar como postado no Sheets (${codigo}):`, e?.message || e);
      }

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

      // 5. Enviar para grupos/destinos
      const resultadoEnvio = await this.enviarParaDestinos(dadosCompletos, imagePath, mensagem);

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
   * Enviar para destinos (grupos ativos OU WA_POST_TO)
   * - Mantém compatibilidade com o fluxo antigo (grupos do banco)
   * - Adiciona fallback via EV WA_POST_TO (JIDs ou telefones)
   */
  async enviarParaDestinos(dadosSorteio, imagePath, mensagem) {
    try {
      // 1) Selecionar destinos
      let destinos = [];
      if (!WA_POST_TO_FORCE) {
        destinos = await this.obterGruposAtivos();
      }
      if ((WA_POST_TO_FORCE || destinos.length === 0) && WA_POST_TO.length) {
        // Fallback/Override por EV
        destinos = WA_POST_TO.map(jid => ({ jid, nome: `destino:${jid}` }));
      }

      if (destinos.length === 0) {
        logger.warn('⚠️ Nenhum destino encontrado (grupos ativos vazios e WA_POST_TO não definido)');
        return { sucessos: [], erros: [] };
      }

      logger.info(`📤 Enviando para ${destinos.length} destino(s)...`);

      // 2) Resolver interface de envio
      const sender = await resolveSendAdapter();
      if (!sender.isConnected) {
        throw new Error('Nenhuma sessão WhatsApp conectada (admin e fallback indisponíveis)');
      }

      // 3) Enviar um-a-um com idempotência local
      const sucessos = [];
      const erros = [];
      for (const dest of destinos) {
        const { jid, nome } = dest;

        // Cria chave de idempotência (por sorteio+destino+data)
        const idemKey = `${dadosSorteio.codigo}-${jid}-${DateUtils.getHojeBrasil()}`;

        try {
          const jaEnviado = await this.verificarSeJaEnviado(idemKey);
          if (jaEnviado) {
            logger.info(`ℹ️ Mensagem já enviada para ${nome} (${jid}) — ignorando`);
            continue;
          }

          await this.registrarTentativaEnvio(idemKey, dadosSorteio.codigo, jid);

          const r = await sender.sendImage(jid, imagePath, mensagem);
          const msgId = r?.key?.id || null;

          await this.atualizarStatusEnvio(idemKey, 'sent', msgId);

          sucessos.push({ grupo: nome, jid, messageId: msgId });
          metricsService.recordMessageSent(nome, dadosSorteio.codigo);
          logger.info(`✅ Enviado para: ${nome}`);

          // Pausa entre envios (com jitter opcional)
          const jitter = Math.floor(Math.random() * POST_JITTER_MS);
          await this.sleep(POST_DELAY_MS + jitter);
        } catch (error) {
          await this.atualizarStatusEnvio(idemKey, 'failed_perm', null, error?.message || String(error));

          erros.push({ grupo: nome, jid, erro: error?.message || String(error) });
          metricsService.recordMessageFailed(nome, error?.name || 'unknown', dadosSorteio.codigo);
          logger.error(`❌ Erro ao enviar para ${nome}:`, error);
        }
      }

      logger.info(`📊 Envio concluído: ${sucessos.length} sucessos, ${erros.length} erros`);
      return { sucessos, erros };
    } catch (error) {
      logger.error('❌ Erro no envio para destinos:', error);
      throw error;
    }
  }

  /**
   * Obter grupos ativos
   */
  async obterGruposAtivos() {
    const db = await database.getConnection();

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

    await db.run(
      `
      INSERT OR IGNORE INTO envios_whatsapp 
      (idempotency_key, codigo_sorteio, grupo_jid, status, tentativas)
      VALUES (?, ?, ?, 'pending', 0)
    `,
      [idempotencyKey, codigoSorteio, grupoJid]
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

    const stats = await db.get(
      `
      SELECT 
        COUNT(*) as total_processados,
        COUNT(CASE WHEN date(processed_at) = date('now') THEN 1 END) as hoje,
        COUNT(CASE WHEN date(processed_at) = date('now', '-1 day') THEN 1 END) as ontem,
        COUNT(CASE WHEN date(processed_at) >= date('now', '-7 days') THEN 1 END) as ultima_semana
      FROM sorteios_processados
    `
    );

    const envios = await db.get(
      `
      SELECT 
        COUNT(*) as total_envios,
        COUNT(CASE WHEN status = 'sent' THEN 1 END) as enviados,
        COUNT(CASE WHEN status LIKE 'failed%' THEN 1 END) as falhados
      FROM envios_whatsapp
      WHERE date(created_at) >= date('now', '-7 days')
    `
    );

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
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = SorteiosModule;
