/* eslint-disable */
/**
 * 统一缓存层 cacheStore 单元验证（Node，esbuild 打包后直接跑）。
 * 覆盖：读写往返、版本号作废、损坏数据容错、容量上限 LRU 淘汰、配额不足淘汰重试、命名空间清理。
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname + '/..';
const OUT = path.join(ROOT, '.tmp-cache-store.cjs');
execSync('npx esbuild src/core/cacheStore.ts --bundle --format=cjs --outfile=' + OUT, {
  cwd: ROOT, stdio: 'pipe',
});

// —— localStorage 垫片（带总量配额，模拟真实配额不足）——
const store = new Map();
let QUOTA_BYTES = Infinity;
const byteLen = (s) => Buffer.byteLength(s, 'utf8');
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => {
    const s = String(v);
    let total = byteLen(s);
    for (const val of store.values()) total += byteLen(val);
    if (total > QUOTA_BYTES) {
      const e = new Error('localStorage 配额不足');
      e.name = 'QuotaExceededError';
      throw e;
    }
    store.set(k, s);
  },
  removeItem: (k) => store.delete(k),
  key: (i) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size; },
};

const cs = require(OUT);

const results = [];
const check = (name, ok) => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };
const mkBig = (n) => 'x'.repeat(n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. 读写往返
  {
    store.clear(); QUOTA_BYTES = Infinity;
    cs.cacheSet('ns1', 'k1', 1, { hello: 'world' });
    const hit = cs.cacheGet('ns1', 'k1', 1);
    check('cacheSet/cacheGet 读写往返', !!hit && hit.data.hello === 'world' && typeof hit.savedAt === 'number');
  }

  // 2. 版本号不匹配 → 作废删除、返回 null
  {
    store.clear(); QUOTA_BYTES = Infinity;
    cs.cacheSet('ns1', 'k1', 1, { hello: 'world' });
    const miss = cs.cacheGet('ns1', 'k1', 2); // 业务侧升级到 v2
    const gone = !store.has('yinliu:cc:ns1:k1');
    check('版本号升级后旧缓存作废(返回null并删除)', miss === null && gone);
  }

  // 3. 损坏数据容错
  {
    store.clear(); QUOTA_BYTES = Infinity;
    store.set('yinliu:cc:ns1:bad', '{not-json');
    const miss = cs.cacheGet('ns1', 'bad', 1);
    check('损坏数据视为无缓存并清理', miss === null && !store.has('yinliu:cc:ns1:bad'));
  }

  // 4. 容量上限 + LRU 淘汰（最久未用先出）
  {
    store.clear();
    cs.setCacheTotalLimit(4000); // 4KB 上限
    const big = { pad: mkBig(1600) }; // 序列化后约 1.6KB，三条必超 4KB 上限
    await wait(3); // 拉开 lastUsedAt 毫秒差
    cs.cacheSet('t', 'a', 1, big); await wait(3);
    cs.cacheSet('t', 'b', 1, big); await wait(3);
    cs.cacheGet('t', 'a', 1); await wait(3); // touch a → a 比 b 新
    cs.cacheSet('t', 'c', 1, big); // 超限 → 淘汰最久未用的 b
    const a = cs.cacheGet('t', 'a', 1);
    const b = cs.cacheGet('t', 'b', 1);
    const c = cs.cacheGet('t', 'c', 1);
    const stats = cs.cacheStats();
    check('容量超限触发 LRU 淘汰(最久未用的b被淘汰,a/c保留)', !!a && b === null && !!c);
    check('淘汰后总量不超上限', stats.totalBytes <= stats.limitBytes);
    cs.setCacheTotalLimit(cs.DEFAULT_CACHE_TOTAL_LIMIT_BYTES); // 还原默认 20MB
  }

  // 5. 平台配额不足 → 淘汰后重试写入成功
  {
    store.clear();
    QUOTA_BYTES = 6000; // 平台真实配额：6KB
    const big = { pad: mkBig(1500) };
    let allOk = true;
    for (let i = 0; i < 5; i++) {
      allOk = allOk && cs.cacheSet('q', 'k' + i, 1, big);
      await wait(2);
    }
    const alive = [...store.keys()].filter((k) => k.startsWith('yinliu:cc:q:'));
    const totalBytes = alive.reduce((s, k) => s + byteLen(store.get(k)), 0);
    check('配额不足时自动淘汰最旧条目并写入成功', allOk && alive.length > 0 && alive.length < 5);
    check('配额淘汰后实际占用不超平台配额', totalBytes <= QUOTA_BYTES);
    QUOTA_BYTES = Infinity;
  }

  // 6. clearNamespace
  {
    store.clear();
    cs.cacheSet('cn', 'x', 1, { a: 1 });
    cs.cacheSet('cn', 'y', 1, { a: 2 });
    cs.cacheSet('other', 'z', 1, { a: 3 });
    cs.clearCacheNamespace('cn');
    const x = cs.cacheGet('cn', 'x', 1);
    const z = cs.cacheGet('other', 'z', 1);
    check('clearNamespace 只清本命名空间', x === null && !!z);
  }

  try { fs.unlinkSync(OUT); } catch { /* ignore */ }
  const pass = results.filter((r) => r[1]).length;
  console.log(`\n${pass}/${results.length} 项通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('脚本异常:', e); process.exit(2); });
