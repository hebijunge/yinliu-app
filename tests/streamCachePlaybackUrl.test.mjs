/**
 * StreamCacheEngine 播放 URL 策略单元测试（node 原生运行，无测试框架依赖）
 * 运行：node tests/streamCachePlaybackUrl.test.mjs
 *
 * 验收目标（走查严重项：大文件缓存播放内存不随文件大小线性增长）：
 * - 原生平台：readAsBlobUrl 必须走 getUri + convertFileSrc 零拷贝路径，
 *   全程不得调用 Filesystem.readFile（无字节进入 JS Heap）
 * - Web 平台：readFile 直接返回 Blob（浏览器托管存储），避免 base64 + atob 峰值
 * - 各回退路径保持向后兼容
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
    path.join(outDir, 'cache.mjs') +
    ' --alias:@capacitor/filesystem=./tests/stubs/capacitor-filesystem.mjs' +
    ' --alias:@capacitor/core=./tests/stubs/capacitor-core.mjs' +
    ' --alias:@shared/utils/debugLogger=./tests/stubs/debug-logger.mjs',
  { cwd: repoRoot, stdio: 'inherit' }
);

const { streamCacheEngine } = await import(path.join(outDir, 'cache.mjs'));

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

async function makeEntry(key, format = 'mp3', size = 100 * 1024 * 1024) {
  await streamCacheEngine.getOrCreateEntry(key, format);
  // 直接登记缓存条目元信息（不实际产生数据）
  await streamCacheEngine.setExpectedTotalSize(key, size);
}

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test('原生平台：零拷贝路径，不读取任何字节', async () => {
  resetStubs();
  state().isNative = true;
  setFsMethod('getUri', async (opts) => {
    return { uri: 'file:///data/user/0/app/files/' + opts.path };
  });

  await makeEntry('song-a', 'mp3', 100 * 1024 * 1024);
  state().calls.length = 0; // 排除 init/loadMeta 的元数据读取，只看播放路径
  const before = process.memoryUsage().heapUsed;
  const url = await streamCacheEngine.readAsBlobUrl('song-a');
  const after = process.memoryUsage().heapUsed;

  assert.ok(
    url.startsWith('https://localhost/_capacitor_file_/') && url.includes('song-a.mp3'),
    `应返回 WebView 本地服务文件 URL，实际: ${url}`
  );
  assert.equal(callsOf('readFile').length, 0, '原生平台不得调用 readFile（100MB 不进 JS Heap）');
  assert.equal(callsOf('getUri').length, 1, '应通过 getUri 获取原生文件路径');
  // 结构性零拷贝已验证；堆增量仅作宽松兜底（应远小于 100MB 文件）
  const deltaMB = (after - before) / (1024 * 1024);
  assert.ok(deltaMB < 20, `堆增量 ${deltaMB.toFixed(1)}MB 应远小于 100MB 文件大小`);
});

test('原生平台：getUri 失败时回退 base64 读取（向后兼容）', async () => {
  resetStubs();
  state().isNative = true;
  setFsMethod('getUri', async () => {
    throw new Error('getUri unavailable');
  });
  // 小样本 base64（"ID3x"）
  setFsMethod('readFile', async () => ({ data: Buffer.from('ID3x').toString('base64') }));

  await makeEntry('song-b', 'flac');
  const url = await streamCacheEngine.readAsBlobUrl('song-b');
  assert.ok(url.startsWith('blob:'), `回退路径应返回 blob URL，实际: ${url}`);
});

test('Web 平台：readFile 返回 Blob，直接生成 objectURL', async () => {
  resetStubs();
  setFsMethod('readFile', async () => ({
    data: new Blob([new Uint8Array([0x49, 0x44, 0x33])], { type: 'audio/mpeg' }),
  }));

  await makeEntry('song-c', 'mp3');
  const url = await streamCacheEngine.readAsBlobUrl('song-c');
  assert.ok(url.startsWith('blob:'), `Web 平台应返回 blob URL，实际: ${url}`);
});

test('Web 平台：readFile 返回 base64 字符串时仍可用', async () => {
  resetStubs();
  setFsMethod('readFile', async () => ({ data: Buffer.from('ID3x').toString('base64') }));

  await makeEntry('song-d', 'm4a');
  const url = await streamCacheEngine.readAsBlobUrl('song-d');
  assert.ok(url.startsWith('blob:'), `实际: ${url}`);
});

test('Web 平台：文件缺失/为空时抛错，不再静默返回空 blob URL', async () => {
  resetStubs();
  setFsMethod('readFile', async () => {
    throw new Error('File does not exist');
  });

  await makeEntry('song-e');
  await assert.rejects(() => streamCacheEngine.readAsBlobUrl('song-e'), /Cache file|not found|exist/i);
});

test('未知缓存键：抛错', async () => {
  resetStubs();
  await assert.rejects(() => streamCacheEngine.readAsBlobUrl('no-such-key'), /Cache entry not found/);
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
