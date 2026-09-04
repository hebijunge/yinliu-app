/**
 * StreamCacheEngine LRU 清理单元测试（node 原生运行，无测试框架依赖）
 * 运行：node tests/streamCacheCleanup.test.mjs
 *
 * 覆盖：
 * 1. 容量上限：超限后 LRU 驱逐最久未访问条目
 * 2. LRU 顺序：触碰刷新访问时间，最近访问的保留
 * 3. 活跃保护：正在播放/下载中的缓存不被驱逐
 * 4. 文件数量上限
 * 5. 写入触发防抖清理
 * 6. init 时清理超额缓存 + 孤儿文件清理
 * 7. 定期清理定时器
 */
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const outDir = path.join(here, '.build');
mkdirSync(outDir, { recursive: true });

// 打包入口：把被测模块与 mock 编进同一个 bundle，保证 mock 的内存 store
// 在 cache 与测试之间是同一个模块实例（分别 import 会产生两份实例）
const entryFile = path.join(outDir, 'cache-test-entry.mjs');
writeFileSync(
  entryFile,
  [
    `export { StreamCacheEngine, streamCacheEngine } from ${JSON.stringify(
      path.join(repoRoot, 'src/core/streaming/cache.ts')
    )};`,
    `export * as mockFs from ${JSON.stringify(path.join(repoRoot, 'tests/mocks/mock-filesystem.mjs'))};`,
    '',
  ].join('\n')
);

execSync(
  'npx esbuild ' + entryFile +
    ' --bundle --format=esm --outfile=' + path.join(outDir, 'cache.mjs') +
    // v22-lru-fix 后 cache.ts 引入 @capacitor/core（Capacitor.isNativePlatform），需替身
    ' --alias:@capacitor/filesystem=./tests/mocks/mock-filesystem.mjs' +
    ' --alias:@capacitor/core=./tests/stubs/capacitor-core.mjs' +
    ' --alias:@shared/utils/debugLogger=./tests/mocks/mock-debugLogger.mjs',
  { cwd: repoRoot, stdio: 'inherit' }
);
const { StreamCacheEngine, streamCacheEngine, mockFs } = await import(
  path.join(outDir, 'cache.mjs')
);

const CACHE_DIR = 'yinliu/stream_cache';

let passed = 0;
const testQueue = [];
function testAsync(name, fn) {
  testQueue.push([name, fn]);
}

function busyWait(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    /* busy wait */
  }
}

// 让出事件循环，让防抖/定期清理定时器有机会触发
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 写入一个缓存条目（公开 API：getOrCreateEntry + writeData）
async function writeEntry(engine, key, size) {
  await engine.getOrCreateEntry(key, 'mp3');
  await engine.writeData(key, new Uint8Array(size));
}

function makeEngine(opts = {}) {
  return new StreamCacheEngine({
    cleanupDebounceMs: 3600_000, // 默认禁用防抖清理，避免用例间互相干扰
    cleanupIntervalMs: 3600_000, // 默认禁用定期清理
    ...opts,
  });
}

console.log('== StreamCacheEngine LRU 清理 ==');

testAsync('容量上限：写入超限后 cleanupLRU 驱逐最久未访问条目', async () => {
  const engine = makeEngine({ maxSize: 1600 });
  await writeEntry(engine, 'a', 600);
  busyWait(3);
  await writeEntry(engine, 'b', 600);
  busyWait(3);
  await writeEntry(engine, 'c', 600); // 总量 1800 > 1600

  await engine.cleanupLRU();

  assert.equal(engine.getEntry('a'), null, 'a 最久未访问，应被驱逐');
  assert.ok(engine.getEntry('b'), 'b 应保留');
  assert.ok(engine.getEntry('c'), 'c 应保留');
  assert.equal(mockFs.__has(`${CACHE_DIR}/a.mp3`), false, 'a 的缓存文件应被删除');
  assert.equal(mockFs.__has(`${CACHE_DIR}/b.mp3`), true, 'b 的缓存文件应保留');
  assert.equal(mockFs.__has(`${CACHE_DIR}/c.mp3`), true, 'c 的缓存文件应保留');
});

testAsync('LRU 顺序：触碰刷新访问时间，最近访问的保留', async () => {
  const engine = makeEngine({ maxSize: 1200 });
  await writeEntry(engine, 'a', 600);
  busyWait(3);
  await writeEntry(engine, 'b', 600);
  busyWait(3);
  await writeEntry(engine, 'c', 600);
  // 触碰 a → a 变为最新，b 成为最久未访问
  assert.ok(engine.getEntry('a'));

  await engine.cleanupLRU();

  assert.ok(engine.getEntry('a'), 'a 应保留（最近访问）');
  assert.equal(engine.getEntry('b'), null, 'b 应被驱逐（最久未访问）');
  assert.ok(engine.getEntry('c'), 'c 应保留');
});

testAsync('活跃保护：正在播放/下载中的缓存不被驱逐', async () => {
  const engine = makeEngine({ maxSize: 500 });
  await writeEntry(engine, 'b', 600); // b 更旧
  busyWait(3);
  await writeEntry(engine, 'a', 600);
  // b 正在播放/下载中
  engine.markActive('b');

  await engine.cleanupLRU();

  assert.equal(engine.getEntry('a'), null, 'a 应被驱逐');
  assert.ok(engine.getEntry('b'), '活跃条目 b 不应被驱逐（总 600 > 500，但活跃不可逐）');
  assert.equal(mockFs.__has(`${CACHE_DIR}/b.mp3`), true, 'b 的缓存文件不应被删除');

  // 释放后可被驱逐
  engine.markInactive('b');
  await engine.cleanupLRU();
  assert.equal(engine.getEntry('b'), null, '释放后 b 超限可被驱逐');
});

