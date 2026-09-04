/* eslint-disable */
/**
 * 流式缓存 appendData I/O 基准（Node，esbuild 打包 + stub 打桩）。
 *
 * 目的：量化复现 c3555a6 基线"播放加载好久"的核心根因之一——
 * 旧版 appendData 每个 chunk 都要 stat + 全量读回 + 合并 + 全量写回（base64 全量编解码），
 * 累计 I/O 随 chunk 数二次增长（O(n²)）；新实现（原生 appendFile / Web 2MB 缓冲刷盘）线性。
 *
 * 用法：
 *   node scripts/bench-stream-append.cjs                 # 同时跑旧版（红测副本）与新版
 *   node scripts/bench-stream-append.cjs <cache.ts路径>  # 只跑指定实现
 *
 * 输出指标：50MB 文件按 512KB chunk 顺序写入时，Filesystem 层累计读+写字节数与调用次数。
 */
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

// —— @capacitor/filesystem 内存替身：记录每次调用的字节搬运量 ——
const FS_STUB = `
function state() {
  return (globalThis.__benchState = globalThis.__benchState || {
    store: new Map(), bytesRead: 0, bytesWritten: 0, calls: {},
  });
}
function tick(name) { const s = state(); s.calls[name] = (s.calls[name] || 0) + 1; }
function enc(bytes) { let b = ''; for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i]); return btoa(b); }
function dec(b64) { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
export const Directory = { Data: 'DATA' };
export const Encoding = { UTF8: 'UTF8' };
export const Filesystem = {
  async mkdir() { tick('mkdir'); },
  async readFile({ path }) { tick('readFile'); const s = state(); if (!s.store.has(path)) throw new Error('not found'); const d = dec(s.store.get(path)); s.bytesRead += d.length; return { data: enc(d) }; },
  async writeFile({ path, data }) { tick('writeFile'); const s = state(); const d = dec(data); s.bytesWritten += d.length; s.store.set(path, d); return {}; },
  async appendFile({ path, data }) { tick('appendFile'); const s = state(); const d = dec(data); const prev = s.store.get(path) || new Uint8Array(0); const next = new Uint8Array(prev.length + d.length); next.set(prev, 0); next.set(d, prev.length); s.store.set(path, next); s.bytesWritten += d.length; return {}; },
  async deleteFile({ path }) { tick('deleteFile'); state().store.delete(path); },
  async stat({ path }) { tick('stat'); const s = state(); if (!s.store.has(path)) throw new Error('not found'); return { size: s.store.get(path).length }; },
  async readdir() { tick('readdir'); return { files: [] }; },
  async getUri({ path }) { return { uri: 'file://' + path }; },
};
`;

const CORE_STUB = `
export const Capacitor = {
  get platform() { return 'web'; },
  isNativePlatform: () => false,
  convertFileSrc: (p) => p,
};
`;

const LOGGER_STUB = `
export const debugLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return debugLogger; } };
`;

const stubPlugin = {
  name: 'bench-stubs',
  setup(build) {
    build.onResolve({ filter: /^@capacitor\/filesystem$/ }, () => ({ path: 'stub:fs', namespace: 'stub' }));
    build.onResolve({ filter: /^@capacitor\/core$/ }, () => ({ path: 'stub:core', namespace: 'stub' }));
    build.onResolve({ filter: /^@shared\/utils\/debugLogger$/ }, () => ({ path: 'stub:log', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: { 'stub:fs': FS_STUB, 'stub:core': CORE_STUB, 'stub:log': LOGGER_STUB }[args.path],
      loader: 'ts',
    }));
  },
};

async function bench(label, cacheTsPath) {
  const outfile = path.join(ROOT, '.tmp-bench-' + label + '.cjs');
  await esbuild.build({
    stdin: { contents: `export * from ${JSON.stringify(cacheTsPath)};`, loader: 'ts', resolveDir: ROOT },
    bundle: true, format: 'cjs', platform: 'node', outfile, plugins: [stubPlugin], logLevel: 'silent',
  });
  delete require.cache[require.resolve(outfile)];
  const mod = require(outfile);
  // c3555a6 旧版只导出单例 streamCacheEngine；新版导出可注入上限的 StreamCacheEngine
  const Engine = mod.StreamCacheEngine ?? mod.streamCacheEngine.constructor;

  globalThis.__benchState = undefined;
  const engine = new Engine();
  const entry = await engine.getOrCreateEntry('bench_key', 'mp3');
  if (!entry) throw new Error('getOrCreateEntry failed');

  const CHUNK = 512 * 1024;
  const CHUNKS = Number(process.env.BENCH_CHUNKS || 30); // ≈15MB 文件（旧版 O(n²) 全量编解码在 JS 桩内已足够耗时）
  const payload = new Uint8Array(CHUNK).fill(7);

  const t0 = Date.now();
  for (let i = 0; i < CHUNKS; i++) {
    await engine.appendData('bench_key', payload, i * CHUNK);
  }
  const elapsed = Date.now() - t0;

  const s = globalThis.__benchState;
  const moved = s.bytesRead + s.bytesWritten;
  console.log(`[${label}] ${CHUNKS} chunks × 512KB（≈${(CHUNKS * 0.5).toFixed(0)}MB）顺序写入`);
  console.log(`  累计 I/O 字节搬运: ${(moved / 1024 / 1024).toFixed(1)} MB（读 ${(s.bytesRead / 1024 / 1024).toFixed(1)} + 写 ${(s.bytesWritten / 1024 / 1024).toFixed(1)}）`);
  console.log(`  Filesystem 调用: ` + JSON.stringify(s.calls));
  console.log(`  耗时: ${elapsed} ms`);
  console.log(`  复杂度特征: 累计搬运 / 文件大小 = ${(moved / (CHUNK * CHUNKS)).toFixed(1)} 倍（O(n²) 时该值随 chunk 数线性增大）`);
  fs.unlinkSync(outfile);
  return moved;
}

async function main() {
  const target = process.argv[2];
  if (target) {
    await bench('target', path.resolve(target));
    return;
  }
  const red = path.join(ROOT, '.tmp-red/core/streaming/cache.ts');
  const cur = path.join(ROOT, 'src/core/streaming/cache.ts');
  if (fs.existsSync(red)) {
    const oldMoved = await bench('旧版-c3555a6', red);
    const newMoved = await bench('新版-修复后', cur);
    console.log(`\n结论: 旧版累计搬运 ${(oldMoved / 1024 / 1024).toFixed(0)}MB vs 新版 ${(newMoved / 1024 / 1024).toFixed(0)}MB —— ` +
      `降低 ${(100 - (newMoved / oldMoved) * 100).toFixed(0)}%`);
  } else {
    await bench('target', cur);
    console.log('（未找到 .tmp-red/core/streaming/cache.ts 红测副本，只测当前实现）');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
