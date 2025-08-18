#!/bin/bash

# Script de deploy para Render.com
# Este script será executado automaticamente pelo Render durante o deploy

set -e

echo "🚀 Iniciando deploy do WhatsApp Automation..."

# 1. Instalar dependências
echo "📦 Instalando dependências..."
npm install --legacy-peer-deps --production

# 2. Criar diretórios necessários
echo "📁 Criando diretórios..."
mkdir -p data/images
mkdir -p data/whatsapp-session
mkdir -p logs

# 3. Configurar permissões
echo "🔐 Configurando permissões..."
chmod -R 755 data/
chmod -R 755 logs/

# 4. Verificar variáveis de ambiente obrigatórias
echo "🔍 Verificando configurações..."

required_vars=(
    "GOOGLE_SHEETS_ID"
    "JWT_SECRET"
    "ADMIN_PASSWORD"
)

for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        echo "❌ Variável de ambiente obrigatória não configurada: $var"
        exit 1
    fi
done

# 5. Executar migrações do banco
echo "🗄️ Executando migrações do banco..."
node src/scripts/migrate.js

# 6. Verificar integridade do sistema
echo "🔧 Verificando integridade..."
node -e "
const fs = require('fs');
const path = require('path');

// Verificar arquivos essenciais
const essentialFiles = [
    'src/app.js',
    'src/config/database.js',
    'src/services/whatsapp-client.js',
    'src/modules/sorteios.js'
];

for (const file of essentialFiles) {
    if (!fs.existsSync(file)) {
        console.error('❌ Arquivo essencial não encontrado:', file);
        process.exit(1);
    }
}

console.log('✅ Verificação de integridade concluída');
"

echo "✅ Deploy concluído com sucesso!"
echo "🌐 Aplicação pronta para iniciar"

# Informações importantes para o log
echo ""
echo "📋 INFORMAÇÕES IMPORTANTES:"
echo "- Porta: ${PORT:-3000}"
echo "- Ambiente: ${NODE_ENV:-production}"
echo "- Health Check: /health"
echo "- Métricas: /metrics"
echo "- Admin: /admin/login"
echo ""
echo "🔗 Para conectar o WhatsApp:"
echo "1. Acesse os logs da aplicação"
echo "2. Escaneie o QR Code que aparecerá"
echo "3. Aguarde a confirmação de conexão"
echo ""
echo "⚠️  LEMBRE-SE:"
echo "- Configure as variáveis de ambiente no painel do Render"
echo "- Adicione o ID da planilha Google Sheets"
echo "- Configure alertas por email/Telegram (opcional)"
echo ""

