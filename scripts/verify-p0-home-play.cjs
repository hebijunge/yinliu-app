/**
 * P0 首页加载慢 + 点击闪退 修复验证（esbuild 打桩，node 内跑）
 * 覆盖：
 *   T1  B1 CENC/Z3D 同型：首块就绪前暂停（state=paused）→ load() 仍落定（旧代码永久挂起 → PlayGate 占死）
 *   T2  普通流 chunk0 到达时已暂停 → 起播装配照常执行（audio 有 src，保持暂停态）
 *   T3  MSE 初始化失败（MediaSource 构造抛错）→ 自动降级 Blob，正常起播
 *   T4  appendBuffer 连续同步失败 ×3 → 自动降级 Blob（audio.src 切回缓存 blob）
 * 阴性对照：T1/T2/T3/T4 均以旧代码行为为反面（旧代码：永久挂起 / audio 无 src / 静默死亡 / 只打日志），
 * 与 A5 验证脚本同口径，不另跑旧代码二进制。
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const ESBUILD = path.join(REPO, 'node_modules', 'esbuild');
let esbuild;
try { esbuild = require(ESBUILD); } catch { esbuild = require('esbuild'); }

// ---------- 桩模块 ----------
const cacheCalls = { append: [], readBlob: 0, write: [] };
const cacheStub = `
const calls = { append: [], readBlob: 0, write: [] };
globalThis.__cacheCalls = calls;
export const streamCacheEngine = {
  init: async () => {},
  getOrCreateEntry: async () => ({ totalSize: 0, key: 'k' }),
  getEntry: () => null,
  isCacheComplete: () => false,
  appendData: async (k, d, off) => { calls.append.push({ len: d.length, off }); },
  writeData: async (k, d) => { calls.write.push(d.length); },
  readAsBlobUrl: async () => { calls.readBlob++; return 'blob:cache-mock/' + calls.readBlob; },
  markActive: () => {}, markInactive: () => {},
  setExpectedTotalSize: async () => {},
};
`;

const mseDetectorStub = `
let cap = { isUsable: false, mp3Supported: false, mp4Supported: false, preferredMimeType: null };
globalThis.__setMSECap = (c) => { cap = c; };
export function detectMSECapability() { return cap; }
export function isMSEAvailable() { return cap.isUsable; }
`;

const fetcherStub = `
let cbs = {};
globalThis.__fetcherEmitChunk = async (chunk, data) => {
  if (!cbs.onChunkComplete) throw new Error('no callbacks');
  await cbs.onChunkComplete(chunk, data);
};
globalThis.__fetcherSetStartHook = (fn) => { startHook = fn; };
let startHook = null;
export class StreamFetcher {
  setCallbacks(c) { cbs = c; }
  async start(url, headers, offset) {
    if (startHook) await startHook(offset);
  }
  stop() {}
  // 测试桩：startHook 是测试注入的驱动器，不随 reset 清除
  reset() {}
}
`;

const otherStubs = {
  '@shared/utils/debugLogger': 'export const debugLogger = { info(){}, warn(){}, error(){}, debug(){} };',
  '@providers/music/QishuiCencDecryptor':
    'export class QishuiCencDecryptor { constructor(k){} async decryptStream(s){ return s; } }',
  '@shared/audio/crypto':
    'export async function fetchZ3dKey(){ return "k"; } export function createZ3dDecryptStream(s){ return s; }',
  '@shared/utils/networkMonitor':
    'export function subscribeNetwork(){ return () => {}; } export function isOnline(){ return true; }',
};

function aliasPlugin(extra) {
  const map = {
    './fetcher': 'fetcher-stub',
    './cache': 'cache-stub',
    './mseDetector': 'mse-stub',
    ...Object.fromEntries(Object.keys(otherStubs).map((k) => [k, k])),
    ...extra,
  };
  return {
    name: 'stub-alias',
    setup(build) {
      build.onResolve({ filter: new RegExp('^(fetcher-stub|cache-stub|mse-stub|\\./fetcher|\\./cache|\\./mseDetector)$') }, (a) => ({
        path: { './fetcher': 'fetcher-stub', './cache': 'cache-stub', './mseDetector': 'mse-stub' }[a.path] || a.path,
        namespace: 'stub',
      }));
      for (const [mod, src] of Object.entries(otherStubs)) {
        build.onResolve({ filter: new RegExp('^' + mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }, () => ({
          path: mod, namespace: 'stub:' + mod,
        }));
        build.onLoad({ filter: /.*/, namespace: 'stub:' + mod }, () => ({ contents: src, loader: 'js' }));
      }
      build.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
        const contents = { 'fetcher-stub': fetcherStub, 'cache-stub': cacheStub, 'mse-stub': mseDetectorStub }[a.path];
        return { contents, loader: 'js', resolveDir: path.join(REPO, 'src/core/streaming') };
      });
      void map;
    },
  };
}

