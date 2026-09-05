/* eslint-disable */
/**
 * v25 播放深度修复验证（Node，esbuild 打包 + 打桩，无浏览器依赖）。
 *
 * 覆盖场景（对应本次修复的根因）：
 *   T1  HEAD 预检并行化：慢 HEAD（1500ms）不得阻塞首块下载（旧实现串行等待，起播被拖 1.5s+）
 *   T2  暂停后 blob 刷新不得擅自恢复播放（旧实现无条件 play() → 图标显示暂停、音乐在响）
 *   T3  起播前暂停 → 首块就绪不自动起播；用户恢复播放后正常起播（抑制被正确取消）
 *   T4  非流式路径：用户在 play() 完成前暂停 → 保持暂停态，不误报"自动播放被阻止"
 *   T5  起播前无冗余写缓存（appendData 已写过的数据不再 writeData 全量重写）
 *   T6  预取下一首时机：点击后加载中不预取（不与首块抢带宽）；真正起播后才预取
 *   T6b 引擎 pause() 在加载中 → 流式引擎收到 suppressAutoStart
 *   T6c 引擎在 load() 之前暂停 → load 收到 autoStart=false
 *   T7  正常播放回归：播放中 blob 刷新/下载完成后继续播放，状态保持 playing
 *
 * 运行：node scripts/verify-player-fix-v25.cjs
 * 另跑回归：node scripts/verify-player-race.cjs
 */
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, '.build');
fs.mkdirSync(OUT, { recursive: true });

// 播放器代码使用 window.setInterval/clearInterval（浏览器环境），
// Node harness 下需要补上全局 window（指向 global，定时器 API 同名可用）
if (typeof global.window === 'undefined') {
  global.window = global;
}

// ============================================================================
// Part A · 流式播放器（真实 player.ts + fetcher.ts，打桩 cache/网络/加密/MSE）
// ============================================================================

