const { google } = require('googleapis');

function getAuth() {
  const raw = process.env.GOOGLE_SHEETS_CREDENTIALS;
  if (!raw) throw new Error('GOOGLE_SHEETS_CREDENTIALS ausente');
  const creds = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];
  return new google.auth.JWT(creds.client_email, null, creds.private_key, scopes);
}

async function getRows() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  const tab = process.env.GOOGLE_SHEETS_TAB || 'Sorteios';
  const range = `${tab}!A1:Z1000`;
  
  // 🔥 CORREÇÃO: Adiciona opções para bypass de cache
  const { data } = await sheets.spreadsheets.values.get({ 
    spreadsheetId, 
    range,
    // Força o Google Sheets a retornar dados frescos (não cacheados)
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });
  
  const rows = data.values || [];
  if (!rows.length) return { headers: [], items: [] };
  
  const headers = rows[0].map(h => (h || '').trim());
  const items = rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = r[i] || '');
    return obj;
  });
  
  return { headers, items, spreadsheetId, tab, sheets };
}

function colA1(colIdx) {
  // suporta até Z... (simples para nossa faixa A..Z)
  return String.fromCharCode(65 + colIdx);
}

async function ensureHeader(sheets, spreadsheetId, tab, headers, header) {
  let idx = headers.indexOf(header);
  if (idx >= 0) return idx;
  idx = headers.length;
  headers.push(header);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A1:${colA1(idx)}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers] }
  });
  return idx;
}

async function updateCellByHeader(sheets, spreadsheetId, tab, headers, rowIndex1, header, value) {
  const colIndex = await ensureHeader(sheets, spreadsheetId, tab, headers, header);
  const a1 = `${tab}!${colA1(colIndex)}${rowIndex1}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: a1, valueInputOption: 'RAW',
    requestBody: { values: [[value]] }
  });
}

module.exports = { getRows, updateCellByHeader };
