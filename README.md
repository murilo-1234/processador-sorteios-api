# 🎯 Processador de Sorteios API v1.0

Sistema automatizado que lê Google Sheets, processa produtos da Natura com imagens de sorteio, e hospeda no Render.com.

## 🚀 Funcionalidades

- ✅ **Integração Google Sheets:** Lê planilha automaticamente
- ✅ **Processamento Automático:** Produtos da Natura processados
- ✅ **Validação Semântica:** Seleção inteligente de imagens
- ✅ **Geração de Imagens:** Textos "Ganhe esse Top!" e "Sorteio"
- ✅ **Upload Automático:** Catbox.moe para hospedagem
- ✅ **API REST:** Endpoints completos para automação
- ✅ **CORS Habilitado:** Acesso de qualquer origem

## 📋 Endpoints da API

### Health Check
```
GET /api/sorteios/health
```

### Status do Sistema
```
GET /api/sorteios/status
```

### Processar Produto Individual
```
POST /api/sorteios/processar-produto
Content-Type: application/json

{
  "url": "https://www.natura.com.br/p/produto/NATBRA-123456"
}
```

### Processar Planilha Completa
```
POST /api/sorteios/processar-planilha
```

## 🔧 Deploy no Render.com

### Passo 1: Preparar Repositório
1. Faça upload de todos os arquivos para um repositório Git
2. Certifique-se que o arquivo `src/lithe-augury-466402-k6-52759a6c850c.json` está incluído

### Passo 2: Criar Serviço no Render
1. Acesse [render.com](https://render.com)
2. Clique em "New +" → "Web Service"
3. Conecte seu repositório Git
4. Configure:
   - **Name:** `processador-sorteios-api`
   - **Environment:** `Python 3`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `python src/main.py`

### Passo 3: Configurar Variáveis de Ambiente
No painel do Render, adicione:
- `FLASK_ENV` = `production`
- `PORT` = `10000` (automático)

### Passo 4: Deploy
1. Clique em "Create Web Service"
2. Aguarde o build e deploy (5-10 minutos)
3. Teste o endpoint: `https://seu-app.onrender.com/api/sorteios/health`

## 🔄 Automação com Cron

Para executar automaticamente a cada 30 minutos, configure um cron job que chama:
```bash
curl -X POST https://seu-app.onrender.com/api/sorteios/processar-planilha
```

## 📁 Estrutura do Projeto

```
processador-sorteios-api/
├── src/
│   ├── main.py                           # Servidor Flask principal
│   ├── routes/
│   │   ├── sorteios.py                   # Rotas da API
│   │   └── user.py                       # Rotas de usuário (template)
│   ├── models/
│   │   └── user.py                       # Modelos (template)
│   ├── static/
│   │   └── index.html                    # Página inicial
│   ├── processador_sorteio_v4_ajustado.py # Processador V4.1
│   └── lithe-augury-466402-k6-52759a6c850c.json # Credenciais Google
├── requirements.txt                      # Dependências Python
├── render.yaml                          # Configuração Render
├── Procfile                             # Comando de start
├── .env.example                         # Exemplo de variáveis
└── README.md                            # Este arquivo
```

## 🔐 Segurança

- ✅ Credenciais Google Sheets incluídas no código
- ✅ CORS configurado adequadamente
- ✅ Servidor configurado para 0.0.0.0
- ✅ Variáveis de ambiente para produção

## 🧪 Testes Locais

```bash
# Ativar ambiente virtual
source venv/bin/activate

# Instalar dependências
pip install -r requirements.txt

# Executar servidor
python src/main.py

# Testar endpoints
curl http://localhost:5001/api/sorteios/health
```

## 📊 Monitoramento

- **Health Check:** `/api/sorteios/health`
- **Status Detalhado:** `/api/sorteios/status`
- **Logs:** Disponíveis no painel do Render

## 🆘 Troubleshooting

### Erro de Conexão Google Sheets
- Verifique se o arquivo de credenciais está presente
- Confirme se a planilha está compartilhada com o email do service account

### Timeout na API
- Processamento pode levar 30-60 segundos por produto
- Configure timeout adequado no cliente

### Erro de Dependências
- Execute `pip freeze > requirements.txt` após instalar novas dependências
- Redeploy no Render após atualizar requirements.txt

## 📞 Suporte

Sistema desenvolvido para automação de sorteios da Natura com integração Google Sheets.

**Versão:** 1.0  
**Última Atualização:** Julho 2025

