/**
 * text-shuffler.js
 * 
 * FUNÇÃO: Sorteia textos diferentes para cada grupo
 * 
 * PROBLEMA QUE RESOLVE:
 * - Antes: 1 texto igual para todos os grupos (parece bot)
 * - Agora: 1 texto diferente por grupo (parece humano)
 * 
 * COMO FUNCIONA:
 * - Recebe: 10 textos disponíveis + 8 grupos
 * - Sorteia: 1 texto diferente para cada grupo
 * - Se faltar: repete textos (15 grupos com 10 textos = repete 5)
 */

/**
 * Embaralha um array (Fisher-Yates shuffle)
 * @param {Array} array - Array para embaralhar
 * @returns {Array} - Array embaralhado
 */
function shuffleArray(array) {
  const shuffled = [...array]; // cria cópia para não modificar original
  
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  
  return shuffled;
}

/**
 * Distribui textos diferentes para cada grupo
 * 
 * @param {Array} textsArray - Array com os 10 textos base
 * @param {Array} groupsArray - Array com os grupos para postar
 * @returns {Object} - Objeto onde chave=grupoId, valor=texto sorteado
 * 
 * EXEMPLO:
 * Input: 
 *   textsArray = ['Texto1', 'Texto2', 'Texto3', ..., 'Texto10']
 *   groupsArray = ['grupo1@g.us', 'grupo2@g.us', 'grupo3@g.us']
 * 
 * Output:
 *   {
 *     'grupo1@g.us': 'Texto7',
 *     'grupo2@g.us': 'Texto2', 
 *     'grupo3@g.us': 'Texto9'
 *   }
 */
function assignRandomTextsToGroups(textsArray, groupsArray) {
  // Valida se recebeu arrays válidos
  if (!Array.isArray(textsArray) || textsArray.length === 0) {
    console.warn('⚠️ [text-shuffler] Array de textos inválido, usando texto padrão');
    return {};
  }
  
  if (!Array.isArray(groupsArray) || groupsArray.length === 0) {
    console.warn('⚠️ [text-shuffler] Array de grupos vazio');
    return {};
  }
  
  // Embaralha os textos para randomizar
  const shuffledTexts = shuffleArray(textsArray);
  
  // Objeto resultado: grupoId → texto
  const assignments = {};
  
  // Para cada grupo, atribui um texto
  groupsArray.forEach((group, index) => {
    // Se tiver mais grupos que textos, repete os textos
    // Exemplo: 15 grupos, 10 textos → índice 10 volta para texto 0
    const textIndex = index % shuffledTexts.length;
    assignments[group] = shuffledTexts[textIndex];
    
    // Log para debug (pode comentar depois de testar)
    console.log(`📝 [text-shuffler] Grupo ${index + 1}: texto ${textIndex + 1}/10`);
  });
  
  return assignments;
}

/**
 * Versão alternativa: retorna array de pares [grupo, texto]
 * Útil se preferir trabalhar com array em vez de objeto
 */
function assignRandomTextsToGroupsArray(textsArray, groupsArray) {
  const assignments = assignRandomTextsToGroups(textsArray, groupsArray);
  
  return groupsArray.map(group => ({
    group: group,
    text: assignments[group]
  }));
}

module.exports = {
  shuffleArray,
  assignRandomTextsToGroups,
  assignRandomTextsToGroupsArray
};
