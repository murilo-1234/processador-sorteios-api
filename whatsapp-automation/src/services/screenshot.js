// src/services/screenshot.js
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const MEDIA_DIR = process.env.MEDIA_DIR || '/data/media';
fs.mkdirSync(MEDIA_DIR, { recursive: true });

/**
 * Tira screenshot de uma página e (opcionalmente) de um seletor específico.
 * @param {string} url - URL pública do resultado (ex: https://.../resultado/x18)
 * @param {object} opts
 * @param {string} [opts.selector] - CSS do container a recortar (ex: '#app main .card')
 * @param {string} [opts.viewport='720x1280'] - LarguraxAltura desejada do viewport
 * @param {number} [opts.pad=16] - padding extra em volta do seletor (px)
 * @returns {Promise<string>} caminho do PNG salvo
 */
async function screenshotResult(url, { selector, viewport = (process.env.SHOT_VIEWPORT || '720x1280'), pad = 16 } = {}) {
  const [vw, vh] = viewport.split('x').map(n => parseInt(n, 10));
  const outPath = path.join(MEDIA_DIR, `result_${Date.now()}.png`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: vw || 720, height: vh || 1280, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });

    // dá um tempinho para fontes/animar/medir
    await page.waitForTimeout(800);

    if (selector) {
      await page.waitForSelector(selector, { timeout: 10_000 });
      const el = await page.$(selector);
      const box = await el.boundingBox();

      if (!box) {
        // fallback: página inteira
        await page.screenshot({ path: outPath, fullPage: true, type: 'png' });
        return outPath;
      }

      const clip = {
        x: Math.max(0, box.x - pad),
        y: Math.max(0, box.y - pad),
        width: Math.min(vw, box.width + pad * 2),
        height: Math.min(vh * 3, box.height + pad * 2) // limita altura, mas deixa espaço
      };

      await page.screenshot({ path: outPath, clip, type: 'png' });
      return outPath;
    }

    // Sem seletor → tira da página inteira (já fica usável)
    await page.screenshot({ path: outPath, fullPage: true, type: 'png' });
    return outPath;
  } finally {
    await browser.close();
  }
}

module.exports = { screenshotResult };
