#!/bin/bash

echo "🚀 Iniciando setup do sistema no Render.com..."

# Atualiza sistema
echo "📦 Atualizando sistema..."
apt-get update -y

# Instala dependências do sistema
echo "🔧 Instalando dependências do sistema..."
apt-get install -y wget gnupg unzip curl

# Adiciona repositório do Google Chrome
echo "🌐 Configurando repositório Google Chrome..."
wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list

# Atualiza lista de pacotes
apt-get update -y

# Instala Google Chrome
echo "🌐 Instalando Google Chrome..."
apt-get install -y google-chrome-stable

# Verifica versão do Chrome
CHROME_VERSION=$(google-chrome --version | awk '{print $3}' | cut -d. -f1)
echo "✅ Chrome instalado: versão $CHROME_VERSION"

# Instala ChromeDriver compatível
echo "🚗 Instalando ChromeDriver..."
CHROMEDRIVER_VERSION=$(curl -sS chromedriver.storage.googleapis.com/LATEST_RELEASE_$CHROME_VERSION)
echo "📥 Baixando ChromeDriver versão $CHROMEDRIVER_VERSION..."

wget -O /tmp/chromedriver.zip "https://chromedriver.storage.googleapis.com/$CHROMEDRIVER_VERSION/chromedriver_linux64.zip"
unzip /tmp/chromedriver.zip chromedriver -d /usr/local/bin/
chmod +x /usr/local/bin/chromedriver

# Verifica instalação do ChromeDriver
echo "✅ ChromeDriver instalado: $(chromedriver --version)"

# Cria diretórios necessários
echo "📁 Criando diretórios..."
mkdir -p /tmp/chrome-user-data
chmod 755 /tmp/chrome-user-data

# Instala dependências Python
echo "🐍 Instalando dependências Python..."
pip install --upgrade pip
pip install -r requirements_final.txt

# Configura variáveis de ambiente para Selenium
export DISPLAY=:99
export CHROME_BIN=/usr/bin/google-chrome
export CHROMEDRIVER_PATH=/usr/local/bin/chromedriver

echo "✅ Setup concluído com sucesso!"
echo "🔍 Verificando instalações..."
echo "  - Python: $(python --version)"
echo "  - Chrome: $(google-chrome --version)"
echo "  - ChromeDriver: $(chromedriver --version)"
echo "  - Flask: $(python -c 'import flask; print(flask.__version__)')"
echo "  - Selenium: $(python -c 'import selenium; print(selenium.__version__)')"

echo "🎯 Sistema pronto para execução!"

