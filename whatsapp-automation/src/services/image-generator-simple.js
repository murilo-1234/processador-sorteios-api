const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');

class SimpleImageGenerator {
  constructor() {
    this.templatePath = path.join(__dirname, '../../templates');
    this.outputPath = path.join(__dirname, '../../public/images');
    
    // Criar diretórios se não existirem
    if (!fs.existsSync(this.templatePath)) {
      fs.mkdirSync(this.templatePath, { recursive: true });
    }
    if (!fs.existsSync(this.outputPath)) {
      fs.mkdirSync(this.outputPath, { recursive: true });
    }
  }

  /**
   * Gera imagem simples usando HTML/CSS (sem Puppeteer)
   */
  async gerarImagemSorteio(dadosSorteio) {
    try {
      logger.info(`🎨 Gerando imagem para sorteio ${dadosSorteio.codigo}`);

      // Por enquanto, vamos criar um HTML simples que pode ser convertido depois
      const htmlContent = this.criarHTMLSorteio(dadosSorteio);
      
      // Salvar HTML temporário
      const htmlPath = path.join(this.outputPath, `${dadosSorteio.codigo}.html`);
      fs.writeFileSync(htmlPath, htmlContent);

      // Para esta versão simplificada, vamos usar uma imagem placeholder
      const imagePath = await this.criarImagemPlaceholder(dadosSorteio);

      logger.info(`✅ Imagem gerada: ${imagePath}`);
      return imagePath;

    } catch (error) {
      logger.error(`❌ Erro ao gerar imagem: ${error.message}`);
      throw error;
    }
  }

  /**
   * Cria HTML para o sorteio
   */
  criarHTMLSorteio(dados) {
    return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Resultado Sorteio ${dados.codigo}</title>
    <style>
        body {
            font-family: 'Arial', sans-serif;
            margin: 0;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-align: center;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            background: rgba(255,255,255,0.1);
            border-radius: 20px;
            padding: 40px;
            backdrop-filter: blur(10px);
        }
        .titulo {
            font-size: 2.5em;
            font-weight: bold;
            margin-bottom: 20px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }
        .codigo {
            font-size: 1.5em;
            background: rgba(255,255,255,0.2);
            padding: 10px 20px;
            border-radius: 10px;
            margin-bottom: 30px;
        }
        .ganhador {
            font-size: 2em;
            font-weight: bold;
            background: linear-gradient(45deg, #FFD700, #FFA500);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin: 20px 0;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }
        .premio {
            font-size: 1.3em;
            margin: 20px 0;
            opacity: 0.9;
        }
        .data {
            font-size: 1em;
            opacity: 0.8;
            margin-top: 30px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="titulo">🎉 RESULTADO DO SORTEIO 🎉</div>
        <div class="codigo">Código: ${dados.codigo}</div>
        <div class="ganhador">${dados.ganhador || 'Ganhador não informado'}</div>
        <div class="premio">Prêmio: ${dados.premio || 'Prêmio especial'}</div>
        <div class="data">Data: ${dados.data || new Date().toLocaleDateString('pt-BR')}</div>
    </div>
</body>
</html>`;
  }

  /**
   * Cria uma imagem placeholder simples
   */
  async criarImagemPlaceholder(dados) {
    try {
      // Criar um SVG simples como placeholder
      const svgContent = `
<svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#667eea;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#764ba2;stop-opacity:1" />
    </linearGradient>
  </defs>
  
  <rect width="800" height="600" fill="url(#bg)"/>
  
  <rect x="50" y="50" width="700" height="500" fill="rgba(255,255,255,0.1)" rx="20"/>
  
  <text x="400" y="150" font-family="Arial, sans-serif" font-size="48" font-weight="bold" 
        text-anchor="middle" fill="white">🎉 RESULTADO DO SORTEIO 🎉</text>
  
  <rect x="300" y="180" width="200" height="50" fill="rgba(255,255,255,0.2)" rx="10"/>
  <text x="400" y="210" font-family="Arial, sans-serif" font-size="24" 
        text-anchor="middle" fill="white">Código: ${dados.codigo}</text>
  
  <text x="400" y="300" font-family="Arial, sans-serif" font-size="36" font-weight="bold" 
        text-anchor="middle" fill="#FFD700">${dados.ganhador || 'Ganhador não informado'}</text>
  
  <text x="400" y="350" font-family="Arial, sans-serif" font-size="24" 
        text-anchor="middle" fill="white">Prêmio: ${dados.premio || 'Prêmio especial'}</text>
  
  <text x="400" y="450" font-family="Arial, sans-serif" font-size="18" 
        text-anchor="middle" fill="rgba(255,255,255,0.8)">Data: ${dados.data || new Date().toLocaleDateString('pt-BR')}</text>
</svg>`;

      const svgPath = path.join(this.outputPath, `${dados.codigo}.svg`);
      fs.writeFileSync(svgPath, svgContent);

      return svgPath;

    } catch (error) {
      logger.error(`❌ Erro ao criar placeholder: ${error.message}`);
      throw error;
    }
  }

  /**
   * Health check do serviço
   */
  async healthCheck() {
    try {
      // Verificar se diretórios existem
      const templateExists = fs.existsSync(this.templatePath);
      const outputExists = fs.existsSync(this.outputPath);

      return {
        status: 'healthy',
        templateDir: templateExists,
        outputDir: outputExists,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

module.exports = SimpleImageGenerator;

