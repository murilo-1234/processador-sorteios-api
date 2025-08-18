#!/bin/bash

echo "🚀 Iniciando deploy otimizado do WhatsApp Automation..."

# Verificar Node.js
echo "📋 Verificando Node.js..."
node --version
npm --version

# Limpar cache npm
echo "🧹 Limpando cache npm..."
npm cache clean --force

# Instalar dependências com configurações otimizadas
echo "📦 Instalando dependências otimizadas..."
npm ci --only=production --no-audit --no-fund --prefer-offline

# Criar diretórios necessários
echo "📁 Criando diretórios..."
mkdir -p data logs public/images templates

# Executar migração do banco
echo "🗄️ Configurando banco de dados..."
npm run migrate

echo "✅ Deploy otimizado concluído!"