const STREAM_STUBS = {
  './cache': `
    const g = (globalThis.__streamTest = globalThis.__streamTest || {});
    const st = (g.cache = g.cache || {
      data: new Map(),
      calls: { appendData: 0, writeData: 0, readAsBlobUrl: 0, getOrCreateEntry: 0, markActive: 0, markInactive: 0 },
    });
    export const __cacheState = st;
    function entry(key, format) {
      if (!st.data.has(key)) {
        st.data.set(key, { key, format, filePath: key + '.' + (format || 'mp3'), totalSize: 0, downloadedRanges: [], expectedTotalSize: 0 });
      }
      return st.data.get(key);
    }
    export const streamCacheEngine = {
      async init() {},
      async getOrCreateEntry(key, format) { st.calls.getOrCreateEntry++; return entry(key, format); },
      getEntry(key) { return st.data.get(key) || null; },
      markActive() { st.calls.markActive++; },
      markInactive() { st.calls.markInactive++; },
      isRangeDownloaded(key, s, e) {
        const en = st.data.get(key);
        if (!en) return false;
        return en.downloadedRanges.some((r) => r.start <= s && r.end >= e);
      },
      async appendData(key, data, offset) {
        st.calls.appendData++;
        const en = entry(key, 'mp3');
        en.downloadedRanges.push({ start: offset, end: offset + data.length - 1 });
        en.totalSize = Math.max(en.totalSize, offset + data.length);
      },
      async writeData(key, data) {
        st.calls.writeData++;
        const en = entry(key, 'mp3');
        en.totalSize = data.length;
        en.downloadedRanges = [{ start: 0, end: data.length - 1 }];
      },
      async readAsBlobUrl(key) {
        st.calls.readAsBlobUrl++;
        const en = st.data.get(key);
        if (!en || en.totalSize === 0) throw new Error('empty cache');
        return 'blob:mock-' + key;
      },
      async readAsFileUrl(key) { return 'file://mock-' + key; },
      async setExpectedTotalSize(key, size) { entry(key, 'mp3').expectedTotalSize = size; },
    };
  `,
  './mseDetector': `
    export function detectMSECapability() { return { isUsable: false, preferredMimeType: '' }; }
    export function isMSEAvailable() { return false; }
  `,
  '@shared/utils/platformFetch': `
    const g = (globalThis.__streamTest = globalThis.__streamTest || {});
    const net = (g.net = g.net || { headDelayMs: 20, chunkDelaysMs: [30, 30], fileSize: 768 * 1024, log: [] });
    export const __netState = net;
    function resp(status, headers, body) {
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'OK',
        headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
        arrayBuffer: async () => body,
      };
    }
    export async function platformFetch(url, options = {}) {
      const method = (options.method || 'GET').toUpperCase();
      if (method === 'HEAD') {
        await new Promise((r) => setTimeout(r, net.headDelayMs));
        net.log.push({ method: 'HEAD', t: Date.now() });
        return resp(200, { 'content-length': String(net.fileSize), 'accept-ranges': 'bytes' }, new ArrayBuffer(0));
      }
      const range = (options.headers && options.headers.Range) || 'bytes=0-';
      const m = /bytes=(\\d+)-(\\d+)/.exec(range);
      const start = m ? parseInt(m[1], 10) : 0;
      const endReq = m ? parseInt(m[2], 10) : net.fileSize - 1;
      const end = Math.min(endReq, net.fileSize - 1);
      const idx = net.log.filter((l) => l.method === 'GET').length;
      const delay = net.chunkDelaysMs[Math.min(idx, net.chunkDelaysMs.length - 1)] ?? 30;
      await new Promise((r) => setTimeout(r, delay));
      net.log.push({ method: 'GET', range, t: Date.now() });
      const len = end - start + 1;
      return resp(206, { 'content-length': String(len) }, new ArrayBuffer(len));
    }
  `,
  '@shared/utils/debugLogger': `
    const verbose = !!process.env.V25_DEBUG;
    const mk = (tag) => (...args) => { if (verbose) console.log('[' + tag + ']', ...args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))); };
    export const debugLogger = { info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('debug') };
  `,
  '@shared/utils/networkMonitor': `
    export function subscribeNetwork() { return () => {}; }
    export function isOnline() { return true; }
  `,
  '@providers/music/QishuiCencDecryptor': `
    export class QishuiCencDecryptor {}
  `,
  '@shared/audio/crypto': `
    export async function fetchZ3dKey() { throw new Error('not used'); }
    export function createZ3dDecryptStream() { throw new Error('not used'); }
  `,
};

// 流式层 FakeAudio：src 赋值后异步补发 loadedmetadata（供就绪等待 resolve）
function makeStreamAudioClass() {
  const g = () => (globalThis.__streamTest = globalThis.__streamTest || {});
  return class FakeAudio {
    constructor(src) {
      this._ls = {};
      this.paused = true;
      this.volume = 1;
      // v28 后 shouldRefreshBlob 用 audio.buffered 判定刷新时机；桩模拟
      // 「播放位置已在缓冲区间内」（0.9/1 > 0.85），使刷新沿用尺寸阈值触发，
      // T7 的播放中刷新续播场景得以覆盖
      this.currentTime = 0.9;
      this.buffered = { length: 1, end: () => 1 };
      this.duration = NaN;
      this.crossOrigin = '';
      this.error = null;
      this.playCalls = 0;
      this._src = '';
      g().audios.push(this);
      if (src) this.src = src;
    }
    get src() { return this._src; }
    set src(v) {
      this._src = v;
      setTimeout(() => this._fire('loadedmetadata'), 0);
    }
    addEventListener(t, fn) { (this._ls[t] = this._ls[t] || []).push(fn); }
    removeEventListener() {}
    _fire(t) { (this._ls[t] || []).slice().forEach((f) => f({ type: t })); }
    play() {
      this.playCalls++;
      this.paused = false;
      setTimeout(() => this._fire('play'), 0);
      return Promise.resolve();
    }
    pause() {
      const was = this.paused;
      this.paused = true;
      if (!was) setTimeout(() => this._fire('pause'), 0);
    }
    load() {}
    removeAttribute(k) { if (k === 'src') this._src = ''; }
  };
}

