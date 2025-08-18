# 📡 API Documentation - WhatsApp Automation

Documentação completa da API REST do sistema de automação WhatsApp.

## 📋 Índice

- [Visão Geral](#-visão-geral)
- [Autenticação](#-autenticação)
- [Endpoints Públicos](#-endpoints-públicos)
- [Endpoints Administrativos](#-endpoints-administrativos)
- [Códigos de Status](#-códigos-de-status)
- [Rate Limiting](#-rate-limiting)
- [Exemplos de Uso](#-exemplos-de-uso)

## 🌐 Visão Geral

A API do WhatsApp Automation fornece endpoints para:

- ✅ Monitoramento de saúde do sistema
- ✅ Processamento manual de sorteios
- ✅ Gestão de grupos WhatsApp
- ✅ Configuração de textos e cupons
- ✅ Visualização de métricas e logs
- ✅ Controle do sistema WhatsApp

**Base URL**: `https://seu-app.onrender.com`

## 🔐 Autenticação

### Endpoints Públicos
Não requerem autenticação:
- `/health`
- `/metrics`
- `/api/info`
- `/api/status`

### Endpoints Administrativos
Requerem autenticação via sessão ou token JWT:
- `/admin/*`
- `/api/sorteios/processar`
- `/api/whatsapp/*`

#### Login Administrativo

```http
POST /admin/auth/login
Content-Type: application/json

{
  "password": "sua-senha-admin"
}
```

**Resposta:**
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

## 🌍 Endpoints Públicos

### Health Check

Verifica a saúde geral do sistema.

```http
GET /health
```

**Resposta:**
```json
{
  "status": "healthy",
  "timestamp": "2024-08-13T18:30:00.000Z",
  "checks": {
    "database": {
      "status": "ok",
      "responseTime": 15
    },
    "whatsapp": {
      "status": "ok",
      "connected": true,
      "queueLength": 0
    },
    "memory": {
      "status": "ok",
      "memory_usage_mb": 245.67
    }
  }
}
```

### Status do Sistema

Informações detalhadas sobre o status dos componentes.

```http
GET /api/status
```

**Resposta:**
```json
{
  "whatsapp": {
    "connected": true,
    "queueLength": 0,
    "circuitBreakerState": "closed"
  },
  "jobs": {
    "initialized": true,
    "activeJobs": 3
  },
  "metrics": {
    "messagesSent": 150,
    "messagesFailed": 2,
    "whatsappConnected": true,
    "activeJobs": 0,
    "uptimeSeconds": 86400,
    "uptimeFormatted": "1d 0h 0m"
  },
  "timestamp": "2024-08-13T18:30:00.000Z"
}
```

### Informações da API

Lista todos os endpoints disponíveis.

```http
GET /api/info
```

**Resposta:**
```json
{
  "name": "WhatsApp Automation API",
  "version": "1.0.0",
  "description": "API para automação de postagens de sorteios no WhatsApp",
  "endpoints": {
    "health": "GET /health",
    "status": "GET /api/status",
    "sorteios": {
      "stats": "GET /api/sorteios/stats",
      "processar": "POST /api/sorteios/processar"
    }
  }
}
```

### Métricas Prometheus

Métricas do sistema em formato Prometheus.

```http
GET /metrics
```

**Resposta:**
```
# HELP wa_auto_messages_sent_total Total de mensagens enviadas com sucesso
# TYPE wa_auto_messages_sent_total counter
wa_auto_messages_sent_total{grupo_nome="Grupo Teste",codigo_sorteio="a09"} 1

# HELP wa_auto_baileys_connection_state Estado da conexão WhatsApp
# TYPE wa_auto_baileys_connection_state gauge
wa_auto_baileys_connection_state 1
```

## 🔧 Endpoints Administrativos

### Estatísticas de Sorteios

```http
GET /api/sorteios/stats
Authorization: Bearer <token>
```

**Resposta:**
```json
{
  "success": true,
  "data": {
    "sorteios": {
      "total_processados": 45,
      "hoje": 3,
      "ontem": 5,
      "ultima_semana": 28
    },
    "envios": {
      "total_envios": 180,
      "enviados": 175,
      "falhados": 5
    }
  }
}
```

### Processar Sorteio Manual

```http
POST /api/sorteios/processar
Authorization: Bearer <token>
Content-Type: application/json

{
  "codigo": "a09"
}
```

**Resposta de Sucesso:**
```json
{
  "success": true,
  "data": {
    "codigo": "a09",
    "status": "success",
    "ganhador": "João Silva",
    "gruposEnviados": 6,
    "imagePath": "/data/images/sorteio-a09-1692123456789.png"
  }
}
```

**Resposta de Erro:**
```json
{
  "success": false,
  "error": "Sorteio não encontrado ou dados inválidos",
  "timestamp": "2024-08-13T18:30:00.000Z"
}
```

### Grupos WhatsApp

#### Listar Grupos

```http
GET /admin/api/grupos
Authorization: Bearer <token>
```

**Resposta:**
```json
[
  {
    "jid": "123456789@g.us",
    "nome": "Grupo Sorteios",
    "ativo_sorteios": 1,
    "enabled": 1,
    "created_at": "2024-08-13T10:00:00.000Z"
  }
]
```

#### Atualizar Grupo

```http
PUT /admin/api/grupos/{jid}
Authorization: Bearer <token>
Content-Type: application/json

{
  "ativo_sorteios": true,
  "enabled": true
}
```

#### Sincronizar Grupos

```http
POST /admin/api/grupos/sync
Authorization: Bearer <token>
```

**Resposta:**
```json
{
  "success": true,
  "novosGrupos": 2,
  "totalGrupos": 8
}
```

### Textos de Sorteios

#### Listar Textos

```http
GET /admin/api/textos
Authorization: Bearer <token>
```

**Resposta:**
```json
[
  {
    "id": 1,
    "texto_template": "🎉 Parabéns {NOME_GANHADOR}!\n\nVocê ganhou o {PREMIO}!",
    "ativo": 1,
    "created_at": "2024-08-13T10:00:00.000Z"
  }
]
```

#### Criar/Atualizar Texto

```http
POST /admin/api/textos
Authorization: Bearer <token>
Content-Type: application/json

{
  "id": 1,
  "texto_template": "🎉 Parabéns {NOME_GANHADOR}!\n\nVocê ganhou o {PREMIO}!\n\n🔗 {LINK_RESULTADO}",
  "ativo": true
}
```

#### Deletar Texto

```http
DELETE /admin/api/textos/{id}
Authorization: Bearer <token>
```

### Cupons

#### Obter Cupons Atuais

```http
GET /admin/api/cupons
Authorization: Bearer <token>
```

**Resposta:**
```json
{
  "cupom1": "PEGAJ",
  "cupom2": "DESCONTO10",
  "atualizado_em": "2024-08-13T10:00:00.000Z"
}
```

#### Atualizar Cupons

```http
POST /admin/api/cupons
Authorization: Bearer <token>
Content-Type: application/json

{
  "cupom1": "NOVOCUPOM",
  "cupom2": "DESCONTO20"
}
```

### WhatsApp

#### Status do QR Code

```http
GET /api/whatsapp/qr
```

**Resposta:**
```json
{
  "success": true,
  "data": {
    "isConnected": false,
    "qrCodeGenerated": true,
    "needsQR": false,
    "message": "QR Code gerado, verifique os logs"
  }
}
```

#### Limpar Sessão

```http
POST /api/whatsapp/clear-session
Authorization: Bearer <token>
```

**Resposta:**
```json
{
  "success": true,
  "message": "Sessão limpa com sucesso. Novo QR Code será gerado."
}
```

### Jobs

#### Executar Job Manual

```http
POST /admin/api/jobs/{name}/run
Authorization: Bearer <token>
```

**Parâmetros:**
- `name`: Nome do job (`sorteios-diarios`, `limpeza-diaria`, `health-check`)

**Resposta:**
```json
{
  "success": true
}
```

### Logs

#### Logs Recentes

```http
GET /api/logs/recent?limit=100
```

**Resposta:**
```json
{
  "success": true,
  "data": [
    {
      "evento": "sorteio_processado",
      "detalhes": "Sorteio a09 processado com sucesso",
      "created_at": "2024-08-13T09:05:00.000Z"
    }
  ],
  "count": 50
}
```

### Histórico de Envios

```http
GET /api/envios/historico?limit=50&offset=0
```

**Resposta:**
```json
{
  "success": true,
  "data": [
    {
      "codigo_sorteio": "a09",
      "status": "sent",
      "enviado_em": "2024-08-13T09:05:30.000Z",
      "tentativas": 1,
      "grupo_nome": "Grupo Sorteios"
    }
  ],
  "pagination": {
    "total": 150,
    "limit": 50,
    "offset": 0,
    "hasMore": true
  }
}
```

## 📊 Códigos de Status

### Códigos de Sucesso
- `200` - OK
- `201` - Criado
- `204` - Sem conteúdo

### Códigos de Erro do Cliente
- `400` - Requisição inválida
- `401` - Não autorizado
- `403` - Proibido
- `404` - Não encontrado
- `429` - Muitas requisições

### Códigos de Erro do Servidor
- `500` - Erro interno do servidor
- `503` - Serviço indisponível

### Formato de Erro Padrão

```json
{
  "success": false,
  "error": "Descrição do erro",
  "code": "ERROR_CODE",
  "timestamp": "2024-08-13T18:30:00.000Z"
}
```

## 🚦 Rate Limiting

### Limites Aplicados

- **API Geral**: 100 requisições por 15 minutos por IP
- **Endpoints Admin**: 50 requisições por 15 minutos por IP
- **Processamento Manual**: 10 requisições por hora por IP

### Headers de Rate Limit

```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1692123456
```

### Resposta de Rate Limit

```json
{
  "error": "Muitas requisições deste IP, tente novamente em 15 minutos.",
  "code": "RATE_LIMIT_EXCEEDED",
  "retryAfter": 900
}
```

## 💡 Exemplos de Uso

### JavaScript/Node.js

```javascript
// Verificar status do sistema
const response = await fetch('https://seu-app.onrender.com/api/status');
const status = await response.json();
console.log('WhatsApp conectado:', status.whatsapp.connected);

// Processar sorteio com autenticação
const loginResponse = await fetch('https://seu-app.onrender.com/admin/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'sua-senha' })
});
const { token } = await loginResponse.json();

const sorteioResponse = await fetch('https://seu-app.onrender.com/api/sorteios/processar', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({ codigo: 'a09' })
});
const resultado = await sorteioResponse.json();
```

### Python

```python
import requests

# Health check
response = requests.get('https://seu-app.onrender.com/health')
health = response.json()
print(f"Status: {health['status']}")

# Processar sorteio
login_data = {"password": "sua-senha"}
login_response = requests.post(
    'https://seu-app.onrender.com/admin/auth/login',
    json=login_data
)
token = login_response.json()['token']

headers = {"Authorization": f"Bearer {token}"}
sorteio_data = {"codigo": "a09"}
sorteio_response = requests.post(
    'https://seu-app.onrender.com/api/sorteios/processar',
    json=sorteio_data,
    headers=headers
)
resultado = sorteio_response.json()
```

### cURL

```bash
# Health check
curl https://seu-app.onrender.com/health

# Login
TOKEN=$(curl -s -X POST https://seu-app.onrender.com/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"sua-senha"}' | jq -r '.token')

# Processar sorteio
curl -X POST https://seu-app.onrender.com/api/sorteios/processar \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"codigo":"a09"}'

# Sincronizar grupos
curl -X POST https://seu-app.onrender.com/admin/api/grupos/sync \
  -H "Authorization: Bearer $TOKEN"
```

## 🔍 Debugging

### Verificar Conectividade

```bash
# Teste básico de conectividade
curl -I https://seu-app.onrender.com/health

# Verificar tempo de resposta
curl -w "@curl-format.txt" -o /dev/null -s https://seu-app.onrender.com/health
```

### Monitorar Logs em Tempo Real

```bash
# Via API (requer autenticação)
curl -H "Authorization: Bearer $TOKEN" \
  https://seu-app.onrender.com/api/logs/recent?limit=10
```

### Testar Endpoints

```bash
# Script de teste completo
#!/bin/bash
BASE_URL="https://seu-app.onrender.com"

echo "Testando health check..."
curl -s "$BASE_URL/health" | jq '.status'

echo "Testando status..."
curl -s "$BASE_URL/api/status" | jq '.whatsapp.connected'

echo "Testando métricas..."
curl -s "$BASE_URL/metrics" | grep "wa_auto_baileys_connection_state"
```

## 📚 SDKs e Bibliotecas

### JavaScript SDK (Exemplo)

```javascript
class WhatsAppAutomationAPI {
  constructor(baseUrl, password) {
    this.baseUrl = baseUrl;
    this.password = password;
    this.token = null;
  }

  async login() {
    const response = await fetch(`${this.baseUrl}/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: this.password })
    });
    const data = await response.json();
    this.token = data.token;
    return this.token;
  }

  async processarSorteio(codigo) {
    if (!this.token) await this.login();
    
    const response = await fetch(`${this.baseUrl}/api/sorteios/processar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify({ codigo })
    });
    return response.json();
  }

  async getStatus() {
    const response = await fetch(`${this.baseUrl}/api/status`);
    return response.json();
  }
}

// Uso
const api = new WhatsAppAutomationAPI('https://seu-app.onrender.com', 'sua-senha');
const resultado = await api.processarSorteio('a09');
```

---

**API Documentation v1.0.0** 📡

