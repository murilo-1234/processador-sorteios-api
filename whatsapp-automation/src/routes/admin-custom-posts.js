// src/routes/admin-custom-posts.js
'use strict';

const express = require('express');
const router = express.Router();
const upload = require('../services/upload-handler');
const {
  getCustomPostsRows,
  createCustomPost,
  updateCustomPost,
  deleteCustomPost,
  getNextId
} = require('../services/custom-posts');
const settings = require('../services/settings');

// Página principal
router.get('/', async (req, res) => {
  try {
    const posts = await getCustomPostsRows();
    const st = settings.get();
    const targetJids = Array.isArray(st.postGroupJids) && st.postGroupJids.length
      ? st.postGroupJids
      : (st.resultGroupJid ? [st.resultGroupJid] : []);
    
    const postsWithInfo = posts.map(post => {
      const gruposPostados = post.WA_CUSTOM_GROUPS 
        ? post.WA_CUSTOM_GROUPS.split(',').filter(Boolean).length 
        : 0;
      
      return {
        ...post,
        gruposPostados,
        totalGrupos: targetJids.length
      };
    });
    
    const today = new Date().toISOString().split('T')[0];
    
    res.render('admin-custom-posts', { posts: postsWithInfo, today });
    
  } catch (error) {
    console.error('[admin-custom-posts] Erro:', error);
    res.status(500).send(`Erro: ${error.message}`);
  }
});

// Criar post
router.post('/criar', upload.single('media'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Arquivo obrigatório' });
    }
    
    const { texto_1, texto_2, texto_3, texto_4, texto_5, data, hora } = req.body;
    
    if (!texto_1 || !texto_2 || !texto_3 || !texto_4 || !texto_5) {
      return res.status(400).json({ error: '5 textos obrigatórios' });
    }
    
    if (!data || !hora) {
      return res.status(400).json({ error: 'Data e hora obrigatórios' });
    }
    
    const id = await getNextId();
    
    await createCustomPost({
      id,
      data,
      hora,
      mediaPath: req.file.path,
      mediaType: req.file.mimetype,
      texto1: texto_1,
      texto2: texto_2,
      texto3: texto_3,
      texto4: texto_4,
      texto5: texto_5,
      duplicadoDe: null
    });
    
    res.redirect('/admin/agendamentos');
    
  } catch (error) {
    console.error('[admin-custom-posts] Erro ao criar:', error);
    res.status(500).json({ error: error.message });
  }
});

// Editar post (GET)
router.get('/editar/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const posts = await getCustomPostsRows();
    const post = posts.find(p => p.ID === id);
    
    if (!post) {
      return res.status(404).send('Post não encontrado');
    }
    
    if (!['Agendado', 'Duplicado'].includes(post.STATUS)) {
      return res.status(400).send('Só é possível editar posts com status "Agendado" ou "Duplicado"');
    }
    
    const today = new Date().toISOString().split('T')[0];
    res.render('admin-custom-posts-edit', { post, today });
    
  } catch (error) {
    console.error('[admin-custom-posts] Erro:', error);
    res.status(500).send(`Erro: ${error.message}`);
  }
});

// Salvar edição (POST)
router.post('/editar/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { texto_1, texto_2, texto_3, texto_4, texto_5, data, hora } = req.body;
    
    await updateCustomPost(id, {
      STATUS: 'Agendado',  // 🔥 Muda STATUS para Agendado ao salvar
      TEXTO_1: texto_1,
      TEXTO_2: texto_2,
      TEXTO_3: texto_3,
      TEXTO_4: texto_4,
      TEXTO_5: texto_5,
      DATA: data,
      HORA: hora,
      ATUALIZADO_EM: new Date().toISOString()
    });
    
    res.redirect('/admin/agendamentos');
    
  } catch (error) {
    console.error('[admin-custom-posts] Erro:', error);
    res.status(500).json({ error: error.message });
  }
});

// Duplicar
router.post('/duplicar/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const posts = await getCustomPostsRows();
    const post = posts.find(p => p.ID === id);
    
    if (!post) {
      return res.status(404).json({ error: 'Post não encontrado' });
    }
    
    const newId = await getNextId();
    
    // 🔥 Cria com STATUS: Duplicado
    await createCustomPost({
      id: newId,
      status: 'Duplicado',
      data: '',
      hora: '',
      mediaPath: post.MEDIA_PATH,
      mediaType: post.MEDIA_TYPE,
      texto1: post.TEXTO_1,
      texto2: post.TEXTO_2,
      texto3: post.TEXTO_3,
      texto4: post.TEXTO_4,
      texto5: post.TEXTO_5,
      duplicadoDe: id
    });
    
    res.json({ ok: true, newId });
    
  } catch (error) {
    console.error('[admin-custom-posts] Erro:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cancelar
router.post('/cancelar/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    await updateCustomPost(id, {
      STATUS: 'Cancelado',
      ATUALIZADO_EM: new Date().toISOString()
    });
    
    res.json({ ok: true });
    
  } catch (error) {
    console.error('[admin-custom-posts] Erro:', error);
    res.status(500).json({ error: error.message });
  }
});

// Deletar
router.delete('/deletar/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await deleteCustomPost(id);
    res.json({ ok: true });
    
  } catch (error) {
    console.error('[admin-custom-posts] Erro:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