async function buildStreamPlayer() {
  const outfile = path.join(OUT, 'stream-player-v25.cjs');
  await esbuild.build({
    stdin: { contents: `export { streamingAudioPlayer } from './src/core/streaming/player';`, resolveDir: ROOT, loader: 'ts' },
    bundle: true, format: 'cjs', platform: 'node', outfile, logLevel: 'silent',
    plugins: [{
      name: 'stub-stream-deps',
      setup(build) {
        build.onResolve({ filter: /^@/ }, (args) => {
          if (STREAM_STUBS[args.path]) return { path: 'stub:' + args.path, namespace: 'stub' };
          return null;
        });
        build.onResolve({ filter: /^\.\.?\// }, (args) => {
          const importer = args.importer.replace(/\\/g, '/');
          if (!importer.includes('core/streaming/player.ts')) return null;
          if (args.path === './cache') return { path: 'stub:./cache', namespace: 'stub' };
          if (args.path === './mseDetector') return { path: 'stub:./mseDetector', namespace: 'stub' };
          return null; // './fetcher' 走真实实现
        });
        build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: STREAM_STUBS[args.path.slice('stub:'.length)],
          loader: 'ts',
        }));
      },
    }],
  });
  return require(outfile);
}

function resetStreamEnv(netOpts) {
  // 注意：stub 模块（platformFetch / cache）在首次加载时已将 net / cache 对象
  // 绑定进自身闭包。这里必须【原位变更】，不能整体替换 __streamTest，
  // 否则日志与计数写到旧对象、断言读到的永远是空的（T1 误报"首块 GET 未发出"）。
  const g = (globalThis.__streamTest = globalThis.__streamTest || {
    audios: [],
    cache: {
      data: new Map(),
      calls: { appendData: 0, writeData: 0, readAsBlobUrl: 0, getOrCreateEntry: 0, markActive: 0, markInactive: 0 },
    },
    net: { headDelayMs: 20, chunkDelaysMs: [30, 30], fileSize: 768 * 1024, log: [] },
  });
  if (!g.cache) g.cache = { data: new Map(), calls: { appendData: 0, writeData: 0, readAsBlobUrl: 0, getOrCreateEntry: 0, markActive: 0, markInactive: 0 } };
  if (!g.net) g.net = { headDelayMs: 20, chunkDelaysMs: [30, 30], fileSize: 768 * 1024, log: [] };
  Object.assign(g.net, { headDelayMs: 20, chunkDelaysMs: [30, 30], fileSize: 768 * 1024 }, netOpts || {});
  g.net.log.length = 0;
  g.cache.data.clear();
  for (const k of Object.keys(g.cache.calls)) g.cache.calls[k] = 0;
  g.audios = [];
  global.Audio = makeStreamAudioClass();
  global.HTMLAudioElement = global.Audio;
}

async function waitFor(pred, timeoutMs = 6000, step = 10) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