async function buildPlayer(extraAlias) {
  const out = path.join(fs.mkdtempSync('/tmp/p0v-'), 'player.cjs');
  await esbuild.build({
    entryPoints: [path.join(REPO, 'src/core/streaming/player.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out,
    plugins: [aliasPlugin(extraAlias || {})],
    logLevel: 'silent',
  });
  return out;
}

// ---------- 浏览器全局桩 ----------
function installGlobals() {
  global.window = global; // 产品代码用 window.setInterval/clearInterval（WebView 环境有）
  global.URL.createObjectURL = (x) => 'blob:ms-mock/' + (global.__msn = (global.__msn || 0) + 1);
  global.URL.revokeObjectURL = () => {};
  class AudioMock {
    constructor(src) { this.src = src || ''; this.currentTime = 0; this.duration = 0; this.paused = true; this.volume = 1;
      this.buffered = { length: 0, start: () => 0, end: () => 0 }; }
    addEventListener() {} removeEventListener() {}
    async play() { this.paused = false; return; }
    pause() { this.paused = true; }
    load() {} removeAttribute() {}
  }
  global.Audio = AudioMock;
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
const timeout = (ms, label) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + label)), ms));

async function freshPlayer(extraAlias) {
  const file = await buildPlayer(extraAlias);
  delete require.cache[file];
  const { StreamingAudioPlayer } = require(file);
  const p = new StreamingAudioPlayer();
  p.setCallbacks({ onError: (e) => { global.__lastErr = e; } });
  return p;
}

const MB = 1024 * 1024;

