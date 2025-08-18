import fs from 'fs';
import path from 'path';

const env = (key, def = undefined) => (process.env[key] ?? def);

export const CONFIG = {
  port: Number(env('PORT', 3000)),
  env: env('NODE_ENV', 'development'),
  admin: {
    username: env('ADMIN_USERNAME', 'admin'),
    password: env('ADMIN_PASSWORD', 'admin123'),
    jwtSecret: env('JWT_SECRET', 'whatsapp-automation-secret-key')
  },
  whatsapp: {
    sessionPath: env('WHATSAPP_SESSION_PATH', '/tmp/whatsapp-session'),
    phoneNumber: env('WHATSAPP_PHONE_NUMBER', ''), // somente pair code se preenchido
    clearSession: env('CLEAR_WHATSAPP_SESSION', 'false') === 'true',
    forceNew: env('FORCE_NEW_SESSION', 'false') === 'true',
    forceQR: env('FORCE_QR_CODE', 'false') === 'true',
    debug: env('DEBUG_WHATSAPP', 'false') === 'true'
  }
};

// garante diretório de sessão
fs.mkdirSync(CONFIG.whatsapp.sessionPath, { recursive: true });

