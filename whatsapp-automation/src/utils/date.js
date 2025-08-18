const { zonedTimeToUtc, formatInTimeZone, format } = require('date-fns-tz');
const { subDays, addDays, parseISO, isValid } = require('date-fns');

const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';

class DateUtils {
  /**
   * Obter data de ontem em timezone brasileiro
   * @returns {string} Data no formato dd/MM/yyyy
   */
  static getOntemBrasil() {
    const agora = new Date();
    const ontem = subDays(agora, 1);
    
    return formatInTimeZone(ontem, TIMEZONE, 'dd/MM/yyyy');
  }

  /**
   * Obter data de hoje em timezone brasileiro
   * @returns {string} Data no formato dd/MM/yyyy
   */
  static getHojeBrasil() {
    const agora = new Date();
    return formatInTimeZone(agora, TIMEZONE, 'dd/MM/yyyy');
  }

  /**
   * Verificar se é hora de executar (18:15 BRT)
   * @returns {boolean}
   */
  static isHoraExecucao() {
    const agoraBRT = formatInTimeZone(new Date(), TIMEZONE, 'HH:mm');
    return agoraBRT === '18:15';
  }

  /**
   * Obter hora atual em BRT
   * @returns {string} Hora no formato HH:mm
   */
  static getHoraAtualBRT() {
    return formatInTimeZone(new Date(), TIMEZONE, 'HH:mm');
  }

  /**
   * Converter data da planilha para comparação
   * @param {string} dataString - Data em formato variado
   * @returns {string|null} Data no formato dd/MM/yyyy ou null se inválida
   */
  static normalizarDataPlanilha(dataString) {
    if (!dataString) return null;
    
    // Se já está no formato brasileiro
    if (dataString.match(/^\d{2}\/\d{2}\/\d{4}$/)) {
      return dataString;
    }
    
    // Se está no formato ISO (YYYY-MM-DD)
    if (dataString.match(/^\d{4}-\d{2}-\d{2}$/)) {
      const [ano, mes, dia] = dataString.split('-');
      return `${dia}/${mes}/${ano}`;
    }
    
    // Se está no formato americano (MM/DD/YYYY)
    if (dataString.match(/^\d{2}\/\d{2}\/\d{4}$/)) {
      // Assumir que é formato americano se o mês > 12
      const [parte1, parte2, ano] = dataString.split('/');
      if (parseInt(parte1) > 12) {
        return `${parte1}/${parte2}/${ano}`;
      } else {
        return `${parte2}/${parte1}/${ano}`;
      }
    }
    
    console.warn(`⚠️ Formato de data não reconhecido: ${dataString}`);
    return null;
  }

  /**
   * Gerar dedupe key com timezone correto
   * @param {string} tipo - Tipo do job
   * @param {string|null} data - Data específica ou null para ontem
   * @returns {string}
   */
  static gerarDedupeKey(tipo, data = null) {
    const dataKey = data || this.getOntemBrasil();
    return `${tipo}:${dataKey}`;
  }

  /**
   * Log com timestamp brasileiro
   * @returns {string}
   */
  static logTimestamp() {
    return formatInTimeZone(new Date(), TIMEZONE, 'dd/MM/yyyy HH:mm:ss');
  }

  /**
   * Converter data brasileira para ISO
   * @param {string} dataBrasileira - Data no formato dd/MM/yyyy
   * @returns {string|null} Data no formato YYYY-MM-DD ou null se inválida
   */
  static brasileiraParaISO(dataBrasileira) {
    if (!dataBrasileira || !dataBrasileira.match(/^\d{2}\/\d{2}\/\d{4}$/)) {
      return null;
    }
    
    const [dia, mes, ano] = dataBrasileira.split('/');
    return `${ano}-${mes}-${dia}`;
  }

  /**
   * Verificar se uma data é válida
   * @param {string} dataString - Data em qualquer formato
   * @returns {boolean}
   */
  static isDataValida(dataString) {
    if (!dataString) return false;
    
    const dataNormalizada = this.normalizarDataPlanilha(dataString);
    if (!dataNormalizada) return false;
    
    const dataISO = this.brasileiraParaISO(dataNormalizada);
    if (!dataISO) return false;
    
    const date = parseISO(dataISO);
    return isValid(date);
  }

  /**
   * Obter próxima execução do cron (18:15 do mesmo dia)
   * @returns {Date}
   */
  static getProximaExecucao() {
    const agora = new Date();
    const hoje = new Date(agora);
    
    // Criar data para 18:15 de hoje em BRT
    hoje.setHours(18, 15, 0, 0);
    
    // Se já passou das 18:15, usar 18:15 do próximo dia
    if (agora > hoje) {
      const amanha = addDays(hoje, 1);
      amanha.setHours(18, 15, 0, 0);
      return zonedTimeToUtc(amanha, TIMEZONE);
    }
    
    // Converter para UTC considerando timezone
    return zonedTimeToUtc(hoje, TIMEZONE);
  }

