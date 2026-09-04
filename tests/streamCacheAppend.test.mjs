/**
 * StreamCacheEngine appendData 追加性能/正确性单元测试（node 原生运行，无测试框架依赖）
 * 运行：node tests/streamCacheAppend.test.mjs
 *
 * 验收目标（走查严重项：Capacitor Filesystem 无 append 导致的 O(n²) 全量读写）：
 * - 原生平台：顺序追加必须走 Filesystem.appendFile，全程不得 readFile 全量读回
 * - Web 平台：顺序追加走内存缓冲批量刷盘，读-并-写次数被摊薄（不随 chunk 数线性增长）
 * - 非顺序写入（seek/预取回填）：内容正确落位，先刷盘再合并
 * - 数据完整性：各路径最终文件字节与写入序列严格一致
 * - 读前自动刷盘：未达阈值的缓冲数据在 readAsBlobUrl 时可见
 */
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const outDir = path.join(here, '.build');
mkdirSync(outDir, { recursive: true });

execSync(
  'npx esbuild src/core/streaming/cache.ts --bundle --platform=node --format=esm --outfile=' +
    path.join(outDir, 'cache-append.mjs') +
    ' --alias:@capacitor/filesystem=./tests/stubs/capacitor-filesystem.mjs' +
    ' --alias:@capacitor/core=./tests/stubs/capacitor-core.mjs' +
    ' --alias:@shared/utils/debugLogger=./tests/stubs/debug-logger.mjs',
  { cwd: repoRoot, stdio: 'inherit' }
);

const { StreamCacheEngine } = await import(path.join(outDir, 'cache-append.mjs'));

function state() {
  return (globalThis.__yinliuCacheTest ??= { fs: {}, calls: [] });
}

function resetStubs() {
  globalThis.__yinliuCacheTest = { fs: {}, calls: [] };
}

function setFsMethod(name, fn) {
  state().fs[name] = fn;
}

function callsOf(name) {
  return state().calls.filter(([m]) => m === name);
}

/** 虚拟文件系统：内存 Map 存储二进制，接口对齐 @capacitor/filesystem */
function makeVFS() {
  const files = new Map();
  const toBuf = (data) => Buffer.from(data, 'base64');
  return {
    files,
    mkdir: async () => {},
    readdir: async () => ({ files: [] }),
    deleteFile: async ({ path: p }) => {
      files.delete(p);
    },
    getUri: async () => {
      throw new Error('getUri unavailable');
    },
    stat: async ({ path: p }) => {
      const f = files.get(p);
      if (!f) throw new Error('File does not exist');
      return { size: f.length, type: 'file', mtime: new Date() };
    },
    writeFile: async ({ path: p, data }) => {
      files.set(p, toBuf(data));
    },
    appendFile: async ({ path: p, data }) => {
      const prev = files.get(p) ?? Buffer.alloc(0);
      files.set(p, Buffer.concat([prev, toBuf(data)]));
    },
    readFile: async ({ path: p, encoding }) => {
      const f = files.get(p);
      if (!f) throw new Error('File does not exist');
      return encoding ? { data: f.toString('utf8') } : { data: f.toString('base64') };
    },
  };
}

function installVFS(vfs) {
  for (const [name, fn] of Object.entries(vfs)) {
    if (name !== 'files') setFsMethod(name, fn);
  }
}

/** 生成确定性内容的 chunk：第 i 块全部填充 i（mod 251，保证是合法字节值） */
function mkChunk(i, size) {
  const arr = new Uint8Array(size);
  arr.fill(i % 251);
  return arr;
}

