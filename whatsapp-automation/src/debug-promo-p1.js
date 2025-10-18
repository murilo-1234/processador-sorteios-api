// debug-promo-p1.js - Diagnóstico P1
// Salve como: src/debug-promo-p1.js
// Execute: node src/debug-promo-p1.js

const { parse } = require('date-fns');

// Configurações (iguais ao post-promo)
const PROMO_BEFORE_DAYS = Number(process.env.PROMO_BEFORE_DAYS || 2);
const PROMO_POST_HOUR = Number(process.env.PROMO_POST_START_HOUR || 9);

function mkLocalDateAtHour(spDateOnly, hour = 9) {
  const yyyy = spDateOnly.getFullYear();
  const mm   = spDateOnly.getMonth();
  const dd   = spDateOnly.getDate();
  return new Date(yyyy, mm, dd, hour, 0, 0);
}

// TESTE COM g188
const sorteioId = 'g188';
const dateStr = '20/10/2025';
const horaStr = '18:00';

console.log('\n=== DIAGNÓSTICO P1 ===\n');
console.log(`Sorteio: ${sorteioId}`);
console.log(`Data/Hora: ${dateStr} ${horaStr}`);
console.log(`\nConfigurações:`);
console.log(`  PROMO_BEFORE_DAYS: ${PROMO_BEFORE_DAYS}`);
console.log(`  PROMO_POST_HOUR: ${PROMO_POST_HOUR}`);

// Parse da data
const spDate = parse(dateStr, 'dd/MM/yyyy', new Date());
console.log(`\nData parseada: ${spDate.toLocaleString('pt-BR')}`);

// Cálculo P1 (igual ao código)
const dayLocal = mkLocalDateAtHour(spDate, PROMO_POST_HOUR);
console.log(`\nDia do sorteio às ${PROMO_POST_HOUR}h: ${dayLocal.toLocaleString('pt-BR')}`);

const beforeLocal = new Date(dayLocal.getTime() - PROMO_BEFORE_DAYS * 24 * 60 * 60 * 1000);
console.log(`\nP1 deveria postar a partir de: ${beforeLocal.toLocaleString('pt-BR')}`);

const now = new Date();
console.log(`\nAgora: ${now.toLocaleString('pt-BR')}`);

const diffMs = now - beforeLocal;
const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

if (now >= beforeLocal) {
  console.log(`\n✅ P1 DEVERIA ESTAR POSTANDO!`);
  console.log(`   Já passou: ${diffHours}h ${diffMinutes}min`);
} else {
  console.log(`\n❌ P1 ainda não chegou a hora`);
  console.log(`   Falta: ${Math.abs(diffHours)}h ${Math.abs(diffMinutes)}min`);
}

// Verificar janela horária
const horaAtual = now.getHours();
const PROMO_POST_MAX_HOUR = Number(process.env.PROMO_POST_MAX_HOUR || 22);

console.log(`\nJanela horária:`);
console.log(`  Configurada: ${PROMO_POST_HOUR}h - ${PROMO_POST_MAX_HOUR}h`);
console.log(`  Hora atual: ${horaAtual}h`);

if (horaAtual < PROMO_POST_HOUR || horaAtual >= PROMO_POST_MAX_HOUR) {
  console.log(`  ❌ FORA DA JANELA - Por isso não posta!`);
} else {
  console.log(`  ✅ Dentro da janela`);
}

console.log('\n======================\n');
