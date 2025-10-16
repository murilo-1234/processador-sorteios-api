/**
 * group-throttle.js
 * 
 * CORREÇÃO: Implementa sleep direto aqui para evitar problemas de dependência
 */

// Função sleep embutida (não depende de sleep-util.js)
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Lê as variáveis de ambiente
const MIN_DELAY_MINUTES = parseInt(process.env.GROUP_POST_DELAY_MINUTES || '3', 10);
const MAX_DELAY_MINUTES = parseInt(process.env.GROUP_POST_DELAY_MAX_MINUTES || '5', 10);

console.log(`🔧 [group-throttle] Inicializado com delay: ${MIN_DELAY_MINUTES}-${MAX_DELAY_MINUTES} minutos`);

/**
 * Gera um delay aleatório entre min e max minutos
 * @returns {number} - Delay em milissegundos
 */
function getRandomDelay() {
  const minMs = MIN_DELAY_MINUTES * 60 * 1000;
  const maxMs = MAX_DELAY_MINUTES * 60 * 1000;
  
  // Gera número aleatório entre min e max
  const randomMs = minMs + Math.random() * (maxMs - minMs);
  
  // Log detalhado
  const minutes = (randomMs / 60000).toFixed(2);
  const seconds = Math.floor(randomMs / 1000);
  console.log(`⏱️ [group-throttle] Delay sorteado: ${minutes} minutos (${seconds} segundos)`);
  
  return Math.floor(randomMs);
}

/**
 * Processa grupos com delay aleatório entre cada um
 */
async function throttleGroupProcessing(groups, processFn) {
  const results = [];
  
  console.log(`🚀 [group-throttle] Iniciando processamento de ${groups.length} grupos`);
  console.log(`⏱️ [group-throttle] Delay configurado: ${MIN_DELAY_MINUTES}-${MAX_DELAY_MINUTES} minutos`);
  
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    
    try {
      console.log(`\n📤 [group-throttle] Processando grupo ${i + 1}/${groups.length}: ${group}`);
      
      const result = await processFn(group, i);
      results.push({ success: true, group, result });
      
      console.log(`✅ [group-throttle] Grupo ${i + 1}/${groups.length} concluído`);
      
      // Se não for o último grupo, aguarda delay aleatório
      if (i < groups.length - 1) {
        const delayMs = getRandomDelay();
        const delayMinutes = (delayMs / 60000).toFixed(2);
        const startTime = Date.now();
        
        console.log(`⏳ [group-throttle] Aguardando ${delayMinutes} minutos antes do próximo grupo...`);
        console.log(`⏰ [group-throttle] Início do delay: ${new Date().toLocaleTimeString('pt-BR')}`);
        
        await sleep(delayMs);
        
        const endTime = Date.now();
        const actualDelay = ((endTime - startTime) / 60000).toFixed(2);
        console.log(`✅ [group-throttle] Delay concluído. Esperou: ${actualDelay} minutos reais`);
        console.log(`⏰ [group-throttle] Fim do delay: ${new Date().toLocaleTimeString('pt-BR')}`);
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
 * (Usado por post-winner.js e post-promo.js)
 */
async function waitRandomDelay() {
  const delayMs = getRandomDelay();
  const startTime = Date.now();
  
  console.log(`⏰ [group-throttle] Início da espera: ${new Date().toLocaleTimeString('pt-BR')}`);
  
  await sleep(delayMs);
  
  const endTime = Date.now();
  const actualMs = endTime - startTime;
  const actualMinutes = (actualMs / 60000).toFixed(2);
  
  console.log(`⏰ [group-throttle] Fim da espera: ${new Date().toLocaleTimeString('pt-BR')}`);
  console.log(`✅ [group-throttle] Tempo real esperado: ${actualMinutes} minutos (${Math.floor(actualMs / 1000)} segundos)`);
  
  return actualMs;
}

/**
 * Alias para waitRandomDelay() - usado pelos jobs
 */
async function wait() {
  return waitRandomDelay();
}

module.exports = {
  throttleGroupProcessing,
  waitRandomDelay,
  wait,
  getRandomDelay
};