async function runStreamTests() {
  const { streamingAudioPlayer: player } = await buildStreamPlayer();
  const results = [];

  async function freshPlayer() {
    await player.reset();
  }

  // ---- T1 + T5：HEAD 并行 + 无冗余写缓存 ----
  {
    resetStreamEnv({ headDelayMs: 1500, chunkDelaysMs: [30, 30] });
    await freshPlayer();
    const st = globalThis.__streamTest;
    const errors = [];
    let canplay = 0;
    player.setCallbacks({
      onError: (e) => errors.push(e),
      onCanPlay: () => canplay++,
      onStateChange: (s) => { if (process.env.V25_DEBUG) console.log('[state]', s); },
    });
    const t0 = Date.now();
    const loadP = player.load({ cacheKey: 't1', format: 'mp3', url: 'https://cdn/t1.mp3', headers: {} });
    const gotFirstGet = await waitFor(() => st.net.log.some((l) => l.method === 'GET'));
    const firstGetDelay = Date.now() - t0;
    await loadP;
    // 首块 GET 不等 HEAD（HEAD 1500ms）
    assert.ok(gotFirstGet, '首块 GET 应已发出');
    assert.ok(
      firstGetDelay < 900,
      `T1 首块 GET 应在 HEAD(1500ms) 完成前发出，实际 ${firstGetDelay}ms`
    );
    // 第二块范围被 HEAD 的 totalSize 钳制（768KB 文件：256KB..786431）
    const ok2 = await waitFor(() => st.net.log.filter((l) => l.method === 'GET').length >= 2);
    assert.ok(ok2, '第二块 GET 应发生');
    const secondGet = st.net.log.filter((l) => l.method === 'GET')[1];
    assert.equal(secondGet.range, 'bytes=262144-786431', `T1 第二块应被 totalSize 钳制，实际 ${secondGet.range}`);
    // 起播成功
    assert.ok(await waitFor(() => player.getState() === 'playing'), 'T1 应自动起播到 playing');
    assert.equal(errors.length, 0, `T1 不应有错误: ${errors.join(',')}`);
    // T5：appendData 已写过的首块不再 writeData 全量重写
    assert.equal(st.cache.calls.writeData, 0, `T5 起播路径不应触发 writeData（实际 ${st.cache.calls.writeData} 次）`);
    assert.equal(st.cache.calls.appendData, 2, 'T5 两个 chunk 均由 appendData 落缓存');
    assert.ok(st.cache.calls.readAsBlobUrl >= 1, 'T5 应通过缓存读路径拿到播放 URL');
    results.push('T1 HEAD 并行：首块 GET @' + firstGetDelay + 'ms（HEAD 1500ms 未阻塞）+ 范围钳制正确 ✔');
    results.push('T5 冗余写缓存：writeData=0 / appendData=2 ✔');
  }

  // ---- T2：暂停后 blob 刷新不自动恢复播放 ----
  {
    resetStreamEnv({ headDelayMs: 10, chunkDelaysMs: [30, 400] });
    await freshPlayer();
    const st = globalThis.__streamTest;
    const errors = [];
    player.setCallbacks({ onError: (e) => errors.push(e), onStateChange: () => {} });
    await player.load({ cacheKey: 't2', format: 'mp3', url: 'https://cdn/t2.mp3', headers: {} });
    assert.ok(await waitFor(() => player.getState() === 'playing'), 'T2 应先正常起播');
    const audio = st.audios[st.audios.length - 1];
    const playCallsAtPause = audio.playCalls;
    player.pause();
    assert.equal(player.getState(), 'paused', 'T2 暂停后状态应为 paused');
    // 等剩余 chunk 下载完成 + onComplete 最终刷新
    await waitFor(() => st.net.log.filter((l) => l.method === 'GET').length >= 2);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      audio.playCalls, playCallsAtPause,
      'T2 暂停后 blob 刷新不得再次调用 audio.play()（实际多了 ' + (audio.playCalls - playCallsAtPause) + ' 次）'
    );
    assert.equal(player.getState(), 'paused', 'T2 刷新后仍应保持 paused');
    assert.equal(errors.length, 0, `T2 不应有错误: ${errors.join(',')}`);
    results.push('T2 暂停后刷新：audio.play 不再被擅自调用，状态保持 paused ✔');
  }

  // ---- T3：起播前暂停 → 首块就绪不自动起播；恢复后正常起播 ----
  {
    resetStreamEnv({ headDelayMs: 10, chunkDelaysMs: [250, 30] });
    await freshPlayer();
    const st = globalThis.__streamTest;
    const errors = [];
    let canplay = 0;
    player.setCallbacks({ onError: (e) => errors.push(e), onCanPlay: () => canplay++ });
    const loadP = player.load({ cacheKey: 't3', format: 'mp3', url: 'https://cdn/t3.mp3', headers: {} });
    await new Promise((r) => setTimeout(r, 120)); // 越过 load() 内部标记复位窗口
    player.suppressAutoStart();
    await loadP;
    assert.ok(await waitFor(() => player.getState() === 'paused'), 'T3 首块就绪后应停在 paused');
    const audio = st.audios[st.audios.length - 1];
    assert.equal(audio.playCalls, 0, 'T3 抑制期间不得调用 audio.play()');
    assert.equal(canplay, 0, 'T3 抑制期间不得触发 onCanPlay（引擎不应误进 playing）');
    // 用户点恢复 → 正常起播
    await player.play();
    assert.ok(await waitFor(() => player.getState() === 'playing'), 'T3 恢复播放后应进入 playing');
    assert.equal(errors.length, 0, `T3 不应有错误: ${errors.join(',')}`);
    results.push('T3 起播前暂停：首块就绪不起播；恢复播放后正常出声 ✔');
  }

  // ---- T7：正常播放回归（播放中刷新/完成后继续播放）----
  {
    resetStreamEnv({ headDelayMs: 10, chunkDelaysMs: [30, 30] });
    await freshPlayer();
    const st = globalThis.__streamTest;
    const errors = [];
    player.setCallbacks({ onError: (e) => errors.push(e) });
    await player.load({ cacheKey: 't7', format: 'mp3', url: 'https://cdn/t7.mp3', headers: {} });
    await waitFor(() => st.net.log.filter((l) => l.method === 'GET').length >= 2);
    await new Promise((r) => setTimeout(r, 300));
    const audio = st.audios[st.audios.length - 1];
    assert.equal(player.getState(), 'playing', 'T7 全程播放状态应保持 playing');
    assert.ok(audio.playCalls >= 2, `T7 播放中刷新应续播（play 调用 ${audio.playCalls} 次）`);
    assert.equal(errors.length, 0, `T7 不应有错误: ${errors.join(',')}`);
    results.push('T7 正常播放回归：刷新后续播、状态保持 playing ✔');
  }

  return results;
}

