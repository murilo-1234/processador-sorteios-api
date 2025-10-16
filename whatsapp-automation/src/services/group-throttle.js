/**
 * whatsapp-automation/src/services/group-throttle.js
 *
 * Controle de intervalo entre posts por grupo.
 * - Mantém compatibilidade com a API existente (throttleGroupProcessing, waitRandomDelay, wait, getRandomDelay)
 * - Garante intervalo sequencial entre grupos usando estado persistido (THROTTLE_STATE_PATH)
 */

const fs = require('fs');
const path = require('path');

// Sleep local
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ENV
let MIN_DELAY_MINUTES = parseInt(process.env.GROUP_POST_DELAY_MINUTES || '3', 10);
let MAX_DELAY_MINUTES = parseInt(process.env.GROUP_POST_DELAY_MAX_MINUTES || '5', 10);

// Saneamento: se min > max, corrige
if (MIN_DELAY_MINUTES > MAX_DELAY_MINUTES) {
  const t = MIN_DELAY_MINUTES;
  MIN_DELAY_MINUTES = MAX_DELAY_MINUTES;
  MAX_DELAY_MINUTES = t;
}

const STATE_PATH = process.env.THROTTLE_STATE_PATH || '/data/config/throttle.json';

console.log(`🔧 [group-throttle] Delay: ${MIN_DELAY_MINUTES}-${MAX_DELAY_MINUTES} min | STATE=${STATE_PATH}`);

/** Util: carrega estado persistido */
function readState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

/** Util: grava estado persistido de forma segura */
function writeState(obj) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(obj || {}, null, 2));
  } catch (e) {
    console.warn('⚠️ [group-throttle] Falha ao salvar estado:', e?.message || String(e));
  }
}

/** Gera delay aleatório em ms entre min e max */
function getRandomDelay() {
  const minMs = MIN_DELAY_MINUTES * 60 * 1000;
  const maxMs = MAX_DELAY_MINUTES * 60 * 1000;
  const randomMs = minMs + Math.random() * (maxMs - minMs);

  const minutes = (randomMs / 60000).toFixed(2);
  const seconds = Math.floor(randomMs / 1000);
  console.log(`⏱️ [group-throttle] Delay sorteado: ${minutes} min (${seconds}s)`);

  return Math.floor(randomMs);
}

/**
 * Espera sequencial com estado persistido.
 * Regras:
 *  - Se nextAt > agora: aguarda (nextAt - agora).
 *  - Após aguardar, sorteia novo delay e define novo nextAt = agora + jitter.
 *  - Grava em STATE_PATH para encadear chamadas seguintes.
 */
async function waitSequential() {
  const state = readState();
  const now = Date.now();
  const nextAt = Number(state?.nextAt || 0);
  const needMs = Math.max(0, nextAt - now);

  if (needMs > 0) {
    console.log(`⏳ [group-throttle] Aguardando janela sequencial: ${(needMs / 60000).toFixed(2)} min`);
    console.log(`⏰ [group-throttle] Início: ${new Date().toLocaleTimeString('pt-BR')}`);
    const start = Date.now();
    await sleep(needMs);
    const waited = Date.now() - start;
    console.log(`✅ [group-throttle] Concluído: ${(waited / 60000).toFixed(2)} min reais`);
    console.log(`⏰ [group-throttle] Fim: ${new Date().toLocaleTimeString('pt-BR')}`);
  }

  // Agenda a próxima janela
  const jitter = getRandomDelay();
  const newNext = Date.now() + jitter;
  writeState({ nextAt: newNext });
  console.log(`🗓️ [group-throttle] Próxima janela a partir de agora em ${(jitter / 60000).toFixed(2)} min`);
  return jitter;
}

/**
 * Processa uma lista de grupos aplicando delay aleatório ENTRE cada envio.
 * Não usa estado persistido porque já controla o encadeamento dentro do loop.
 */
async function throttleGroupProcessing(groups, processFn) {
  const results = [];

  console.log(`🚀 [group-throttle] Processando ${groups.length} grupos`);
  console.log(`⏱️ [group-throttle] Delay alvo: ${MIN_DELAY_MINUTES}-${MAX_DELAY_MINUTES} min`);

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];

    try {
      console.log(`\n📤 [group-throttle] Grupo ${i + 1}/${groups.length}: ${group}`);
      const result = await processFn(group, i);
      results.push({ success: true, group, result });
      console.log(`✅ [group-throttle] Grupo ${i + 1}/${groups.length} concluído`);

      if (i < groups.length - 1) {
        const delayMs = getRandomDelay();
        console.log(`⏳ [group-throttle] Aguardando ${(delayMs / 60000).toFixed(2)} min antes do próximo...`);
        console.log(`⏰ [group-throttle] Início: ${new Date().toLocaleTimeString('pt-BR')}`);
        const start = Date.now();
        await sleep(delayMs);
        const waited = Date.now() - start;
        console.log(`✅ [group-throttle] Esperou ${(waited / 60000).toFixed(2)} min reais`);
        console.log(`⏰ [group-throttle] Fim: ${new Date().toLocaleTimeString('pt-BR')}`);
      }
    } catch (error) {
      console.error(`❌ [group-throttle] Erro no grupo ${group}:`, error?.message || String(error));
      results.push({ success: false, group, error: error?.message || String(error) });

      if (i < groups.length - 1) {
        const delayMs = getRandomDelay();
        console.log(`⏳ [group-throttle] Aguardando ${(delayMs / 60000).toFixed(2)} min (após erro)...`);
        await sleep(delayMs);
      }
    }
  }

  const successful = results.filter(r => r.success).length;
  const failed = results.length - successful;

  console.log(`\n📊 [group-throttle] Fim: ✅ ${successful}/${results.length} | ❌ ${failed}/${results.length}`);
  return results;
}

/**
 * Espera aleatória simples (sem estado). Mantido por compatibilidade.
 */
async function waitRandomDelay() {
  const delayMs = getRandomDelay();
  const start = Date.now();

  console.log(`⏰ [group-throttle] Início da espera: ${new Date().toLocaleTimeString('pt-BR')}`);
  await sleep(delayMs);
  const waited = Date.now() - start;
  console.log(`⏰ [group-throttle] Fim da espera: ${new Date().toLocaleTimeString('pt-BR')}`);
  console.log(`✅ [group-throttle] Tempo real: ${(waited / 60000).toFixed(2)} min (${Math.floor(waited / 1000)}s)`);

  return waited;
}

/**
 * Alias usado pelos jobs:
 * Agora usa a versão SEQUENCIAL com estado para garantir 4–6 min ENTRE envios.
 */
async function wait() {
  return waitSequential();
}

module.exports = {
  throttleGroupProcessing,
  waitRandomDelay,
  wait,
  getRandomDelay,
};
