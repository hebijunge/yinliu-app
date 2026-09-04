/* eslint-disable */
/**
 * 缓存优化 v20 端到端行为验证（无头 Chromium，跑在 vite build 产物上）
 * 场景A 新鲜缓存命中：24h 内 → 列表来自缓存、零外部请求
 * 场景B 过期秒开+后台静默刷新：过期缓存立即渲染，后台拉新成功后无感更新、标注消失
 * 场景C 刷新失败保旧：后台拉新失败 → 旧列表与旧标注保持不变
 * 场景D 版本号作废：条目版本号不匹配 → 视为无缓存重拉，新条目写入正确版本
 * 场景E 启动预热：无缓存直接进曲库页 → 首页缓存仍被后台预热写入
 * 场景F 断网兜底：离线 + 过期缓存 → 直接展示缓存并标注「当前离线」，不发请求
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIST = process.argv[2];
const PORT = 4598;
const BASE = `http://127.0.0.1:${PORT}`;
const ENTRY_KEY = 'yinliu:cc:home:hot:aggregated';
const KUWO_CHART = '**/kbangserver.kuwo.cn/**';

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
const seedEnvelope = (savedAt, v = 1) => ({ v, savedAt, data: [fakeSong(1), fakeSong(2), fakeSong(3)] });

// 酷我榜单接口的成功响应（KuwoSource.getChartDetail 可解析的 musiclist 结构）
const KUWO_FRESH_BODY = JSON.stringify({
  musiclist: [
    { id: 'm1', name: '云端新歌A', artist: '新歌手A', album: '新专辑A', duration: 200 },
    { id: 'm2', name: '云端新歌B', artist: '新歌手B', album: '新专辑B', duration: 210 },
  ],
});

(async () => {
  const results = [];
  const check = (name, ok) => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };
  const server = http.createServer(serve).listen(PORT);
  const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/chromium-browser' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });

  /**
   * 打开页面：先空加载一次注入缓存，再 reload 走真实启动逻辑。
   * opts.kuwoDelayMs>0 时酷我榜单接口延迟返回成功响应；否则 abort（拉新失败）。
   */
  async function openWithCache(savedAt, entryVersion = 1, opts = {}) {
    const page = await ctx.newPage();
    let externalCount = 0;
    let kuwoMockCount = 0;
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(BASE) || u.startsWith('data:')) return route.continue();
      externalCount++;
      if (route.request().url().includes('kbangserver.kuwo.cn')) {
        if (opts.kuwoDelayMs > 0) {
          kuwoMockCount++;
          return setTimeout(() => route.fulfill({ status: 200, contentType: 'application/json', body: KUWO_FRESH_BODY }), opts.kuwoDelayMs);
        }
        if (opts.mockKuwoSuccess) {
          kuwoMockCount++;
          return route.fulfill({ status: 200, contentType: 'application/json', body: KUWO_FRESH_BODY });
        }
      }
      return route.abort();
    });
    await page.goto(`${BASE}/#/`);
    if (savedAt === null) {
      await page.evaluate((k) => localStorage.removeItem(k), ENTRY_KEY);
    } else {
      await page.evaluate(([k, payload]) => localStorage.setItem(k, JSON.stringify(payload)), [ENTRY_KEY, seedEnvelope(savedAt, entryVersion)]);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1700); // 越过启动加载页（1.4s），首页必已渲染
    return { page, getExternal: () => externalCount, getKuwoMock: () => kuwoMockCount };
  }

  const readEntry = (page) =>
    page.evaluate((k) => {
      const raw = localStorage.getItem(k);
      if (!raw) return null;
      try { const p = JSON.parse(raw); return { v: p.v, savedAt: p.savedAt, len: Array.isArray(p.data) ? p.data.length : -1 }; } catch { return null; }
    }, ENTRY_KEY);

  // —— 场景A：新鲜缓存命中 ——
  {
    const { page, getExternal } = await openWithCache(Date.now());
    const body = await page.textContent('body');
    check('A1 命中: 列表来自缓存', body.includes('缓存测试歌曲1') && body.includes('缓存测试歌曲3'));
    check('A2 命中: 显示缓存标注', body.includes('缓存 ·'));
    check('A3 命中: 零外部请求(24h内不拉网络)', getExternal() === 0);
    await page.close();
  }

  // —— 场景B：过期秒开 + 后台静默刷新成功 ——
  {
    const { page, getExternal, getKuwoMock } = await openWithCache(Date.now() - 25 * 3600 * 1000, 1, { kuwoDelayMs: 2500 });
    const earlyBody = await page.textContent('body');
    check('B1 过期秒开: 先立即渲染旧缓存(不等网络)', earlyBody.includes('缓存测试歌曲1') && earlyBody.includes('缓存测试歌曲3'));
    check('B2 过期秒开: 旧数据带缓存标注', earlyBody.includes('缓存 ·'));
    check('B3 后台拉新: 已发起网络请求', getExternal() > 0 && getKuwoMock() === 1);
    await page.waitForTimeout(3500); // 等延迟的 mock 响应到达并完成无感刷新
    const laterBody = await page.textContent('body');
    check('B4 静默更新成功: 列表无感刷新为新数据', laterBody.includes('云端新歌A') && laterBody.includes('云端新歌B'));
    check('B5 静默更新成功: 缓存标注消失(时间戳已重置)', !laterBody.includes('缓存 ·'));
    const entry = await readEntry(page);
    check('B6 静默更新成功: 新结果已写入缓存', !!entry && entry.v === 1 && entry.len === 2 && Date.now() - entry.savedAt < 20000);
    await page.close();
  }

  // —— 场景C：后台刷新失败保旧 ——
  {
    const { page } = await openWithCache(Date.now() - 25 * 3600 * 1000, 1, {}); // 酷我接口 abort → 聚合失败
    await page.waitForTimeout(2500);
    const body = await page.textContent('body');
    check('C1 拉新失败: 旧列表保持不变', body.includes('缓存测试歌曲1') && body.includes('缓存测试歌曲3'));
    check('C2 拉新失败: 旧缓存标注保持', body.includes('缓存 ·'));
    const entry = await readEntry(page);
    check('C3 拉新失败: 旧缓存未被覆盖', !!entry && body.includes('缓存测试歌曲') && entry.len === 3);
    await page.close();
  }

  // —— 场景D：版本号不匹配作废重拉 ——
  {
    const { page, getKuwoMock } = await openWithCache(Date.now(), 999, { mockKuwoSuccess: true });
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    check('D1 版本不符: 旧结构缓存被作废并重新拉取', getKuwoMock() >= 1 && !body.includes('缓存测试歌曲1'));
    const entry = await readEntry(page);
    check('D2 版本不符: 重拉后写入正确版本号的缓存', !!entry && entry.v === 1);
    await page.close();
  }

  // —— 场景E：启动预热（不进首页） ——
  {
    const { page } = await openWithCache(null, 1, { mockKuwoSuccess: true });
    // 直接进曲库页，停留观察首页缓存是否被启动预热写入
    await page.goto(`${BASE}/#/library`);
    await page.waitForTimeout(4000);
    const entry = await readEntry(page);
    check('E1 启动预热: 未进首页缓存也被提前拉取写入', !!entry && entry.v === 1 && entry.len === 2);
    await page.close();
  }

  // —— 场景F：断网兜底 ——
  {
    const page = await ctx.newPage();
    let externalCount = 0;
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
    });
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (!u.startsWith(BASE) && !u.startsWith('data:')) { externalCount++; return route.abort(); }
      return route.continue();
    });
    await page.goto(`${BASE}/#/`);
    await page.evaluate(([k, payload]) => localStorage.setItem(k, JSON.stringify(payload)), [ENTRY_KEY, seedEnvelope(Date.now() - 25 * 3600 * 1000)]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1700);
    const body = await page.textContent('body');
    check('F1 断网: 直接用缓存展示列表', body.includes('缓存测试歌曲1') && body.includes('缓存测试歌曲3'));
    check('F2 断网: 顶部显示离线标注', body.includes('当前离线，展示') && body.includes('的数据'));
    check('F3 断网: 不发起任何外部请求', externalCount === 0);
    await page.close();
  }

  await browser.close();
  server.close();
  const pass = results.filter((r) => r[1]).length;
  console.log(`\n${pass}/${results.length} 项通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('脚本异常:', e); process.exit(2); });