// ============================================================================
// Part B · 引擎层（真实 core/player/index.ts，打桩流式引擎/取链/媒体会话）
// ============================================================================

const ENGINE_STUBS = {
  './mediaSession': `
    export async function initMediaSession() { return {}; }
    export async function updateMetadata() {}
    export async function updatePlaybackState() {}
    export async function updatePosition() {}
    export function startPositionSync() {}
    export async function clearMediaSession() {}
  `,
  './audioFocus': `export function notifyPlaybackStateChange() {}`,
  './equalizer': `
    export const eqService = {
      ensureActive() {}, attachElement() { return Promise.resolve(); }, setElementProvider() {},
    };
  `,
  '@core/streaming': `
    const g = (globalThis.__engineTest = globalThis.__engineTest || {});
    const st = (g.streaming = g.streaming || {
      loads: [], suppress: 0, resetCount: 0, playCalls: 0, prefetch: [], callbacks: null,
    });
    export const __streamingState = st;
    export const streamingAudioPlayer = {
      async load(opts) { st.loads.push(opts); await new Promise((r) => setTimeout(r, 10)); },
      setCallbacks(cb) { st.callbacks = cb; },
      setAudioElementListener() {},
      async reset() { st.resetCount++; st.callbacks = null; },
      suppressAutoStart() { st.suppress++; },
      pause() {},
      async play() { st.playCalls++; return Promise.resolve(); },
      seek() {}, setVolume() {}, getVolume() { return 1; },
      getCurrentTime() { return 0; }, getDuration() { return 180; },
      getAudioElement() { return null; },
      async prefetchNext(opts) { st.prefetch.push(opts); },
      __simulatePlaying() { const cb = st.callbacks; if (cb && cb.onStateChange) cb.onStateChange('playing'); },
      __simulateCanPlay() { const cb = st.callbacks; if (cb && cb.onCanPlay) cb.onCanPlay(); },
    };
  `,
  '@core/download': `
    export const downloadEngine = {
      getTasks() { return []; },
      async checkLocalFile() { return false; },
      async readLocalFileAsUrl() { return ''; },
    };
  `,
  '@providers/music/registry': `
    const g = (globalThis.__engineTest = globalThis.__engineTest || {});
    const calls = (g.linkCalls = g.linkCalls || []);
    export const __linkCalls = calls;
    const fakeSource = {
      enabled: true,
      async getPlayUrl(songId, quality, signal) {
        calls.push({ songId, quality });
        await new Promise((r) => setTimeout(r, 25));
        if (signal && signal.aborted) {
          const e = new Error('aborted'); e.name = 'AbortError'; throw e;
        }
        return { url: 'https://cdn.example/' + songId + '.mp3', quality, bitrate: 128, format: 'mp3', headers: {} };
      },
    };
    export const sourceRegistry = { get() { return fakeSource; } };
  `,
  '@shared/components/Toast': `export const toast = { info() {}, success() {}, error() {}, warn() {} };`,
  '@shared/services/PlayHistoryService': `
    export const playHistoryService = { addRecord() { return Promise.resolve({}); } };
  `,
  '@shared/utils/debugLogger': `
    const verbose = !!process.env.V25_DEBUG;
    const mk = (tag) => (...args) => { if (verbose) console.log('[' + tag + ']', ...args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))); };
    export const debugLogger = { info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('debug') };
  `,
  '@shared/utils/platformFetch': `
    export async function platformFetch() { throw new Error('network disabled in test'); }
  `,
  '@modules/music/localScanner': `
    export async function readLocalAudioAsUrl() {
      await new Promise((r) => setTimeout(r, 10));
      return 'blob:local-file';
    }
  `,
  '@shared/audio/crypto': `
    export async function decryptCencMp4() { throw new Error('not used'); }
  `,
};

