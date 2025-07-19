#!/bin/bash

# Script de Deploy para Render.com
# Processador de Sorteios API v1.0

echo "🚀 PREPARANDO DEPLOY PARA RENDER.COM"
echo "===================================="

# Verificar arquivos essenciais
echo "📋 Verificando arquivos essenciais..."

files=(
    "src/main.py"
    "src/routes/sorteios.py"
    "src/processador_sorteio_v4_ajustado.py"
    "src/lithe-augury-466402-k6-52759a6c850c.json"
    "requirements.txt"
    "Procfile"
    "render.yaml"
    "README.md"
)

for file in "${files[@]}"; do
    if [ -f "$file" ]; then
        echo "✅ $file"
    else
        echo "❌ $file - ARQUIVO FALTANDO!"
        exit 1
    fi
done

# Verificar dependências
echo ""
echo "📦 Verificando dependências..."
if grep -q "gspread" requirements.txt && grep -q "flask" requirements.txt; then
    echo "✅ Dependências principais encontradas"
else
    echo "❌ Dependências faltando!"
    exit 1
fi

# Verificar configuração Flask
echo ""
echo "🔧 Verificando configuração Flask..."
if grep -q "host='0.0.0.0'" src/main.py; then
    echo "✅ Servidor configurado para 0.0.0.0"
else
    echo "❌ Servidor não configurado corretamente!"
    exit 1
fi

if grep -q "CORS(app)" src/main.py; then
    echo "✅ CORS habilitado"
else
    echo "❌ CORS não habilitado!"
    exit 1
fi

# Verificar rotas
echo ""
echo "🛣️ Verificando rotas..."
if grep -q "/api/sorteios" src/main.py; then
    echo "✅ Rotas de sorteios registradas"
else
    echo "❌ Rotas não registradas!"
    exit 1
fi

echo ""
echo "✅ TODOS OS ARQUIVOS VERIFICADOS COM SUCESSO!"
echo ""
echo "🎯 PRÓXIMOS PASSOS PARA DEPLOY:"
echo "1. Faça upload de todos os arquivos para um repositório Git"
echo "2. Acesse render.com e crie um novo Web Service"
echo "3. Conecte seu repositório"
echo "4. Configure:"
echo "   - Build Command: pip install -r requirements.txt"
echo "   - Start Command: python src/main.py"
echo "   - Environment: Python 3"
echo "5. Adicione variável de ambiente FLASK_ENV=production"
echo "6. Deploy!"
echo ""
echo "🔗 URL de teste após deploy: https://seu-app.onrender.com/api/sorteios/health"
echo ""
echo "🎉 SISTEMA PRONTO PARA DEPLOY!"

