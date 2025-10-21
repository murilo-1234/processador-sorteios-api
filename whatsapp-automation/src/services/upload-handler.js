// src/services/upload-handler.js
'use strict';

const multer = require('multer');
const path = require('path');
const fs = require('fs');

const MAX_FILE_SIZE = (Number(process.env.MAX_FILE_SIZE_MB) || 16) * 1024 * 1024;
const CUSTOM_MEDIA_DIR = process.env.CUSTOM_MEDIA_DIR || '/data/media/custom';

// Criar pasta se não existir
if (!fs.existsSync(CUSTOM_MEDIA_DIR)) {
  fs.mkdirSync(CUSTOM_MEDIA_DIR, { recursive: true });
}

// Configuração de storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, CUSTOM_MEDIA_DIR);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'custom_' + uniqueSuffix + ext);
  }
});

// Filtro de tipos de arquivo
const fileFilter = (req, file, cb) => {
  const allowedMimes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'video/mp4',
    'video/quicktime'
  ];
  
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Tipo não permitido. Use JPG, PNG, GIF ou MP4.'));
  }
};

const upload = multer({
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE
  },
  fileFilter: fileFilter
});

module.exports = upload;