// 引擎层 FakeAudio：play() 挂起可被 pause() 以 AbortError 打断（模拟浏览器行为）
function makeEngineAudioClass() {
  const g = () => (globalThis.__engineTest = globalThis.__engineTest || {});
  return class EngineAudio {
    constructor(src) {
      this._ls = {}; this.paused = true; this.src = src || ''; this.currentTime = 0;
      this.duration = NaN; this.crossOrigin = ''; this.error = null; this.volume = 1;
      // v28 后流式引擎的 shouldRefreshBlob 会读 audio.buffered（本桩用于引擎层
      // 非流式路径，给空 buffered 使其安全返回 false）
      this.buffered = { length: 0, end: () => 0 };
      this._pendingPlay = null;
      g().audios.push(this);
    }
    addEventListener(t, fn) { (this._ls[t] = this._ls[t] || []).push(fn); }
    removeEventListener() {}
    _fire(t) { (this._ls[t] || []).slice().forEach((f) => f({ type: t })); }
    play() {
      const gg = g(); gg.audioPlayCalls = (gg.audioPlayCalls || 0) + 1;
      this.paused = false;
      this._fire('play');
      return new Promise((resolve, reject) => {
        this._pendingPlay = { resolve, reject };
      });
    }
    pause() {
      const was = this.paused;
      this.paused = true;
      if (this._pendingPlay) {
        const rej = this._pendingPlay.reject;
        this._pendingPlay = null;
        rej(new DOMException('The play() request was interrupted by a call to pause()', 'AbortError'));
      }
      if (!was) this._fire('pause');
    }
    load() {}
    removeAttribute() {}
  };
}

