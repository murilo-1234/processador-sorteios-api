# WhatsApp Automation System

Sistema de automação para WhatsApp com dashboard web e gestão de grupos.

## 🚀 Deploy no Render

### 1. Configurar Variáveis de Ambiente

```bash
NODE_VERSION=18
NODE_ENV=production
TZ=America/Sao_Paulo
PORT=10000
JWT_SECRET=sua-chave-secreta-aqui
ADMIN_USERNAME=admin
ADMIN_PASSWORD=sua-senha-forte-aqui
WHATSAPP_SESSION_PATH=/tmp/whatsapp-session
DEBUG_WHATSAPP=true
```

### 2. Primeira Conexão

Para conectar via QR Code:
1. Acesse: `https://seu-app.onrender.com/qr`
2. Escaneie o QR Code no WhatsApp

Para conectar via Pairing Code:
1. Adicione: `WHATSAPP_PHONE_NUMBER=5511999999999`
2. Acesse: `https://seu-app.onrender.com/code`
3. Digite o código no WhatsApp

### 3. Usar o Sistema

- **Dashboard Público:** `/admin/public`
- **Dashboard Privado:** `/admin` (requer login)
- **Health Check:** `/health`
- **API Status:** `/api/status`

## 📱 Funcionalidades

- ✅ Conexão WhatsApp via QR ou Pairing Code
- ✅ Dashboard web responsivo
- ✅ Sincronização automática de grupos
- ✅ Gestão de grupos (ativar/desativar)
- ✅ API REST completa
- ✅ Health checks
- ✅ Persistência SQLite

## 🔧 Endpoints da API

- `GET /api/grupos` - Listar grupos
- `POST /api/grupos/sincronizar` - Sincronizar grupos
- `POST /api/grupos/:jid/toggle` - Ativar/desativar grupo
- `GET /api/grupos/ativos` - Grupos ativos
- `POST /api/sorteios/processar` - Processar sorteios
- `GET /api/status` - Status do sistema

## 🏗️ Arquitetura

```
src/
├── app.js              # Aplicação principal
├── config.js           # Configurações
├── logger.js           # Sistema de logs
├── db/
│   └── sqlite.js       # Banco de dados
├── whatsapp/
│   └── client.js       # Cliente WhatsApp
└── routes/
    ├── health.js       # Health checks
    ├── api.js          # API REST
    └── admin.js        # Dashboard
```

## 📊 Monitoramento

O sistema inclui health checks automáticos e métricas de:
- Status da conexão WhatsApp
- Estado do banco de dados
- Uso de memória
- Uptime do sistema