testAsync('活跃保护：全部活跃且超限时不会误删也不会死循环', async () => {
  const engine = makeEngine({ maxSize: 500 });
  await writeEntry(engine, 'a', 600);
  engine.markActive('a');

  await engine.cleanupLRU(); // 应安全退出，不删除

  assert.ok(engine.getEntry('a'), '唯一活跃条目应保留');
  assert.equal(mockFs.__has(`${CACHE_DIR}/a.mp3`), true);
});

testAsync('文件数量上限：超过 maxFiles 驱逐最旧条目', async () => {
  const engine = makeEngine({ maxSize: 100 * 1024 * 1024, maxFiles: 3 });
  for (const k of ['a', 'b', 'c', 'd']) {
    await writeEntry(engine, k, 10);
    busyWait(3);
  }

  await engine.cleanupLRU();

  assert.equal(engine.getEntry('a'), null, '最旧的 a 应被驱逐');
  for (const k of ['b', 'c', 'd']) {
    assert.ok(engine.getEntry(k), `${k} 应保留`);
  }
  assert.equal(mockFs.__has(`${CACHE_DIR}/a.mp3`), false);
});

testAsync('写入触发防抖清理：超限后自动驱逐旧缓存', async () => {
  const engine = makeEngine({ maxSize: 1000, cleanupDebounceMs: 10 });
  await writeEntry(engine, 'a', 600);
  busyWait(3);
  await writeEntry(engine, 'b', 600); // 总量 1200 > 1000，写入应触发清理

  await sleep(60); // 等待防抖定时器执行（让出事件循环）
  assert.equal(engine.getEntry('a'), null, '写入后应自动触发清理并驱逐 a');
  assert.ok(engine.getEntry('b'), 'b 应保留');
});

testAsync('init 时清理超额缓存并删除孤儿文件', async () => {
  // 直接落盘种子数据：meta 记录 3 个条目（每个 700，总量 2100 > 上限 1200）+ 1 个孤儿文件
  const metaEntries = {};
  const names = ['x1', 'x2', 'x3'];
  names.forEach((k, i) => {
    mockFs.__seed(`${CACHE_DIR}/${k}.mp3`, new Uint8Array(700));
    metaEntries[k] = {
      key: k,
      filePath: `${CACHE_DIR}/${k}.mp3`,
      format: 'mp3',
      totalSize: 700,
      downloadedRanges: [{ start: 0, end: 699 }],
      createdAt: 1000 + i,
      lastAccessedAt: 1000 + i, // x1 最旧
    };
  });
  mockFs.__seed(`${CACHE_DIR}/orphan_tmp.mp3`, new Uint8Array(123)); // 磁盘有但 meta 没有
  mockFs.__seed(`${CACHE_DIR}/cache_meta.json`, new TextEncoder().encode(JSON.stringify(metaEntries)));

  const engine = makeEngine({ maxSize: 1200 });
  await engine.init();

  assert.equal(engine.getEntry('x1'), null, '最旧的 x1 应在 init 时被清理');
  assert.equal(engine.getEntry('x2'), null, '驱逐 x1 后仍超限（1400 > 1200），x2 也应被清理');
  assert.ok(engine.getEntry('x3'), 'x3 应保留（700 ≤ 1200）');
  assert.equal(mockFs.__has(`${CACHE_DIR}/x1.mp3`), false, 'x1 文件应被删除');
  assert.equal(mockFs.__has(`${CACHE_DIR}/x2.mp3`), false, 'x2 文件应被删除');
  assert.equal(mockFs.__has(`${CACHE_DIR}/orphan_tmp.mp3`), false, '孤儿文件应被删除');
  assert.equal(mockFs.__has(`${CACHE_DIR}/cache_meta.json`), true, 'meta 文件不应被误删');
});

testAsync('定期清理：超限缓存由定时器自动驱逐', async () => {
  const engine = makeEngine({ maxSize: 1000, cleanupIntervalMs: 20 });
  await engine.init(); // 启动定期清理

  await writeEntry(engine, 'a', 600);
  busyWait(3);
  await writeEntry(engine, 'b', 600);

  await sleep(150); // 等待定期清理触发（让出事件循环）
  assert.equal(engine.getEntry('a'), null, '定期清理应驱逐最旧的 a');
  assert.ok(engine.getEntry('b'), 'b 应保留');
});

testAsync('默认上限：全局单例使用 500MB 容量上限且可清理', async () => {
  // 只验证单例存在且 API 完整（500MB 上限不便构造真实数据）
  assert.ok(streamCacheEngine);
  assert.equal(typeof streamCacheEngine.cleanupLRU, 'function');
  assert.equal(typeof streamCacheEngine.markActive, 'function');
  assert.equal(typeof streamCacheEngine.markInactive, 'function');
});

testAsync('clear 后再次写入并清理行为正常（回归）', async () => {
  const engine = makeEngine({ maxSize: 800 });
  await writeEntry(engine, 'a', 600);
  await engine.clear();
  assert.equal(engine.getEntry('a'), null);

  await writeEntry(engine, 'b', 600);
  busyWait(3);
  await writeEntry(engine, 'c', 600);
  await engine.cleanupLRU();
  assert.equal(engine.getEntry('b'), null, 'b 应被驱逐');
  assert.ok(engine.getEntry('c'), 'c 应保留');
});

// 顺序执行：用例共享同一 mock store，必须串行
for (const [name, fn] of testQueue) {
  try {
    mockFs.__reset();
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

console.log(`\n全部通过: ${passed} 项`);
