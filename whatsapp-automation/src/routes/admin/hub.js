// src/routes/admin/hub.js
const express = require('express');
const router = express.Router();

// Página mínima só para validar a rota /admin/hub no staging
router.get('/admin/hub', (req, res) => {
  res.type('html').send(`
    <!doctype html>
    <meta charset="utf-8"/>
    <title>Hub Admin (staging)</title>
    <style>
      body{font:16px/1.5 system-ui,Segoe UI,Roboto,Arial;margin:24px;color:#222}
      a{color:#0a58ca;text-decoration:none} a:hover{text-decoration:underline}
      .box{padding:16px;border:1px solid #ddd;border-radius:12px;max-width:720px}
      h1{margin-top:0}
    </style>
    <div class="box">
      <h1>Hub – Admin (staging)</h1>
      <p>Rota do Admin conectada com sucesso ✅</p>
      <ul>
        <li><a href="/api/hub/instances" target="_blank">Ver instâncias (JSON)</a></li>
        <li><a href="/health" target="_blank">Healthcheck</a></li>
      </ul>
      <p>Depois colocamos aqui a interface completa.</p>
    </div>
  `);
});

module.exports = router;   // <- MUITO importante!
