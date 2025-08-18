const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const logger = require('../config/logger');

class ImageGeneratorService {
  constructor() {
    this.outputDir = './data/images';
    this.templateDir = './src/templates';
    this.browser = null;
    
    // Garantir que os diretórios existem
    this.ensureDirectories();
  }

  /**
   * Garantir que os diretórios necessários existem
   */
  ensureDirectories() {
    [this.outputDir, this.templateDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  /**
   * Inicializar browser Puppeteer
   */
  async initializeBrowser() {
    if (this.browser) {
      return this.browser;
    }

    this.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    });

    return this.browser;
  }

  /**
   * Gerar imagem de resultado de sorteio
   */
  async gerarImagemSorteio(dadosSorteio) {
    try {
      logger.info(`🎨 Gerando imagem para sorteio ${dadosSorteio.codigo}...`);

      const browser = await this.initializeBrowser();
      const page = await browser.newPage();
      
      await page.setViewport({ width: 800, height: 600 });

      const templateHtml = this.criarTemplateSorteio(dadosSorteio);
      await page.setContent(templateHtml, { waitUntil: 'networkidle0' });

      const outputPath = path.join(this.outputDir, `sorteio-${dadosSorteio.codigo}-${Date.now()}.png`);
      
      await page.screenshot({
        path: outputPath,
        type: 'png',
        fullPage: true
      });

      await page.close();

      logger.info(`✅ Imagem gerada: ${outputPath}`);
      return outputPath;

    } catch (error) {
      logger.error(`❌ Erro ao gerar imagem para sorteio ${dadosSorteio.codigo}:`, error);
      throw error;
    }
  }

  /**
   * Criar template HTML para sorteio
   */
  criarTemplateSorteio(dados) {
    const {
      codigo,
      premio,
      ganhador,
      dataRealizacao,
      horaRealizacao,
      totalParticipantes
    } = dados;

    return `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Resultado do Sorteio</title>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;700;900&display=swap');
            
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            
            body {
                font-family: 'Roboto', sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                width: 800px;
                height: 600px;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
            }
            
            .container {
                background: white;
                border-radius: 20px;
                padding: 40px;
                box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                text-align: center;
                width: 100%;
                max-width: 700px;
                position: relative;
                overflow: hidden;
            }
            
            .container::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                height: 8px;
                background: linear-gradient(90deg, #ff6b6b, #4ecdc4, #45b7d1, #96ceb4, #feca57);
            }
            
            .header {
                margin-bottom: 30px;
            }
            
            .titulo {
                font-size: 28px;
                font-weight: 700;
                color: #2c3e50;
                margin-bottom: 10px;
                text-transform: uppercase;
                letter-spacing: 1px;
            }
            
            .data-info {
                font-size: 16px;
                color: #7f8c8d;
                margin-bottom: 20px;
            }
            
            .premio-section {
                background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
                border-radius: 15px;
                padding: 25px;
                margin: 30px 0;
                color: white;
            }
            
            .premio-label {
                font-size: 18px;
                font-weight: 400;
                margin-bottom: 10px;
                opacity: 0.9;
            }
            
            .premio-nome {
                font-size: 24px;
                font-weight: 700;
                line-height: 1.3;
            }
            
            .ganhador-section {
                background: linear-gradient(135deg, #a8edea 0%, #fed6e3 100%);
                border-radius: 15px;
                padding: 30px;
                margin: 30px 0;
                position: relative;
            }
            
            .ganhador-section::before {
                content: '🎉';
                position: absolute;
                top: -10px;
                left: 50%;
                transform: translateX(-50%);
                font-size: 40px;
                background: white;
                border-radius: 50%;
                width: 60px;
                height: 60px;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 5px 15px rgba(0,0,0,0.1);
            }
            
            .ganhador-label {
                font-size: 20px;
                font-weight: 700;
                color: #2c3e50;
                margin-bottom: 15px;
                margin-top: 10px;
            }
            
            .ganhador-nome {
                font-size: 32px;
                font-weight: 900;
                color: #e74c3c;
                text-transform: uppercase;
                letter-spacing: 2px;
                text-shadow: 2px 2px 4px rgba(0,0,0,0.1);
            }
            
            .stats {
                display: flex;
                justify-content: space-around;
                margin-top: 30px;
                padding-top: 20px;
                border-top: 2px solid #ecf0f1;
            }
            
            .stat-item {
                text-align: center;
            }
            
            .stat-number {
                font-size: 24px;
                font-weight: 700;
                color: #3498db;
                display: block;
            }
            
            .stat-label {
                font-size: 14px;
                color: #7f8c8d;
                margin-top: 5px;
            }
            
            .footer {
                margin-top: 30px;
                padding-top: 20px;
                border-top: 1px solid #ecf0f1;
                font-size: 14px;
                color: #95a5a6;
            }
            
            .transparency-badge {
                background: #27ae60;
                color: white;
                padding: 8px 16px;
                border-radius: 20px;
                font-size: 12px;
                font-weight: 700;
                display: inline-block;
                margin-top: 10px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div class="titulo">${premio}</div>
                <div class="data-info">
                    📅 ${dataRealizacao || 'Data não informada'} 
                    ${horaRealizacao ? `⏰ ${horaRealizacao}` : ''}
                </div>
            </div>
            
            <div class="premio-section">
                <div class="premio-label">🎁 Ganhe esse Top!</div>
                <div class="premio-nome">${premio}</div>
                <div style="margin-top: 15px; font-size: 18px; font-weight: 500;">
                    Sorteio
                </div>
            </div>
            
            <div class="ganhador-section">
                <div class="ganhador-label">👑 GANHADOR DO SORTEIO!</div>
                <div class="ganhador-nome">${ganhador}</div>
            </div>
            
            <div class="stats">
                <div class="stat-item">
                    <span class="stat-number">${totalParticipantes || '---'}</span>
                    <div class="stat-label">Participantes</div>
                </div>
                <div class="stat-item">
                    <span class="stat-number">1</span>
                    <div class="stat-label">Ganhador</div>
                </div>
                <div class="stat-item">
                    <span class="stat-number">100%</span>
                    <div class="stat-label">Transparência</div>
                </div>
            </div>
            
            <div class="footer">
                <div class="transparency-badge">✅ 100% Transparência</div>
                <div style="margin-top: 10px;">
                    Código do Sorteio: ${codigo}
                </div>
            </div>
        </div>
    </body>
    </html>
    `;
  }

