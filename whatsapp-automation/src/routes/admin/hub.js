// src/routes/admin/hub.js
const express = require('express');
const router = express.Router();
const path = require('path');

function getInstanceIds() {
  const raw = process.env.WA_INSTANCE_IDS || '';
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

router.get('/admin/hub', (req, res) => {
  const ids = getInstanceIds();
  const base = req.protocol + '://' + req.get('host');

  const rows = ids.length
    ? ids.map((id, idx) => {
        const n = idx + 1;
        return `
          <tr>
            <td style="font-family:monospace">${id}</td>
            <td>
              <a href="${base}/api/hub/inst/${id}/status" target="_blank">status</a> ·
              <a href="${base}/api/hub/inst/${id}/qr" target="_blank">qr</a> ·
              <a href="#" onclick="post('${base}/api/hub/inst/${id}/connect');return false;">conectar</a> ·
              <a href="#" onclick="post('${base}/api/hub/inst/${id}/disconnect');return false;">desconectar</a> ·
              <a href="#" onclick="if(confirm('Limpar sessão de ${id}?')) post('${base}/api/hub/inst/${id}/clear');return false;">limpar sessão</a> ·
              <a href="${base}/admin/whatsapp?inst=${encodeURIComponent(id)}" target="_blank">UI clássica</a>
            </td>
          </tr>
        `;
      }).join('')
    : `<tr><td colspan="2">Sem IDs. Defina a env <code>WA_INSTANCE_IDS</code> (ex.: 489111707,48922223333)</td></tr>`;

  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>Hub – Admin (multi)</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:2rem;line-height:1.4}
  table{border-collapse:collapse;width:100%;max-width:900px}
  td,th{border:1px solid #ddd;padding:.5rem .75rem}
  th{background:#f7f7f7;text-align:left}
  code{background:#f2f2f2;padding:.1rem .3rem;border-radius:4px}
  small{color:#666}
  .ok{color:#2d7a2d}
</style>
<script>
 async function post(url){
   const res = await fetch(url,{method:'POST'});
   if(res.ok){ alert('OK: '+url); } else { alert('ERRO: '+res.status+' '+url); }
 }
</script>
</head>
<body>
  <h1>Hub – Admin <small>(staging)</small></h1>
  <p>Rota do Admin conectada <span class="ok">✔</span></p>

  <p><a href="${base}/api/hub/instances" target="_blank">Ver instâncias (JSON)</a> ·
     <a href="${base}/health" target="_blank">Healthcheck</a></p>

  <table>
    <thead><tr><th>ID</th><th>Ações</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <p><small>Use “UI clássica” para abrir a tela com QR e botões focada para o ID escolhido.</small></p>
</body>
</html>
  `);
});

// UI com múltiplas abas (abre a página /public/admin-multi.html)
router.get('/admin/wa-multi', (req, res) => {
  res.sendFile(path.join(__dirname, '../../../public/admin-multi.html'));
});

module.exports = router;
