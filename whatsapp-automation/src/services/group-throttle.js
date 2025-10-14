/**
 * group-throttle.js
 * 
 * MUDANÇA PRINCIPAL:
 * - ANTES: Delay fixo de 2 minutos
 * - AGORA: Delay aleatório entre 4-6 minutos (configurável via .env)
 * 
 * POR QUÊ: Parecer mais humano e evitar detecção de bot
 */

const { sleep } = require('./sleep-util');

// Lê as variáveis de ambiente (com fallback para 4-6 min)
const MIN_DELAY_MINUTES = parseInt(process.env.GROUP_POST_DELAY_MINUTES || '4', 10);
const MAX_DELAY_MINUTES = parseInt(process.env.GROUP_POST_DELAY_MAX_MINUTES || '6', 10);

/**
 * Gera um delay aleatório entre min e max minutos
 * @returns {number} - Delay em milissegundos
 */
function getRandomDelay() {
  const minMs = MIN_DELAY_MINUTES * 60 * 1000;
  const maxMs = MAX_DELAY_MINUTES * 60 * 1000;
  
  // Gera número aleatório entre min e max
  const randomMs = minMs + Math.random() * (maxMs - minMs);
  
  // Log para acompanhar
  const minutes = (randomMs / 60000).toFixed(2);
  console.log(`⏱️ [group-throttle] Delay sorteado: ${minutes} minutos`);
  
  return Math.floor(randomMs);
}

/**
 * Processa grupos com delay aleatório entre cada um
 * 
 * @param {Array} groups - Lista de grupos para processar
 * @param {Function} processFn - Função async que processa cada grupo
 * @returns {Promise<Array>} - Resultados de cada processamento
 * 
 * EXEMPLO DE USO:
 * await throttleGroupProcessing(
 *   ['grupo1@g.us', 'grupo2@g.us', 'grupo3@g.us'],
 *   async (group) => {
 *     console.log(`Postando em ${group}`);
 *     await enviarMensagem(group, texto);
 *   }
 * );
 */
async function throttleGroupProcessing(groups, processFn) {
  const results = [];
  
  console.log(`🚀 [group-throttle] Iniciando processamento de ${groups.length} grupos`);
  console.log(`⏱️ [group-throttle] Delay configurado: ${MIN_DELAY_MINUTES}-${MAX_DELAY_MINUTES} minutos`);
  
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    
    try {
      console.log(`\n📤 [group-throttle] Processando grupo ${i + 1}/${groups.length}: ${group}`);
      
      // Executa a função de processamento
      const result = await processFn(group, i);
      results.push({ success: true, group, result });
      
      console.log(`✅ [group-throttle] Grupo ${i + 1}/${groups.length} concluído`);
      
      // Se não for o último grupo, aguarda delay aleatório
      if (i < groups.length - 1) {
        const delayMs = getRandomDelay();
        const delayMinutes = (delayMs / 60000).toFixed(2);
        
        console.log(`⏳ [group-throttle] Aguardando ${delayMinutes} minutos antes do próximo grupo...`);
        await sleep(delayMs);
      }
      
    } catch (error) {
      console.error(`❌ [group-throttle] Erro no grupo ${group}:`, error.message);
      results.push({ success: false, group, error: error.message });
      
      // Mesmo com erro, aguarda o delay antes do próximo (se não for o último)
      if (i < groups.length - 1) {
        const delayMs = getRandomDelay();
        const delayMinutes = (delayMs / 60000).toFixed(2);
        
        console.log(`⏳ [group-throttle] Aguardando ${delayMinutes} minutos (mesmo com erro)...`);
        await sleep(delayMs);
      }
    }
  }
  
  // Estatísticas finais
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  console.log(`\n📊 [group-throttle] Processamento concluído:`);
  console.log(`   ✅ Sucesso: ${successful}/${groups.length}`);
  console.log(`   ❌ Falhas: ${failed}/${groups.length}`);
  
  return results;
}

/**
 * Aguarda um delay aleatório simples
 * (Útil se você só quer o delay sem processar grupos)
 */
async function waitRandomDelay() {
  const delayMs = getRandomDelay();
  await sleep(delayMs);
}

/**
 * Alias para waitRandomDelay() - usado pelos jobs
 * (post-promo.js e post-winner.js chamam `throttleWait()`)
 */
async function wait() {
  return waitRandomDelay();
}

module.exports = {
  throttleGroupProcessing,
  waitRandomDelay,
  wait,              // ← IMPORTANTE: exporta wait() para os jobs
  getRandomDelay
};
