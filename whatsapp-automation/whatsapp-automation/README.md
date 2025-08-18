# 🤖 WhatsApp Automation - Sistema de Sorteios

Sistema completo de automação para postagens de resultados de sorteios no WhatsApp, desenvolvido especificamente para automatizar o processo diário de divulgação de ganhadores.

## 📋 Índice

- [Visão Geral](#-visão-geral)
- [Funcionalidades](#-funcionalidades)
- [Arquitetura](#-arquitetura)
- [Instalação](#-instalação)
- [Configuração](#-configuração)
- [Deploy no Render](#-deploy-no-render)
- [Uso](#-uso)
- [API](#-api)
- [Monitoramento](#-monitoramento)
- [Troubleshooting](#-troubleshooting)
- [Contribuição](#-contribuição)

## 🎯 Visão Geral

O WhatsApp Automation é um sistema robusto que automatiza completamente o processo de:

1. **Coleta de dados** - Busca sorteios na planilha Google Sheets
2. **Scraping de resultados** - Extrai dados atualizados dos sites de sorteios
3. **Geração de imagens** - Cria imagens profissionais automaticamente
4. **Envio automatizado** - Posta nos grupos WhatsApp com intervalos seguros
5. **Monitoramento** - Acompanha todo o processo com alertas

### 🕘 Funcionamento Diário

- **18:15** - Sistema verifica sorteios de hoje
- **18:16** - Faz scraping dos dados atualizados
- **18:17** - Gera imagens personalizadas
- **18:18** - Envia para grupos ativos com intervalos de 30s
- **18:25** - Processo concluído, relatório enviado

## ✨ Funcionalidades

### 🎯 Core Features
- ✅ Processamento automático diário às 18:15
- ✅ Integração com Google Sheets
- ✅ Scraping inteligente de dados
- ✅ Geração dinâmica de imagens
- ✅ Envio sequencial para múltiplos grupos
- ✅ Sistema de templates de texto personalizáveis
- ✅ Gestão de cupons promocionais

### 🛡️ Segurança & Confiabilidade
- ✅ Rate limiting para evitar bloqueios
- ✅ Circuit breaker para falhas temporárias
- ✅ Retry automático com backoff exponencial
- ✅ Idempotência para evitar duplicatas
- ✅ Logs detalhados de auditoria

### 📊 Monitoramento & Alertas
- ✅ Health checks automáticos
- ✅ Métricas Prometheus
- ✅ Alertas por email e Telegram
- ✅ Dashboard administrativo web
- ✅ Relatórios diários automáticos

### 🔧 Gestão & Configuração
- ✅ Painel administrativo web
- ✅ CRUD de grupos WhatsApp
- ✅ Gestão de textos base
- ✅ Configuração de cupons
- ✅ Processamento manual de sorteios

## 🏗️ Arquitetura

### Componentes Principais

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Google Sheets │    │   Site Sorteios │    │    WhatsApp     │
│   (Planilha)    │    │   (Scraping)    │    │   (Baileys)     │
└─────────┬───────┘    └─────────┬───────┘    └─────────┬───────┘
          │                      │                      │
          ▼                      ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    WhatsApp Automation                         │
├─────────────────┬─────────────────┬─────────────────┬───────────┤
│   Scheduler     │   Scraper       │   Image Gen     │   Alerts  │
│   (Node-Cron)   │   (Axios)       │   (Puppeteer)   │   (Multi) │
├─────────────────┼─────────────────┼─────────────────┼───────────┤
│   Database      │   Metrics       │   Health        │   Admin   │
│   (SQLite)      │   (Prometheus)  │   (Monitor)     │   (Web)   │
└─────────────────┴─────────────────┴─────────────────┴───────────┘
```

### Tecnologias Utilizadas

- **Backend**: Node.js + Express
- **WhatsApp**: @whiskeysockets/baileys
- **Banco**: SQLite com triggers
- **Agendamento**: node-cron
- **Imagens**: Puppeteer
- **Monitoramento**: Prometheus + Winston
- **Deploy**: Render.com

## 🚀 Instalação

### Pré-requisitos

- Node.js 18+ 
- Git
- Conta Google (para Sheets API)
- Número WhatsApp (para bot)

### 1. Clone o Repositório

```bash
git clone https://github.com/murilo-1234/processador-sorteios-api.git
cd whatsapp-automation
```

### 2. Instale Dependências

```bash
npm install --legacy-peer-deps
```

### 3. Configure Ambiente

```bash
cp .env.example .env
# Edite o arquivo .env com suas configurações
```

### 4. Execute Migrações

```bash
node src/scripts/migrate.js
```

### 5. Inicie o Sistema

```bash
npm start
```

## ⚙️ Configuração

### Variáveis de Ambiente Obrigatórias

```env
# Configurações básicas
PORT=3000
NODE_ENV=production
JWT_SECRET=sua-chave-secreta-super-forte
ADMIN_PASSWORD=sua-senha-admin

# Google Sheets
GOOGLE_SHEETS_ID=id-da-sua-planilha
GOOGLE_SHEETS_CREDENTIALS_PATH=./src/config/google-credentials.json

# Alertas (opcionais)
SENDGRID_API_KEY=sua-chave-sendgrid
ALERT_EMAIL=seu-email@exemplo.com
TELEGRAM_BOT_TOKEN=token-do-bot
TELEGRAM_CHAT_ID=id-do-chat
```

### Configuração Google Sheets

1. **Crie um projeto no Google Cloud Console**
2. **Ative a Google Sheets API**
3. **Crie uma conta de serviço**
4. **Baixe o arquivo JSON de credenciais**
5. **Coloque em `src/config/google-credentials.json`**
6. **Compartilhe a planilha com o email da conta de serviço**

### Estrutura da Planilha

A planilha deve ter as seguintes colunas:

| Código | Data | Prêmio | URL Resultado |
|--------|------|--------|---------------|
| a09    | 12/08/2024 | iPhone 15 | https://... |
| b10    | 12/08/2024 | AirPods | https://... |

## 🌐 Deploy no Render

### 1. Preparação

1. **Fork o repositório** para sua conta GitHub
2. **Configure as credenciais** Google Sheets
3. **Teste localmente** antes do deploy

### 2. Configuração no Render

1. **Conecte seu repositório** GitHub
2. **Configure as variáveis de ambiente**:

```env
NODE_ENV=production
PORT=3000
JWT_SECRET=sua-chave-secreta-super-forte-aqui
ADMIN_PASSWORD=sua-senha-admin-segura
GOOGLE_SHEETS_ID=id-da-sua-planilha-google
SENDGRID_API_KEY=sua-chave-sendgrid-opcional
ALERT_EMAIL=seu-email@exemplo.com
TELEGRAM_BOT_TOKEN=token-do-bot-opcional
TELEGRAM_CHAT_ID=id-do-chat-opcional
```

3. **Configure o build**:
   - Build Command: `chmod +x scripts/deploy.sh && ./scripts/deploy.sh`
   - Start Command: `npm start`

### 3. Deploy

1. **Faça o deploy** no Render
2. **Aguarde a conclusão** (5-10 minutos)
3. **Acesse os logs** para ver o QR Code
4. **Escaneie o QR Code** com seu WhatsApp
5. **Acesse o painel admin** em `/admin/login`

### 4. Pós-Deploy

1. **Sincronize os grupos** WhatsApp
2. **Configure grupos ativos** para sorteios
3. **Teste o processamento** manual
4. **Configure alertas** (opcional)

## 📱 Uso

### Painel Administrativo

Acesse `https://seu-app.render.com/admin/login` com a senha configurada.

#### Dashboard
- Status do sistema em tempo real
- Estatísticas de sorteios e envios
- Execução manual de jobs
- Processamento manual de sorteios

#### Gestão de Grupos
- Sincronização automática de grupos
- Ativação/desativação para sorteios
- Controle de grupos habilitados

#### Textos de Sorteios
- CRUD completo de templates
- Variáveis disponíveis: `{NOME_GANHADOR}`, `{PREMIO}`, `{LINK_RESULTADO}`, `{CUPOM}`
- Ativação/desativação de textos

#### Configurações
- Gestão de cupons promocionais
- Configurações do sistema

### Processamento Manual

Para processar um sorteio específico:

1. **Acesse o dashboard**
2. **Digite o código** do sorteio (ex: a09)
3. **Clique em "Processar"**
4. **Aguarde a confirmação**

### API Endpoints

```bash
# Health check
GET /health

# Status do sistema
GET /api/status

# Processar sorteio manual
POST /api/sorteios/processar
{
  "codigo": "a09"
}

# Limpar sessão WhatsApp
POST /api/whatsapp/clear-session
```

## 📊 Monitoramento

### Métricas Disponíveis

Acesse `/metrics` para ver métricas Prometheus:

- `wa_auto_messages_sent_total` - Total de mensagens enviadas
- `wa_auto_messages_failed_total` - Total de falhas no envio
- `wa_auto_baileys_connection_state` - Estado da conexão WhatsApp
- `wa_auto_job_processing_seconds` - Duração dos jobs
- `wa_auto_system_health` - Saúde dos componentes

### Health Checks

Acesse `/health` para verificar saúde do sistema:

```json
{
  "status": "healthy",
  "checks": {
    "database": { "status": "ok" },
    "whatsapp": { "status": "ok", "connected": true },
    "memory": { "status": "ok", "usage": "245MB" }
  }
}
```

### Alertas Automáticos

O sistema envia alertas para:

- ✅ WhatsApp desconectado/reconectado
- ✅ Falhas no processamento de sorteios
- ✅ Jobs com alta taxa de falhas
- ✅ Problemas de sistema (memória, CPU)
- ✅ Resumo diário de atividades

## 🔧 Troubleshooting

### Problemas Comuns

#### WhatsApp não conecta
```bash
# Limpar sessão via API
curl -X POST https://seu-app.render.com/api/whatsapp/clear-session

# Ou via painel admin
# Dashboard > Status WhatsApp > Limpar Sessão
```

#### Sorteios não são processados
1. **Verifique a planilha** - dados corretos?
2. **Teste o scraping** - site acessível?
3. **Verifique grupos** - ativos para sorteios?
4. **Logs de erro** - verifique `/api/logs/recent`

#### Imagens não são geradas
1. **Verifique Puppeteer** - funcionando?
2. **Teste health check** - `/health`
3. **Memória suficiente** - Render tem limite
4. **Logs detalhados** - verifique erros

#### Alertas não funcionam
1. **Variáveis configuradas** - email/Telegram?
2. **Teste alertas** - endpoint de teste
3. **Credenciais válidas** - SendGrid/Telegram
4. **Rate limiting** - muitos alertas?

### Logs e Debugging

```bash
# Ver logs recentes via API
curl https://seu-app.render.com/api/logs/recent

# Logs no Render
# Acesse o painel do Render > Logs
```

### Comandos Úteis

```bash
# Executar migração manual
node src/scripts/migrate.js

# Testar conexão Google Sheets
node -e "
const GoogleSheetsService = require('./src/services/google-sheets');
const service = new GoogleSheetsService();
service.testConnection().then(console.log).catch(console.error);
"

# Verificar saúde do sistema
curl https://seu-app.render.com/health
```

## 🤝 Contribuição

### Estrutura do Projeto

```
whatsapp-automation/
├── src/
│   ├── config/          # Configurações (DB, logs, etc)
│   ├── services/        # Serviços principais
│   ├── modules/         # Módulos de negócio
│   ├── routes/          # Rotas da API
│   ├── utils/           # Utilitários
│   └── scripts/         # Scripts de manutenção
├── data/                # Dados persistentes
├── logs/                # Arquivos de log
├── public/              # Arquivos estáticos
└── scripts/             # Scripts de deploy
```

### Desenvolvimento

1. **Fork o projeto**
2. **Crie uma branch** (`git checkout -b feature/nova-funcionalidade`)
3. **Faça suas alterações**
4. **Teste localmente**
5. **Commit suas mudanças** (`git commit -am 'Adiciona nova funcionalidade'`)
6. **Push para a branch** (`git push origin feature/nova-funcionalidade`)
7. **Abra um Pull Request**

### Padrões de Código

- **ESLint** para linting
- **Prettier** para formatação
- **Conventional Commits** para mensagens
- **JSDoc** para documentação

## 📄 Licença

Este projeto está licenciado sob a Licença MIT - veja o arquivo [LICENSE](LICENSE) para detalhes.

## 🆘 Suporte

- **Issues**: [GitHub Issues](https://github.com/murilo-1234/processador-sorteios-api/issues)
- **Documentação**: [Wiki do Projeto](https://github.com/murilo-1234/processador-sorteios-api/wiki)
- **Email**: murilo@exemplo.com

---

**Desenvolvido com ❤️ para automatizar sorteios no WhatsApp**



## Login no WhatsApp (Pairing/QR)
- **Pairing Code (numérico):** defina `WHATSAPP_PHONE_NUMBER=55DDDNUMERO` (sem `+`). Depois acesse `GET /code` para ver o código e digite no app (Aparelhos Conectados → Conectar com código).
- **QR Code:** acesse `GET /qr` e escaneie pelo WhatsApp (Aparelhos Conectados → Conectar aparelho).

> Se já houver sessão salva, apague o diretório configurado em `WHATSAPP_SESSION_PATH` para refazer o login.
