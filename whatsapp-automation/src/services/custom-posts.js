// src/services/custom-posts.js
'use strict';

const { google } = require('googleapis');

const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID;
const CUSTOM_TAB = process.env.GOOGLE_SHEETS_CUSTOM_TAB || 'POSTS_AGENDADOS';

let _sheets = null;
let _lastCredentials = null;

function getSheets() {
  const creds = process.env.GOOGLE_SHEETS_CREDENTIALS;
  
  if (!creds) {
    throw new Error('GOOGLE_SHEETS_CREDENTIALS não configurado');
  }
  
  if (_sheets && _lastCredentials === creds) {
    return _sheets;
  }
  
  try {
    const parsed = JSON.parse(creds);
    const auth = new google.auth.GoogleAuth({
      credentials: parsed,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    _sheets = google.sheets({ version: 'v4', auth });
    _lastCredentials = creds;
    
    return _sheets;
  } catch (e) {
    throw new Error(`Erro ao inicializar Google Sheets: ${e.message}`);
  }
}

async function getCustomPostsRows() {
  const sheets = getSheets();
  
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${CUSTOM_TAB}!A1:P1000`,  // 🔥 Aumentei para coluna P (DUPLICADO_DE)
    });
    
    const rows = response.data.values || [];
    
    if (rows.length === 0) {
      return [];
    }
    
    const headers = rows[0];
    const dataRows = rows.slice(1);
    
    return dataRows.map(row => {
      const obj = {};
      headers.forEach((header, i) => {
        obj[header] = row[i] || '';
      });
      return obj;
    });
  } catch (e) {
    console.error('[custom-posts] Erro ao ler planilha:', e.message);
    throw e;
  }
}

async function updateCustomPost(id, updates) {
  const sheets = getSheets();
  
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${CUSTOM_TAB}!A:A`,
    });
    
    const rows = response.data.values || [];
    const rowIndex = rows.findIndex(row => row[0] === id);
    
    if (rowIndex === -1) {
      throw new Error(`Post ${id} não encontrado`);
    }
    
    const headersResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${CUSTOM_TAB}!1:1`,
    });
    
    const headers = headersResponse.data.values[0];
    
    for (const [key, value] of Object.entries(updates)) {
      const colIndex = headers.indexOf(key);
      
      if (colIndex === -1) {
        console.warn(`[custom-posts] Coluna ${key} não encontrada`);
        continue;
      }
      
      const colLetter = String.fromCharCode(65 + colIndex);
      const cellRange = `${CUSTOM_TAB}!${colLetter}${rowIndex + 1}`;
      
      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEETS_ID,
        range: cellRange,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[value]],
        },
      });
    }
    
    console.log(`[custom-posts] Post ${id} atualizado`);
    
  } catch (e) {
    console.error('[custom-posts] Erro ao atualizar:', e.message);
    throw e;
  }
}

async function createCustomPost(data) {
  const sheets = getSheets();
  
  try {
    const now = new Date().toISOString();
    
    // 🔥 Linha atualizada com 16 colunas (A-P)
    const row = [
      data.id,                          // A: ID
      data.status || 'Agendado',        // B: STATUS
      data.data,                        // C: DATA
      data.hora,                        // D: HORA
      data.mediaPath,                   // E: MEDIA_PATH
      data.mediaType,                   // F: MEDIA_TYPE
      data.texto1,                      // G: TEXTO_1
      data.texto2,                      // H: TEXTO_2
      data.texto3,                      // I: TEXTO_3
      data.texto4,                      // J: TEXTO_4
      data.texto5,                      // K: TEXTO_5
      '',                               // L: WA_CUSTOM_GROUPS
      '',                               // M: WA_POST_NEXT_AT
      now,                              // N: CRIADO_EM
      now,                              // O: ATUALIZADO_EM
      data.duplicadoDe || ''            // P: DUPLICADO_DE 🔥 NOVO
    ];
    
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${CUSTOM_TAB}!A:P`,       // 🔥 Range até P
      valueInputOption: 'RAW',
      requestBody: {
        values: [row],
      },
    });
    
    console.log(`[custom-posts] Post ${data.id} criado`);
    return { ok: true, id: data.id };
    
  } catch (e) {
    console.error('[custom-posts] Erro ao criar:', e.message);
    throw e;
  }
}

async function deleteCustomPost(id) {
  await updateCustomPost(id, {
    STATUS: 'Deletado',
    ATUALIZADO_EM: new Date().toISOString()
  });
}

async function getNextId() {
  const rows = await getCustomPostsRows();
  
  if (rows.length === 0) {
    return 'PA001';
  }
  
  const ids = rows.map(r => r.ID).filter(Boolean);
  const numbers = ids
    .map(id => parseInt(id.replace('PA', ''), 10))
    .filter(n => !isNaN(n));
  
  const maxNum = Math.max(...numbers, 0);
  return `PA${String(maxNum + 1).padStart(3, '0')}`;
}

module.exports = {
  getCustomPostsRows,
  updateCustomPost,
  createCustomPost,
  deleteCustomPost,
  getNextId
};
