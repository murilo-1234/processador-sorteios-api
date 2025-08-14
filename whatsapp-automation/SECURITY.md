# 🔒 Guia de Segurança

## 🚨 Credenciais Google Sheets

### ⚠️ NUNCA FAÇA ISSO:
```javascript
// ❌ CREDENCIAIS NO CÓDIGO
const credentials = {
  "type": "service_account",
  "private_key": "-----BEGIN PRIVATE KEY-----..."
}
```

### ✅ FAÇA ASSIM:

#### **Produção (Render.com):**
```env
GOOGLE_SHEETS_CREDENTIALS={"type":"service_account","project_id":"seu-projeto",...}
```

#### **Desenvolvimento Local:**
```env
GOOGLE_SHEETS_CREDENTIALS_PATH=./src/config/google-credentials.json
```

## 🛡️ Configuração Segura

### 1. **Criar arquivo local** (apenas desenvolvimento):
```bash
# Criar arquivo de credenciais local
cp src/config/google-credentials.json.example src/config/google-credentials.json

# Editar com suas credenciais reais
nano src/config/google-credentials.json
```

### 2. **Configurar produção** (Render):
```env
# No painel do Render, adicionar variável:
GOOGLE_SHEETS_CREDENTIALS={"type":"service_account","project_id":"SEU_PROJETO_ID","private_key_id":"SUA_PRIVATE_KEY_ID","private_key":"-----BEGIN PRIVATE KEY-----\nSUA_CHAVE_PRIVADA_COMPLETA_AQUI\n-----END PRIVATE KEY-----\n","client_email":"sua-conta-servico@projeto.iam.gserviceaccount.com","client_id":"SEU_CLIENT_ID","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","auth_provider_x509_cert_url":"https://www.googleapis.com/oauth2/v1/certs","client_x509_cert_url":"https://www.googleapis.com/robot/v1/metadata/x509/sua-conta-servico%40projeto.iam.gserviceaccount.com","universe_domain":"googleapis.com"}
```

## 🔍 Verificações de Segurança

### ✅ Checklist:
- [ ] Credenciais não estão no código
- [ ] Arquivo `google-credentials.json` está no `.gitignore`
- [ ] Variáveis de ambiente configuradas no Render
- [ ] Arquivo `.env` não está commitado

### 🚨 Se você commitou credenciais por engano:
1. **Revogue as credenciais** no Google Cloud Console
2. **Gere novas credenciais**
3. **Force push** para remover do histórico
4. **Configure as novas credenciais** no Render

## 📞 Suporte

Se tiver dúvidas sobre segurança, consulte a documentação ou entre em contato.