async function buildEngine() {
  const outfile = path.join(OUT, 'engine-v25.cjs');
  await esbuild.build({
    stdin: { contents: `export { playerEngine } from './src/core/player/index';\nexport { Quality } from './src/core/types';`, resolveDir: ROOT, loader: 'ts' },
    bundle: true, format: 'cjs', platform: 'node', outfile, logLevel: 'silent',
    plugins: [{
      name: 'stub-engine-deps',
      setup(build) {
        build.onResolve({ filter: /^@/ }, (args) => {
          if (ENGINE_STUBS[args.path]) return { path: 'stub:' + args.path, namespace: 'stub' };
          if (args.path === '@core/types') return { path: path.join(ROOT, 'src/core/types.ts') };
          if (args.path === '@core/platformPriority') return { path: path.join(ROOT, 'src/core/platformPriority.ts') };
          return null;
        });
        build.onResolve({ filter: /^\.\.?\// }, (args) => {
          const importer = args.importer.replace(/\\/g, '/');
          if (!importer.endsWith('core/player/index.ts')) return null;
          const norm = args.path.replace(/\\/g, '/');
          if (ENGINE_STUBS[norm]) return { path: 'stub:' + norm, namespace: 'stub' };
          return null;
        });
        build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: ENGINE_STUBS[args.path.slice('stub:'.length)],
          loader: 'ts',
        }));
      },
    }],
  });
  return require(outfile);
}

/**
 * 引擎层环境重置 —— 必须原位变更：引擎打桩模块（@core/streaming、registry）在
 * 首次加载时已将 streaming / linkCalls 对象绑定进闭包，整体替换 __engineTest
 * 会让计数写到旧对象、断言读新对象，永远为空（与 Part A 的 resetStreamEnv 同理）。
 */
function resetEngineEnv() {
  const g = (globalThis.__engineTest = globalThis.__engineTest || {
    audios: [],
    streaming: { loads: [], suppress: 0, resetCount: 0, playCalls: 0, prefetch: [], callbacks: null },
    linkCalls: [],
  });
  if (!g.streaming) g.streaming = { loads: [], suppress: 0, resetCount: 0, playCalls: 0, prefetch: [], callbacks: null };
  if (!g.linkCalls) g.linkCalls = [];
  if (!g.audios) g.audios = [];
  g.streaming.loads = [];
  g.streaming.suppress = 0;
  g.streaming.resetCount = 0;
  g.streaming.playCalls = 0;
  g.streaming.prefetch = [];
  g.streaming.callbacks = null;
  g.linkCalls.length = 0;
  g.audios = [];
}