function expectedConcat(chunks) {
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

function makeEngine(isNative) {
  state().isNative = isNative;
  // 放大清理防抖/周期，避免 cleanupLRU 干扰追加路径的 I/O 计数
  return new StreamCacheEngine({
    maxSize: 1024 * 1024 * 1024,
    maxFiles: 1000,
    cleanupDebounceMs: 3600_000,
    cleanupIntervalMs: 3600_000,
  });
}

const CACHE_DIR = 'yinliu/stream_cache';

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test('原生平台：顺序追加走 appendFile，无全量读回，内容完整', async () => {
  resetStubs();
  const vfs = makeVFS();
  installVFS(vfs);
  const engine = makeEngine(true);

  const CHUNK = 64 * 1024;
  const N = 16;
  const chunks = [];
  for (let i = 0; i < N; i++) {
    const c = mkChunk(i, CHUNK);
    chunks.push(c);
    await engine.getOrCreateEntry(`native-seq`, 'mp3');
    await engine.appendData('native-seq', c, i * CHUNK);
  }

  const p = `${CACHE_DIR}/native-seq.mp3`;
  // 排除 init 阶段调用后统计
  const appends = callsOf('appendFile').filter(([, o]) => o.path === p);
  const reads = callsOf('readFile').filter(([, o]) => o.path === p);
  const writes = callsOf('writeFile').filter(([, o]) => o.path === p);

  assert.equal(writes.length, 1, '首个 chunk 应整体写入一次');
  assert.equal(appends.length, N - 1, `后续 ${N - 1} 个 chunk 应各走一次原生 appendFile`);
  assert.equal(reads.length, 0, '顺序追加不得 readFile 全量读回（O(n²) 根源）');
  assert.ok(vfs.files.get(p).equals(expectedConcat(chunks)), '最终文件字节应与写入序列严格一致');
});

test('原生平台：非顺序写入（seek 回填）读-合并-写且落位正确', async () => {
  resetStubs();
  const vfs = makeVFS();
  installVFS(vfs);
  const engine = makeEngine(true);

  const CHUNK = 64 * 1024;
  await engine.getOrCreateEntry('native-seek', 'mp3');
  for (let i = 0; i < 3; i++) {
    await engine.appendData('native-seek', mkChunk(i, CHUNK), i * CHUNK);
  }
  // seek 后从 1MB 处回填一个 chunk
  const farChunk = mkChunk(9, CHUNK);
  await engine.appendData('native-seek', farChunk, 1024 * 1024);

  const p = `${CACHE_DIR}/native-seek.mp3`;
  const buf = vfs.files.get(p);
  assert.equal(buf.length, 1024 * 1024 + CHUNK, '文件应扩展到回填末尾');
  assert.ok(buf.subarray(0, 3 * CHUNK).equals(expectedConcat([mkChunk(0, CHUNK), mkChunk(1, CHUNK), mkChunk(2, CHUNK)])), '已下载前缀应保持不变');
  assert.ok(buf.subarray(1024 * 1024).equals(Buffer.from(farChunk)), '回填 chunk 应精确落位到指定偏移');
});

test('Web 平台：批量刷盘摊薄 I/O，读-并-写次数不随 chunk 数线性增长', async () => {
  resetStubs();
  const vfs = makeVFS();
  installVFS(vfs);
  const engine = makeEngine(false);

  const CHUNK = 256 * 1024;
  const N = 12; // 共 3MB > 2MB 阈值
  const chunks = [];
  await engine.getOrCreateEntry('web-batch', 'mp3');
  const appendStart = state().calls.length;
  for (let i = 0; i < N; i++) {
    const c = mkChunk(i, CHUNK);
    chunks.push(c);
    await engine.appendData('web-batch', c, i * CHUNK);
  }
  const appendCalls = state().calls.slice(appendStart);
  const p = `${CACHE_DIR}/web-batch.mp3`;

  const reads = appendCalls.filter(([m, o]) => m === 'readFile' && o.path === p).length;
  const writes = appendCalls.filter(([m, o]) => m === 'writeFile' && o.path === p).length;

  // 旧实现：每个 chunk 一次全量读 + 全量写（N-1 次 readFile + N 次 writeFile）
  // 新实现：首个 chunk 整写 1 次 + 每 2MB 刷盘 1 次（读+写）
  assert.equal(callsOf('appendFile').length, 0, 'Web 平台无原生 appendFile');
  assert.ok(reads <= 2, `追加阶段全量读次数应 ≤2（实际 ${reads}，旧实现为 ${N - 1}）`);
  assert.ok(writes <= 3, `追加阶段全量写次数应 ≤3（实际 ${writes}，旧实现为 ${N}）`);

  // 刷盘后内容完整
  await engine.flush('web-batch');
  assert.ok(vfs.files.get(p).equals(expectedConcat(chunks)), '刷盘后最终文件字节应与写入序列严格一致');
});

test('Web 平台：未达阈值的缓冲在读播放 URL 前自动刷盘', async () => {
  resetStubs();
  const vfs = makeVFS();
  installVFS(vfs);
  const engine = makeEngine(false);

  await engine.getOrCreateEntry('web-flush-on-read', 'mp3');
  await engine.appendData('web-flush-on-read', mkChunk(1, 1024), 0);
  await engine.appendData('web-flush-on-read', mkChunk(2, 1024), 1024);

  const p = `${CACHE_DIR}/web-flush-on-read.mp3`;
  // 首个 chunk（offset 0）立即整体写入建文件；第 2 个 chunk 未达阈值，应仍在缓冲中
  assert.ok(vfs.files.get(p).equals(Buffer.from(mkChunk(1, 1024))), '首个 chunk 应立即落盘');
  const url = await engine.readAsBlobUrl('web-flush-on-read');
  assert.ok(url.startsWith('blob:'), `应返回 blob URL，实际: ${url}`);
  assert.ok(vfs.files.get(p).equals(expectedConcat([mkChunk(1, 1024), mkChunk(2, 1024)])), '读前应把缓冲完整刷入磁盘');
});

test('Web 平台：非顺序写入先刷盘再合并，最终落位正确', async () => {
  resetStubs();
  const vfs = makeVFS();
  installVFS(vfs);
  const engine = makeEngine(false);

  const K = 1024;
  await engine.getOrCreateEntry('web-seek', 'mp3');
  await engine.appendData('web-seek', mkChunk(1, K), 0);
  await engine.appendData('web-seek', mkChunk(2, K), K);
  await engine.appendData('web-seek', mkChunk(3, K), 2 * K);
  // 非顺序：从 100K 处回填（中间有洞）
  const far = mkChunk(9, K);
  await engine.appendData('web-seek', far, 100 * K);
  await engine.flushAll();

  const p = `${CACHE_DIR}/web-seek.mp3`;
  const buf = vfs.files.get(p);
  assert.equal(buf.length, 100 * K + K, '文件应扩展到回填末尾');
  assert.ok(buf.subarray(0, 3 * K).equals(expectedConcat([mkChunk(1, K), mkChunk(2, K), mkChunk(3, K)])), '已缓冲前缀应完整落盘');
  assert.ok(buf.subarray(100 * K).equals(Buffer.from(far)), '回填 chunk 应精确落位');
});

test('Web 平台：writeData 覆盖后缓冲与磁盘尺寸同步', async () => {
  resetStubs();
  const vfs = makeVFS();
  installVFS(vfs);
  const engine = makeEngine(false);

  await engine.getOrCreateEntry('web-overwrite', 'mp3');
  await engine.appendData('web-overwrite', mkChunk(1, 1024), 0);
  const whole = mkChunk(5, 4096);
  await engine.writeData('web-overwrite', whole);
  await engine.appendData('web-overwrite', mkChunk(2, 1024), 4096);
  await engine.flushAll();

  const p = `${CACHE_DIR}/web-overwrite.mp3`;
  const buf = vfs.files.get(p);
  assert.equal(buf.length, 4096 + 1024, '覆盖后追加应接在完整文件尾部');
  assert.ok(buf.subarray(0, 4096).equals(Buffer.from(whole)), '覆盖内容应生效');
  assert.ok(buf.subarray(4096).equals(Buffer.from(mkChunk(2, 1024))), '覆盖后的追加应正确衔接');
});

test('50MB 大文件场景：全量读-写总次数被摊薄，不随文件大小线性恶化', async () => {
  resetStubs();
  const vfs = makeVFS();
  installVFS(vfs);
  const engine = makeEngine(false);

  const CHUNK = 256 * 1024;
  const N = 200; // 共 50MB
  await engine.getOrCreateEntry('web-50mb', 'mp3');
  const appendStart = state().calls.length;
  const chunks = [];
  for (let i = 0; i < N; i++) {
    const c = mkChunk(i, CHUNK);
    chunks.push(c);
    await engine.appendData('web-50mb', c, i * CHUNK);
  }
  await engine.flush('web-50mb');
  const p = `${CACHE_DIR}/web-50mb.mp3`;

  const calls = state().calls.slice(appendStart);
  const reads = calls.filter(([m, o]) => m === 'readFile' && o.path === p).length;
  const writes = calls.filter(([m, o]) => m === 'writeFile' && o.path === p).length;

  // 旧实现每个 chunk 都全量读回+写回：readFile ≈199、writeFile ≈200 次
  // 新实现每 2MB 刷盘一次：50MB → 24 次刷盘 + 1 次首写
  assert.ok(reads <= 26, `50MB 全量读次数应 ≤26（实际 ${reads}，旧实现约 199）`);
  assert.ok(writes <= 28, `50MB 全量写次数应 ≤28（实际 ${writes}，旧实现约 200）`);
  assert.equal(vfs.files.get(p).length, 50 * 1024 * 1024, '最终文件大小应为 50MB');
  assert.ok(
    vfs.files.get(p).equals(expectedConcat(chunks)),
    '50MB 逐字节完整性校验'
  );
});

let passed = 0;
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err && err.message ? err.message : err}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
