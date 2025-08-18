# 🚀 Guia Completo de Deploy - WhatsApp Automation

Este guia detalha todo o processo de deploy do sistema no Render.com, desde a preparação até a configuração final.

## 📋 Pré-requisitos

### 1. Contas Necessárias
- ✅ Conta GitHub (para versionamento)
- ✅ Conta Render.com (para hospedagem)
- ✅ Conta Google Cloud (para Sheets API)
- ✅ Número WhatsApp (para o bot)
- ✅ Conta SendGrid (opcional, para alertas)
- ✅ Bot Telegram (opcional, para alertas)

### 2. Preparação Local
- ✅ Node.js 18+ instalado
- ✅ Git configurado
- ✅ Acesso ao repositório

## 🔧 Preparação do Ambiente

### 1. Fork do Repositório

```bash
# 1. Faça fork do repositório original
# https://github.com/murilo-1234/processador-sorteios-api

# 2. Clone seu fork
git clone https://github.com/SEU-USUARIO/processador-sorteios-api.git
cd processador-sorteios-api

# 3. Configure o remote upstream
git remote add upstream https://github.com/murilo-1234/processador-sorteios-api.git
```

### 2. Configuração Google Sheets API

#### Passo 1: Criar Projeto no Google Cloud
1. Acesse [Google Cloud Console](https://console.cloud.google.com/)
2. Clique em "Criar Projeto"
3. Nome: "WhatsApp Automation"
4. Clique em "Criar"

#### Passo 2: Ativar APIs
1. No menu lateral, vá em "APIs e Serviços" > "Biblioteca"
2. Procure por "Google Sheets API"
3. Clique em "Ativar"

#### Passo 3: Criar Conta de Serviço
1. Vá em "APIs e Serviços" > "Credenciais"
2. Clique em "Criar Credenciais" > "Conta de serviço"
3. Nome: "whatsapp-automation-service"
4. Clique em "Criar e continuar"
5. Papel: "Editor" (ou "Visualizador" se só for ler)
6. Clique em "Concluir"

#### Passo 4: Gerar Chave JSON
1. Na lista de contas de serviço, clique na criada
2. Vá na aba "Chaves"
3. Clique em "Adicionar chave" > "Criar nova chave"
4. Tipo: JSON
5. Clique em "Criar"
6. **Salve o arquivo JSON** (será usado no deploy)

#### Passo 5: Configurar Planilha
1. Abra sua planilha Google Sheets
2. Clique em "Compartilhar"
3. Adicione o email da conta de serviço (ex: `whatsapp-automation-service@projeto.iam.gserviceaccount.com`)
4. Permissão: "Editor" ou "Visualizador"
5. **Copie o ID da planilha** da URL (será usado no deploy)

### 3. Configuração de Alertas (Opcional)

#### SendGrid (Email)
1. Crie conta em [SendGrid](https://sendgrid.com/)
2. Vá em "Settings" > "API Keys"
3. Clique em "Create API Key"
4. Nome: "WhatsApp Automation"
5. Permissões: "Full Access"
6. **Copie a API Key** (será usada no deploy)

#### Telegram (Mensagens)
1. Abra o Telegram
2. Procure por "@BotFather"
3. Digite `/newbot`
4. Siga as instruções para criar o bot
5. **Copie o token** do bot
6. Para obter o Chat ID:
   ```bash
   # Envie uma mensagem para seu bot
   # Depois acesse:
   https://api.telegram.org/bot<SEU_TOKEN>/getUpdates
   # Copie o "chat_id" da resposta
   ```

## 🌐 Deploy no Render

### 1. Preparar Credenciais Google

Antes do deploy, você precisa converter o arquivo JSON das credenciais Google para uma variável de ambiente:

```bash
# Copie todo o conteúdo do arquivo JSON baixado
# Ele deve estar em uma única linha, algo como:
{"type":"service_account","project_id":"...","private_key_id":"..."}
```

### 2. Criar Serviço no Render

1. **Acesse [Render.com](https://render.com/)**
2. **Faça login** com sua conta
3. **Clique em "New +"** > "Web Service"
4. **Conecte seu repositório** GitHub
5. **Selecione o repositório** forkado

### 3. Configurar Build

#### Configurações Básicas
- **Name**: `whatsapp-automation-sorteios`
- **Environment**: `Node`
- **Region**: `Oregon (US West)` (mais barato)
- **Branch**: `main`

#### Comandos de Build
- **Build Command**: 
  ```bash
  chmod +x scripts/deploy.sh && ./scripts/deploy.sh
  ```
- **Start Command**: 
  ```bash
  npm start
  ```

#### Configurações Avançadas
- **Auto-Deploy**: `Yes` (deploy automático no push)

### 4. Configurar Variáveis de Ambiente

Na seção "Environment Variables", adicione:

#### Obrigatórias
```env
NODE_ENV=production
PORT=3000
JWT_SECRET=sua-chave-secreta-super-forte-aqui-min-32-chars
ADMIN_PASSWORD=sua-senha-admin-super-segura
GOOGLE_SHEETS_ID=id-da-sua-planilha-google-sheets
```

#### Credenciais Google (Cole o JSON inteiro)
```env
GOOGLE_SHEETS_CREDENTIALS={"type":"service_account","project_id":"..."}
```

#### Alertas (Opcionais)
```env
SENDGRID_API_KEY=SG.sua-chave-sendgrid-aqui
EMAIL_FROM=noreply@seudominio.com
ALERT_EMAIL=seu-email@exemplo.com
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=123456789
```

#### Configurações Avançadas (Opcionais)
```env
LOG_LEVEL=info
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
JOB_SORTEIOS_CRON=0 9 * * *
METRICS_ENABLED=true
```

### 5. Iniciar Deploy

1. **Clique em "Create Web Service"**
2. **Aguarde o build** (5-10 minutos)
3. **Acompanhe os logs** em tempo real
4. **Aguarde status "Live"**

## 📱 Configuração Pós-Deploy

### 1. Conectar WhatsApp

1. **Acesse os logs** do serviço no Render
2. **Procure pelo QR Code** nos logs (aparece como ASCII art)
3. **Abra o WhatsApp** no seu celular
4. **Vá em "Aparelhos Conectados"**
5. **Clique em "Conectar Aparelho"**
6. **Escaneie o QR Code** dos logs
7. **Aguarde confirmação** nos logs

### 2. Acessar Painel Admin

1. **Acesse**: `https://seu-app.onrender.com/admin/login`
2. **Digite a senha** configurada em `ADMIN_PASSWORD`
3. **Clique em "Entrar"**

### 3. Configurar Grupos

1. **No dashboard**, clique em "Grupos"
2. **Clique em "Sincronizar Grupos"**
3. **Aguarde a sincronização**
4. **Ative os grupos** desejados para sorteios
5. **Marque como "Habilitado"** os grupos ativos

### 4. Testar Sistema

1. **No dashboard**, vá para a seção "Processar Sorteio Manual"
2. **Digite um código** de teste (ex: "teste")
3. **Clique em "Processar"**
4. **Verifique se funciona** (mesmo que dê erro de scraping, o sistema deve responder)

## 🔍 Verificação e Testes

### 1. Health Check

```bash
curl https://seu-app.onrender.com/health
```

Resposta esperada:
```json
{
  "status": "healthy",
  "checks": {
    "database": {"status": "ok"},
    "whatsapp": {"status": "ok", "connected": true}
  }
}
```

### 2. Status da API

```bash
curl https://seu-app.onrender.com/api/status
```

### 3. Métricas

Acesse: `https://seu-app.onrender.com/metrics`

### 4. Teste de Alertas

No painel admin, você pode testar os alertas configurados.

## 🚨 Troubleshooting

### Problemas Comuns

#### Build Falha
```bash
# Verifique os logs de build
# Problemas comuns:
# - Dependências não instaladas
# - Erro no script de deploy
# - Falta de permissões
```

**Solução**: Verifique se o script `scripts/deploy.sh` tem permissão de execução.

#### WhatsApp não conecta
```bash
# Limpe a sessão via API
curl -X POST https://seu-app.onrender.com/api/whatsapp/clear-session
```

**Solução**: Novo QR Code será gerado nos logs.

#### Google Sheets não funciona
1. **Verifique o ID** da planilha
2. **Confirme as credenciais** JSON
3. **Teste a permissão** da conta de serviço
4. **Verifique se a API** está ativada

#### Variáveis de ambiente
```bash
# No painel do Render, verifique se todas as variáveis estão configuradas
# Especialmente:
# - GOOGLE_SHEETS_ID
# - GOOGLE_SHEETS_CREDENTIALS
# - JWT_SECRET
# - ADMIN_PASSWORD
```

### Logs Úteis

```bash
# Ver logs em tempo real no Render
# Painel > Logs > Live Logs

# Ou via API
curl https://seu-app.onrender.com/api/logs/recent
```

## 🔄 Atualizações

### Deploy Automático

O sistema está configurado para deploy automático. Para atualizar:

```bash
# 1. Faça suas alterações
git add .
git commit -m "feat: nova funcionalidade"
git push origin main

# 2. O Render fará deploy automaticamente
# 3. Acompanhe o progresso no painel
```

### Deploy Manual

Se precisar forçar um redeploy:

1. **Acesse o painel** do Render
2. **Vá na aba "Manual Deploy"**
3. **Clique em "Deploy latest commit"**

## 📊 Monitoramento

### Métricas Importantes

- **Uptime**: Disponibilidade do serviço
- **Response Time**: Tempo de resposta da API
- **Memory Usage**: Uso de memória (limite: 512MB no plano gratuito)
- **WhatsApp Connection**: Status da conexão
- **Job Success Rate**: Taxa de sucesso dos jobs

### Alertas Configurados

O sistema enviará alertas para:
- ✅ WhatsApp desconectado
- ✅ Falhas no processamento
- ✅ Problemas de sistema
- ✅ Resumo diário

### Logs de Auditoria

Todos os eventos importantes são logados:
- Conexões/desconexões WhatsApp
- Processamento de sorteios
- Envios de mensagens
- Acessos ao painel admin
- Erros do sistema

## 🎯 Próximos Passos

Após o deploy bem-sucedido:

1. **Configure alertas** para monitoramento
2. **Teste o processamento** diário
3. **Monitore os logs** regularmente
4. **Faça backup** das configurações
5. **Documente** personalizações específicas

## 📞 Suporte

Se encontrar problemas:

1. **Verifique os logs** primeiro
2. **Consulte o troubleshooting**
3. **Teste os endpoints** de health
4. **Abra uma issue** no GitHub se necessário

---

**Deploy realizado com sucesso! 🎉**