async function runEngineTests() {
  global.window = global.window || globalThis;
  global.document = global.document || { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
  if (!global.URL.createObjectURL) global.URL.createObjectURL = () => 'blob:x';
  if (!global.URL.revokeObjectURL) global.URL.revokeObjectURL = () => {};

  const { playerEngine, Quality } = await buildEngine();
  const st = () => globalThis.__engineTest.streaming;
  const results = [];

  // ---- T4：非流式路径，起播前暂停不误报 error ----
  {
    globalThis.__engineTest = { audios: [], streaming: st() };
    global.Audio = makeEngineAudioClass();
    global.HTMLAudioElement = global.Audio;
    const errors = [];
    playerEngine.on('error', ({ message }) => errors.push(message));
    const track = { id: 'l1', title: '本地歌', sourceId: 'local', sourceSongId: '/sdcard/a.mp3', uri: '' };
    const p = playerEngine.playTrack(track, Quality.STANDARD);
    await new Promise((r) => setTimeout(r, 60)); // audio 已创建、play() 挂起中
    playerEngine.pause();
    await p.catch(() => {});
    assert.equal(errors.length, 0, `T4 不应误报错误（实际: ${errors.join(',')}）`);
    assert.equal(playerEngine.getState(), 'paused', 'T4 最终状态应为 paused');
    results.push('T4 起播前暂停（本地路径）：无"自动播放被阻止"误报，状态保持 paused ✔');
  }

  // ---- T6：预取时机 —— 加载中不预取，起播后才预取 ----
  {
    resetEngineEnv();
    global.Audio = makeEngineAudioClass();
    const trackA = { id: 'a', title: 'A', sourceId: 'kuwo', sourceSongId: '1001', uri: '', availableSources: [{ sourceId: 'kuwo', sourceSongId: '1001' }] };
    const trackB = { id: 'b', title: 'B', sourceId: 'kuwo', sourceSongId: '1002', uri: '', availableSources: [{ sourceId: 'kuwo', sourceSongId: '1002' }] };
    playerEngine.setQueue([trackA, trackB], 0);
    await playerEngine.playTrack(trackA, Quality.STANDARD);
    // 加载中（未 simulate 起播）等 1.1s —— 旧实现 800ms 就会预取 B
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(st().prefetch.length, 0, `T6 加载中不得预取下一首（实际 ${st().prefetch.length} 次）`);
    const bLinks = globalThis.__engineTest.linkCalls.filter((c) => c.songId === '1002').length;
    assert.equal(bLinks, 0, `T6 加载中不得为下一首取链（实际 ${bLinks} 次）`);
    // 模拟起播完成 → 800ms 后应预取 B
    st().callbacks && st().callbacks.onStateChange && st().callbacks.onStateChange('playing');
    st().callbacks && st().callbacks.onCanPlay && st().callbacks.onCanPlay();
    const ok = await new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (st().prefetch.length >= 1) { clearInterval(timer); resolve(true); }
        else if (Date.now() - start > 2500) { clearInterval(timer); resolve(false); }
      }, 20);
    });
    assert.ok(ok, 'T6 起播后应预取下一首');
    assert.equal(st().prefetch[0].cacheKey.includes('1002'), true, 'T6 预取的应是下一首 B');
    results.push('T6 预取时机：加载中零预取/零取链；起播后才预取下一首 ✔');
  }

  // ---- T6b：加载中 pause() → 流式引擎收到 suppressAutoStart ----
  {
    resetEngineEnv();
    global.Audio = makeEngineAudioClass();
    const trackC = { id: 'c', title: 'C', sourceId: 'kuwo', sourceSongId: '2001', uri: '', availableSources: [{ sourceId: 'kuwo', sourceSongId: '2001' }] };
    const p = playerEngine.playTrack(trackC, Quality.STANDARD);
    await new Promise((r) => setTimeout(r, 40)); // 已进入流式 load（isStreaming=true，引擎 loading）
    playerEngine.pause();
    await p.catch(() => {});
    assert.ok(st().suppress >= 1, 'T6b 引擎暂停应通知流式引擎抑制自动起播');
    assert.equal(playerEngine.getState(), 'paused', 'T6b 引擎状态应为 paused');
    results.push('T6b 加载中暂停：suppressAutoStart 已下发，状态保持 paused ✔');
  }

  // ---- T6c：load() 之前的暂停 → load 收到 autoStart=false ----
  {
    resetEngineEnv();
    global.Audio = makeEngineAudioClass();
    const trackD = { id: 'd', title: 'D', sourceId: 'kuwo', sourceSongId: '3001', uri: '', availableSources: [{ sourceId: 'kuwo', sourceSongId: '3001' }] };
    const p = playerEngine.playTrack(trackD, Quality.STANDARD);
    await new Promise((r) => setTimeout(r, 5)); // 让 doPlayTrack 先启动（清除旧标记）
    playerEngine.pause(); // 此时还在取链阶段（load 尚未发生）
    await p.catch(() => {});
    assert.equal(st().loads.length, 1, 'T6c 流式 load 应已发生');
    assert.equal(st().loads[0].autoStart, false, `T6c load 应收到 autoStart=false（实际 ${JSON.stringify(st().loads[0] && st().loads[0].autoStart)}）`);
    results.push('T6c load 前暂停：autoStart=false 传入流式引擎（覆盖 load 前窗口）✔');
  }

  return results;
}

// ============================================================================
(async () => {
  const all = [];
  try {
    all.push(...(await runStreamTests()));
  } catch (err) {
    console.error('\n[流式层] 验证失败:', err.message);
    process.exit(1);
  }
  try {
    all.push(...(await runEngineTests()));
  } catch (err) {
    console.error('\n[引擎层] 验证失败:', err.message);
    process.exit(1);
  }
  console.log('\n===== v25 播放深度修复验证 =====');
  all.forEach((line) => console.log('  ' + line));
  console.log(`\n全部 ${all.length} 项 PASS ✔`);
  process.exit(0);
})();