(async () => {
  installGlobals();
  console.log('P0 首页播放修复验证');

  // ---------- T1: CENC 首块前暂停 → load() 仍落定 ----------
  {
    console.log('T1 CENC: 首块就绪前暂停，load() 必须落定（旧代码永久挂起）');
    let releaseBody;
    const gate = new Promise((r) => (releaseBody = r));
    let readCount = 0;
    // 流：先给 200KB（<256KB 阈值），暂停门，再放行 300KB + 结束
    const stream = new (require('stream').Readable)({
      read() {
        readCount++;
        if (readCount === 1) this.push(new Uint8Array(200 * 1024));
        else if (readCount === 2) {
          gate.then(() => this.push(new Uint8Array(300 * 1024)));
          gate.then(() => this.push(null));
        } else this.push(null);
      },
    });
    global.fetch = async () => ({ ok: true, status: 200, body: streamToWeb(stream) });
    const p = await freshPlayer();
    const loadPromise = p.load({
      url: 'https://mock/cenc', cacheKey: 't1', format: 'mp4',
      isEncrypted: true, decryptKey: 'k', autoStart: true,
    });
    await new Promise((r) => setTimeout(r, 120)); // 等首段 200KB 读入（未达阈值）
    p.pause();                    // 用户暂停 → state=paused（旧代码：阈值/结束分支全跳过）
    p.suppressAutoStart();        // 引擎同款调用
    releaseBody();                // 放行剩余数据并结束流
    let settled = false;
    await Promise.race([loadPromise.then(() => (settled = true)), timeout(8000, 'load() 未落定')]);
    check('load() 在流结束后落定（PlayGate 不被占死）', settled);
    check('保持暂停态（v25 语义不回归）', p.getState() === 'paused', 'state=' + p.getState());
    check('audio 已装配（有 src）', !!p.getAudioElement() && !!p.getAudioElement().src);
  }

  // ---------- T2: 普通流 chunk0 到达时已暂停 ----------
  {
    console.log('T2 普通流: chunk0 到达时已暂停，起播装配照常执行');
    const p = await freshPlayer();
    // start 钩子：先模拟用户暂停，再发 chunk0
    global.__fetcherSetStartHook(async () => {
      p.pause();
      p.suppressAutoStart();
      await global.__fetcherEmitChunk({ index: 0, start: 0, end: 307199 }, new Uint8Array(300 * 1024));
    });
    await p.load({ url: 'https://mock/plain', cacheKey: 't2', format: 'mp3', autoStart: true });
    check('audio 已装配（旧代码 chunk0 被静默丢弃、audio 为 null）', !!p.getAudioElement());
    check('audio 有 src（blob 播放就绪）', /blob:cache-mock|blob:ms-mock/.test(p.getAudioElement()?.src || ''), 'src=' + p.getAudioElement()?.src);
    check('保持暂停态', p.getState() === 'paused', 'state=' + p.getState());
  }

  // ---------- T3: MediaSource 构造抛错 → 降级 Blob 起播 ----------
  {
    console.log('T3 MSE: MediaSource 构造抛错 → 自动降级 Blob 正常起播');
    const p = await freshPlayer();
    // 桩全局会随新 bundle 重置，必须在 freshPlayer 之后设置
    global.__setMSECap({ isUsable: true, mp3Supported: true, mp4Supported: false, preferredMimeType: 'audio/mp4; codecs=mp4a.40.2' });
    global.MediaSource = class { constructor() { throw new Error('MSE constructor not supported'); } };
    global.__fetcherSetStartHook(async () => {
      await global.__fetcherEmitChunk({ index: 0, start: 0, end: 307199 }, new Uint8Array(300 * 1024));
    });
    await p.load({ url: 'https://mock/plain', cacheKey: 't3', format: 'mp3', autoStart: true });
    check('降级后正常起播 playing', p.getState() === 'playing', 'state=' + p.getState());
    check('audio.src 走缓存 blob（非 MediaSource URL）', /blob:cache-mock/.test(p.getAudioElement()?.src || ''), 'src=' + p.getAudioElement()?.src);
    delete global.MediaSource;
  }

  // ---------- T4: appendBuffer 连续失败 ×3 → 降级 Blob ----------
  {
    console.log('T4 MSE: appendBuffer 同步失败 ×3 → 降级 Blob（audio.src 切回缓存）');
    const p = await freshPlayer();
    global.__setMSECap({ isUsable: true, mp3Supported: true, mp4Supported: false, preferredMimeType: 'audio/mpeg' });
    let sb;
    global.MediaSource = class {
      constructor() { this.readyState = 'closed'; this._h = {}; }
      addEventListener(t, fn) {
        this._h[t] = fn;
        if (t === 'sourceopen') queueMicrotask(() => { this.readyState = 'open'; fn(); });
      }
      addSourceBuffer() {
        sb = {
          mode: '', _h: {},
          addEventListener() {},
          appendBuffer() { throw new Error('QuotaExceeded / decode error'); },
        };
        return sb;
      }
      removeSourceBuffer() {} endOfStream() {}
    };
    global.__fetcherSetStartHook(async () => {
      // chunk0：setupMSE 内预 append（失败 1），onFirstChunkReady 起播
      await global.__fetcherEmitChunk({ index: 0, start: 0, end: 307199 }, new Uint8Array(300 * 1024));
      // chunk1/chunk2：appendBuffer 失败累计到 3 → 触发降级
      await global.__fetcherEmitChunk({ index: 1, start: 307200, end: 614399 }, new Uint8Array(300 * 1024));
      await global.__fetcherEmitChunk({ index: 2, start: 614400, end: 921599 }, new Uint8Array(300 * 1024));
      // 等降级（async setupBlobPlayback）完成
      await new Promise((r) => setTimeout(r, 200));
    });
    await p.load({ url: 'https://mock/plain', cacheKey: 't4', format: 'mp3', autoStart: true });
    check('降级后 audio.src 切回缓存 blob', /blob:cache-mock/.test(p.getAudioElement()?.src || ''), 'src=' + p.getAudioElement()?.src);
    check('播放不中断（playing）', p.getState() === 'playing', 'state=' + p.getState());
    global.__fetcherSetStartHook(null);
  }

  console.log(`\\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });

// Readable(Node) → web ReadableStream 桥
function streamToWeb(nodeStream) {
  const { ReadableStream } = require('stream/web');
  return new ReadableStream({
    start(ctrl) {
      nodeStream.on('data', (d) => ctrl.enqueue(new Uint8Array(d)));
      nodeStream.on('end', () => ctrl.close());
      nodeStream.on('error', (e) => ctrl.error(e));
    },
  });
}