  /**
   * Formatar duração em milissegundos para string legível
   * @param {number} ms - Duração em milissegundos
   * @returns {string}
   */
  static formatarDuracao(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${(ms / 60000).toFixed(1)}min`;
    return `${(ms / 3600000).toFixed(1)}h`;
  }

  /**
   * Verificar se uma data é de ontem
   * @param {string} dataString - Data para verificar
   * @returns {boolean}
   */
  static isDataOntem(dataString) {
    const dataNormalizada = this.normalizarDataPlanilha(dataString);
    const ontem = this.getOntemBrasil();
    
    return dataNormalizada === ontem;
  }

  /**
   * Verificar se uma data é de hoje
   * @param {string} dataString - Data para verificar
   * @returns {boolean}
   */
  static isDataHoje(dataString) {
    const dataNormalizada = this.normalizarDataPlanilha(dataString);
    const hoje = this.getHojeBrasil();
    
    return dataNormalizada === hoje;
  }

  /**
   * Calcular horário de postagem (sorteio + 5 minutos)
   * @param {Date} horarioSorteio - Horário do sorteio
   * @returns {Date} Horário para postagem
   */
  static calcularHorarioPostagem(horarioSorteio) {
    if (!horarioSorteio || !(horarioSorteio instanceof Date)) {
      throw new Error('Horário do sorteio deve ser um objeto Date válido');
    }

    // Adicionar 5 minutos
    const horarioPostagem = new Date(horarioSorteio.getTime() + 5 * 60 * 1000);
    return horarioPostagem;
  }

  /**
   * Verificar se já passou do horário de postagem
   * @param {Date} horarioSorteio - Horário do sorteio
   * @param {Date} agora - Horário atual (opcional, usa Date.now() se não fornecido)
   * @returns {boolean} True se já passou do horário de postagem
   */
  static jaPassouHorarioPostagem(horarioSorteio, agora = null) {
    if (!agora) agora = new Date();
    
    const horarioPostagem = this.calcularHorarioPostagem(horarioSorteio);
    return agora >= horarioPostagem;
  }

  /**
   * Obter próximo horário de monitoramento (:05 ou :35)
   * @param {Date} agora - Horário atual (opcional)
   * @returns {Date} Próximo horário de monitoramento
   */
  static getProximoMonitoramento(agora = null) {
    if (!agora) agora = new Date();
    
    const proximoMonitoramento = new Date(agora);
    const minutoAtual = agora.getMinutes();
    
    if (minutoAtual < 5) {
      // Próximo é :05 da mesma hora
      proximoMonitoramento.setMinutes(5, 0, 0);
    } else if (minutoAtual < 35) {
      // Próximo é :35 da mesma hora
      proximoMonitoramento.setMinutes(35, 0, 0);
    } else {
      // Próximo é :05 da próxima hora
      proximoMonitoramento.setHours(proximoMonitoramento.getHours() + 1);
      proximoMonitoramento.setMinutes(5, 0, 0);
    }
    
    return proximoMonitoramento;
  }

  /**
   * Verificar se está no horário de monitoramento (:05 ou :35)
   * @param {Date} agora - Horário atual (opcional)
   * @returns {boolean} True se está no horário de monitoramento
   */
  static isHorarioMonitoramento(agora = null) {
    if (!agora) agora = new Date();
    
    const minuto = agora.getMinutes();
    return minuto === 5 || minuto === 35;
  }

  /**
   * Formatar data/hora para exibição brasileira
   * @param {Date} data - Data para formatar
   * @returns {string} Data formatada (dd/MM/yyyy HH:mm)
   */
  static formatarDataHoraBrasil(data) {
    if (!data || !(data instanceof Date)) {
      return 'Data inválida';
    }

    return formatInTimeZone(data, TIMEZONE, 'dd/MM/yyyy HH:mm');
  }

  /**
   * Calcular diferença em minutos entre duas datas
   * @param {Date} dataInicio - Data inicial
   * @param {Date} dataFim - Data final
   * @returns {number} Diferença em minutos
   */
  static diferencaEmMinutos(dataInicio, dataFim) {
    if (!dataInicio || !dataFim) return 0;
    
    const diffMs = dataFim.getTime() - dataInicio.getTime();
    return Math.floor(diffMs / (1000 * 60));
  }

  /**
   * Verificar se sorteio está dentro da janela de processamento
   * @param {Date} horarioSorteio - Horário do sorteio
   * @param {number} maxHoras - Máximo de horas após o sorteio (padrão: 24)
   * @returns {boolean} True se ainda está na janela
   */
  static estaEmJanelaProcessamento(horarioSorteio, maxHoras = 24) {
    if (!horarioSorteio) return false;
    
    const agora = new Date();
    const diffHoras = (agora.getTime() - horarioSorteio.getTime()) / (1000 * 60 * 60);
    
    return diffHoras <= maxHoras;
  }

  /**
   * Obter timestamp para logs com timezone brasileiro
   * @returns {string} Timestamp formatado
   */
  static timestampLog() {
    return formatInTimeZone(new Date(), TIMEZONE, 'dd/MM/yyyy HH:mm:ss');
  }
}

module.exports = DateUtils;