  /**
   * Gerar imagem de template personalizado
   */
  async gerarImagemCustom(templateHtml, outputFileName) {
    try {
      const browser = await this.initializeBrowser();
      const page = await browser.newPage();
      
      await page.setViewport({ width: 800, height: 600 });
      await page.setContent(templateHtml, { waitUntil: 'networkidle0' });

      const outputPath = path.join(this.outputDir, outputFileName);
      
      await page.screenshot({
        path: outputPath,
        type: 'png',
        fullPage: true
      });

      await page.close();

      logger.info(`✅ Imagem customizada gerada: ${outputPath}`);
      return outputPath;

    } catch (error) {
      logger.error('❌ Erro ao gerar imagem customizada:', error);
      throw error;
    }
  }

  /**
   * Gerar múltiplas imagens
   */
  async gerarMultiplasImagens(dadosSorteios) {
    const resultados = [];
    const erros = [];

    logger.info(`🎨 Gerando ${dadosSorteios.length} imagens...`);

    for (const dados of dadosSorteios) {
      try {
        const imagePath = await this.gerarImagemSorteio(dados);
        resultados.push({
          codigo: dados.codigo,
          imagePath: imagePath
        });
      } catch (error) {
        erros.push({
          codigo: dados.codigo,
          erro: error.message
        });
      }
    }

    logger.info(`✅ Geração concluída: ${resultados.length} sucessos, ${erros.length} erros`);

    return {
      sucessos: resultados,
      erros: erros,
      total: dadosSorteios.length
    };
  }

  /**
   * Limpar imagens antigas
   */
  async limparImagensAntigas(diasParaManter = 7) {
    try {
      const agora = Date.now();
      const milissegundosParaManter = diasParaManter * 24 * 60 * 60 * 1000;

      const arquivos = fs.readdirSync(this.outputDir);
      let removidos = 0;

      for (const arquivo of arquivos) {
        const caminhoCompleto = path.join(this.outputDir, arquivo);
        const stats = fs.statSync(caminhoCompleto);

        if (agora - stats.mtime.getTime() > milissegundosParaManter) {
          fs.unlinkSync(caminhoCompleto);
          removidos++;
        }
      }

      logger.info(`🧹 ${removidos} imagens antigas removidas`);
      return removidos;

    } catch (error) {
      logger.error('❌ Erro ao limpar imagens antigas:', error);
      throw error;
    }
  }

  /**
   * Obter estatísticas de imagens
   */
  getEstatisticas() {
    try {
      const arquivos = fs.readdirSync(this.outputDir);
      const totalArquivos = arquivos.length;
      
      let tamanhoTotal = 0;
      arquivos.forEach(arquivo => {
        const stats = fs.statSync(path.join(this.outputDir, arquivo));
        tamanhoTotal += stats.size;
      });

      return {
        totalImagens: totalArquivos,
        tamanhoTotalMB: (tamanhoTotal / (1024 * 1024)).toFixed(2),
        diretorio: this.outputDir
      };

    } catch (error) {
      logger.error('❌ Erro ao obter estatísticas:', error);
      return {
        totalImagens: 0,
        tamanhoTotalMB: 0,
        diretorio: this.outputDir,
        erro: error.message
      };
    }
  }

  /**
   * Verificar se uma imagem existe
   */
  imagemExiste(imagePath) {
    return fs.existsSync(imagePath);
  }

  /**
   * Health check do serviço
   */
  async healthCheck() {
    try {
      // Testar geração de imagem simples
      const testHtml = `
        <html>
          <body style="width: 400px; height: 200px; background: #f0f0f0; display: flex; align-items: center; justify-content: center;">
            <h1>Test Image</h1>
          </body>
        </html>
      `;

      const testPath = path.join(this.outputDir, 'health-check-test.png');
      
      const browser = await this.initializeBrowser();
      const page = await browser.newPage();
      
      await page.setViewport({ width: 400, height: 200 });
      await page.setContent(testHtml);
      
      await page.screenshot({
        path: testPath,
        type: 'png'
      });

      await page.close();

      // Remover arquivo de teste
      if (fs.existsSync(testPath)) {
        fs.unlinkSync(testPath);
      }

      return {
        status: 'ok',
        outputDir: this.outputDir,
        canGenerate: true,
        browserInitialized: !!this.browser
      };

    } catch (error) {
      return {
        status: 'error',
        message: error.message,
        outputDir: this.outputDir,
        canGenerate: false,
        browserInitialized: !!this.browser
      };
    }
  }

  /**
   * Fechar browser
   */
  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      logger.info('🔒 Browser Puppeteer fechado');
    }
  }
}

module.exports = ImageGeneratorService;

