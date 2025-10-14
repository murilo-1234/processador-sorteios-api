/**
 * sleep-util.js
 * Utilitário simples para adicionar delays (pausas) no código
 */

/**
 * Aguarda um determinado tempo antes de continuar
 * @param {number} ms - Tempo em milissegundos
 * @returns {Promise} - Promessa que resolve após o delay
 * 
 * EXEMPLO DE USO:
 * await sleep(5000); // Aguarda 5 segundos
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { sleep };
