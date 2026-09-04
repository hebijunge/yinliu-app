/* eslint-disable */
/**
 * 首页缓存 + 下拉刷新 端到端行为验证（无头 Chromium）
 * 场景1 缓存命中：写入 savedAt=now 的缓存 → 加载 → 列表为缓存数据 且 外部音源请求 = 0
 * 场景2 缓存过期：写入 savedAt=25h 前 → 加载 → 外部音源请求 > 0（重新拉网络）
 * 场景3 下拉刷新：命中缓存后模拟下拉手势 → 外部音源请求 > 0（强绕缓存）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIST = process.argv[2];
const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;
const CACHE_KEY = 'yinliu:home:hot-cache:v1';
const NEW_CACHE_KEY = 'yinliu:cc:home:hot:aggregated'; // v20 统一缓存层条目（迁移后生效）

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

function serve(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(DIST, p === '/' ? 'index.html' : p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(500); return res.end('err'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function fakeSong(i) {
  return {
    id: `cache-test-${i}`, title: `缓存测试歌曲${i}`, artist: `测试歌手${i}`, album: '测试专辑',
    coverUrl: '', duration: 180000, bitrate: 320, quality: 'standard',
    sourceId: 'kuwo', sourceSongId: `kw-${i}`,
    sources: [{ sourceId: 'kuwo', sourceName: '酷我', maxQuality: 'standard', available: true, sourceSongId: `kw-${i}` }],
  };
}

(async () => {
  const results = [];
  const server = http.createServer(serve).listen(PORT);
  const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/chromium-browser' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });

  async function openWithCache(savedAt) {
    const page = await ctx.newPage();
    let externalCount = 0;
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (!u.startsWith(BASE) && !u.startsWith('data:')) { externalCount++; return route.abort(); }
      return route.continue();
    });
    // 先开一次页面注入缓存，再刷新让首页走真实启动逻辑
    await page.goto(`${BASE}/#/`);
    if (savedAt === null) {
      await page.evaluate((k) => localStorage.removeItem(k), CACHE_KEY);
      await page.evaluate((k) => localStorage.removeItem(k), NEW_CACHE_KEY);
    } else {
      const songs = [fakeSong(1), fakeSong(2), fakeSong(3)];
      await page.evaluate(([k, payload]) => localStorage.setItem(k, JSON.stringify(payload)), [CACHE_KEY, { savedAt, songs }]);
      // 清掉新层条目，确保本场景走「旧键迁移」路径且不受上一场景迁移结果污染
      await page.evaluate((k) => localStorage.removeItem(k), NEW_CACHE_KEY);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    return { page, getExternal: () => externalCount };
  }

  // —— 场景1：缓存命中（24h 内）——
  {
    const { page, getExternal } = await openWithCache(Date.now());
    const body = await page.textContent('body');
    const hit = body.includes('缓存测试歌曲1') && body.includes('缓存测试歌曲3');
    const badge = body.includes('缓存 ·');
    results.push(['场景1 缓存命中: 列表来自缓存', hit]);
    results.push(['场景1 缓存命中: 显示缓存标记', badge]);
    results.push(['场景1 缓存命中: 零外部网络请求(24h内不重复拉取)', getExternal() === 0]);
    await page.close();
  }

  // —— 场景2：缓存过期（25h 前）→ 应重新拉网络 ——
  {
    const { page, getExternal } = await openWithCache(Date.now() - 25 * 3600 * 1000);
    const body = await page.textContent('body');
    // 外部源被 abort → 聚合失败 → 六源均不可用 → 回退旧缓存或空态，但必须已发起网络请求
    results.push(['场景2 缓存过期: 重新发起网络请求', getExternal() > 0]);
    results.push(['场景2 缓存过期: 失败时回退旧数据或空态而非报错白屏', body.includes('缓存测试歌曲1') || body.includes('暂无数据')]);
    await page.close();
  }

  // —— 场景3：下拉刷新强绕缓存 ——
  {
    const { page, getExternal } = await openWithCache(Date.now());
    const before = getExternal();
    // 找到首页内容容器（.max-w-4xl），模拟下拉触摸手势（先不松手）
    const gestureOk = await page.evaluate(() => {
      const el = document.querySelector('.max-w-4xl');
      if (!el || typeof Touch !== 'function' || typeof TouchEvent !== 'function') return false;
      const mkTouch = (y) => new Touch({ identifier: 1, target: el, clientX: 100, clientY: y });
      const fire = (type, y) => el.dispatchEvent(new TouchEvent(type, { touches: [mkTouch(y)], bubbles: true, cancelable: true }));
      fire('touchstart', 200);
      for (let y = 210; y <= 400; y += 40) { fire('touchmove', y); }
      return true;
    });
    await page.waitForTimeout(400);
    const indicatorShown = await page.evaluate(() =>
      document.body.innerText.includes('下拉刷新') || document.body.innerText.includes('松开刷新')
    );
    await page.evaluate(() => {
      const el = document.querySelector('.max-w-4xl');
      const mkTouch = (y) => new Touch({ identifier: 1, target: el, clientX: 100, clientY: y });
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(1500);
    const body = await page.textContent('body');
    results.push([`场景3 下拉手势: 触摸事件派发成功(${gestureOk})`, gestureOk]);
    results.push(['场景3 下拉手势: 下拉指示器出现', indicatorShown]);
    results.push(['场景3 下拉刷新: 强制发起网络请求(绕过缓存)', getExternal() > before]);
    await page.close();
  }

  await browser.close();
  server.close();
  let pass = 0;
  for (const [name, ok] of results) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} 项通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('脚本异常:', e); process.exit(2); });
