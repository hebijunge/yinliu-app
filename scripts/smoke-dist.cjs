// v20 出包前冒烟：本地静态服务 + Chromium 打开 dist，断言页面渲染、无裸模块导入报错
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'dist');
const PORT = 8971;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  let f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(ROOT, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  const rootLen = await page.evaluate(() => (document.getElementById('root')?.innerHTML || '').length);
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 120));
  const hasBareImportError = errors.some((e) => /Cannot use import statement|bare|Failed to fetch dynamically|does not provide an export/.test(e));
  console.log(JSON.stringify({ rootLen, bodyText: bodyText.replace(/\n/g, ' | '), errorCount: errors.length, hasBareImportError, sampleErrors: errors.slice(0, 5) }, null, 1));
  await browser.close();
  server.close();
  if (rootLen < 500 || hasBareImportError) { console.log('SMOKE FAIL'); process.exit(1); }
  console.log('SMOKE PASS');
  process.exit(0);
})();
