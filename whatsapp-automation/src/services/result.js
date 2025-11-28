// src/services/result.js - VERSÃO COM LOGS E RETRY
const axios = require('axios');
const cheerio = require('cheerio');

const TIMEOUT = 30000; // 30 segundos
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 segundos entre tentativas

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchResultInfo(id) {
  const url = `https://sorteios-info.murilo1234.workers.dev/resultado/${id}`;
  
  let lastError;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`📥 [result] Buscando ${id} (tentativa ${attempt}/${MAX_RETRIES})...`);
      
      const startTime = Date.now();
      const { data: html } = await axios.get(url, { 
        timeout: TIMEOUT,
        headers: {
          'User-Agent': 'WhatsApp-Automation/1.0',
          'Accept': 'text/html,application/xhtml+xml',
        }
      });
      const elapsed = Date.now() - startTime;
      
      console.log(`✅ [result] ${id} carregado em ${elapsed}ms (${html.length} bytes)`);
      
      const $ = cheerio.load(html);

      // Tenta vários seletores para encontrar o ganhador
      let winner =
        $('[data-winner]').text().trim() ||
        $('.winner,.ganhador,.resultado .nome').first().text().trim();

      // Fallback: busca por regex no texto da página
      if (!winner) {
        const body = $('body').text();
        
        // Padrões para encontrar o nome do ganhador
        const patterns = [
          // "🎉 GANHADOR DO SORTEIO! 🎉\nMaria Jose"
          /GANHADOR(?:\s+DO\s+SORTEIO)?[!\s]*🎉?\s*([A-Za-zÀ-ÿ\s]{3,50}?)(?:\n|Parabéns|$)/i,
          // "Ganhador: Maria Jose"
          /Ganhador[a:]?\s*([A-Za-zÀ-ÿ\s]{3,50})/i,
          // Texto entre emojis e "Parabéns"
          /🎉\s*([A-Za-zÀ-ÿ\s]{3,50})\s*(?:Parabéns|$)/i,
        ];
        
        for (const pattern of patterns) {
          const m = body.match(pattern);
          if (m && m[1]) {
            winner = m[1].trim();
            // Remove espaços extras
            winner = winner.replace(/\s+/g, ' ').trim();
            console.log(`📝 [result] Ganhador encontrado via regex: "${winner}"`);
            break;
          }
        }
      }

      // Limpa o nome do ganhador
      if (winner) {
        winner = winner.replace(/\s+/g, ' ').trim();
        // Remove emojis no início/fim
        winner = winner.replace(/^[🎉🏆👑\s]+|[🎉🏆👑\s]+$/g, '').trim();
      }

      // Busca número de participantes
      let participants = 0;
      const text = $('body').text();
      const mm = text.match(/(\d+)\s+participantes?/i);
      if (mm) participants = parseInt(mm[1], 10);

      const result = { 
        url, 
        winner: winner || 'Ganhador(a)', 
        participants 
      };
      
      console.log(`📤 [result] Resultado para ${id}:`, JSON.stringify(result));
      
      return result;
      
    } catch (e) {
      lastError = e;
      const errorMsg = e?.code || e?.message || String(e);
      console.error(`❌ [result] Erro tentativa ${attempt}/${MAX_RETRIES} para ${id}: ${errorMsg}`);
      
      if (attempt < MAX_RETRIES) {
        console.log(`⏳ [result] Aguardando ${RETRY_DELAY}ms antes de retry...`);
        await sleep(RETRY_DELAY);
      }
    }
  }
  
  // Se chegou aqui, todas as tentativas falharam
  console.error(`💀 [result] TODAS as ${MAX_RETRIES} tentativas falharam para ${id}!`);
  console.error(`💀 [result] Último erro: ${lastError?.message || lastError}`);
  throw lastError;
}

module.exports = { fetchResultInfo };
