/* eslint-disable */
/**
 * v26 取链层补丁验证（Node，esbuild 打包 + 虚拟模块打桩）。
 *
 * 修复内容：resolvePlayUrl 由「多平台纯串行降级链」改为「错峰并行竞速」，
 * 配套 BaseHttpSource 超时收紧（候选钳制 ≤4s / 重试 1 次 / 源级全局 9s）。
 * 9/3 日志实证：串行链弱网下被首源「候选超时×重试」串行叠加拖到 20s+ 才降级。
 *
 * 场景与验收标准对应：
 *   S1 慢源挂起 → 错峰 STAGGER 后并行补位源胜出，胜出即取消慢源在途取链（abort 传导）
 *   S2 首源快速失败 → 立即补位启动下一源，不等 STAGGER 间隔
 *   S3 链序先手窗口 → 首源与后备源都快时首源胜出（优先级语义保留）
 *   S4 全部源失败 → 以「All N sources failed」聚合错误 reject
 *   S5 外部切歌 abort → 竞速立即级联取消，不阻塞新曲播放
 *   S6 单源链行为回归 → 单源成功路径与旧版一致
 *
 * 运行：node scripts/verify-linkrace-v26.cjs
 */
const esbuild = require('esbuild');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// —— 打桩模块 ——
const STUBS = {
  './mediaSession': `
    export async function initMediaSession() { return {}; }
    export async function updateMetadata() {}
    export async function updatePlaybackState() {}
    export async function updatePosition() {}
    export function startPositionSync() {}
    export async function clearMediaSession() {}
    export function notifyPlaybackStateChange() {}
    export const eqService = { async getCapabilities() { return {}; }, async getEnabled() { return false; }, addEventListener() {}, removeEventListener() {} };
  `,
  '@core/streaming': `
    const g = (globalThis.__linkTest = globalThis.__linkTest || {});
    const state = g.streamingState = g.streamingState || { loads: [], resetCount: 0, callbacks: null };
    export const __streamingState = state;
    export const streamingAudioPlayer = {
      async load(opts) { state.loads.push({ url: opts && opts.url }); return { duration: 180 }; },
      async reset() { state.resetCount++; },
      setAudioElementListener() {},
      setCallbacks() {},
      loadDecryptedData() { return Promise.resolve({}); },
      suppressAutoStart() {},
      play() { return Promise.resolve(); },
      pause() {}, resume() {}, stop() {},
      seek() {}, setVolume() {}, getVolume() { return 1; },
      getCurrentTime() { return 0; }, getDuration() { return 180; },
      getAudioElement() { return null; },
      async prefetchNext() {},
      __simulatePlaying() {
        const cb = state.callbacks;
        if (!cb) return;
        if (cb.onStateChange) cb.onStateChange('playing');
        if (cb.onCanPlay) cb.onCanPlay();
      },
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
    const g = (globalThis.__linkTest = globalThis.__linkTest || {});
    export const sourceRegistry = {
      get(id) { return (g.sources || {})[id]; },
    };
  `,
  '@shared/components/Toast': `
    export const toast = { info() {}, success() {}, error() {}, warn() {} };
  `,
  '@shared/services/PlayHistoryService': `
    export const playHistoryService = { addRecord() { return Promise.resolve({}); } };
  `,
  '@shared/utils/debugLogger': `
    export const debugLogger = { info() {}, warn() {}, error() {}, debug() {} };
  `,
  '@shared/utils/platformFetch': `
    export async function platformFetch() { throw new Error('network disabled in test'); }
  `,
  '@modules/music/localScanner': `
    export async function readLocalAudioAsUrl() { return ''; }
  `,
  '@shared/audio/crypto': `
    export async function decryptCencMp4() { throw new Error('not used'); }
  `,
};

const stubPlugin = {
  name: 'stub-player-deps',
  setup(build) {
    build.onResolve({ filter: /^\.\.?\/|^\// }, (args) => {
      const importer = args.importer.replace(/\\/g, '/');
      if (!importer.endsWith('core/player/index.ts')) return null;
      const norm = args.path.replace(/\\/g, '/');
      if (STUBS[norm]) return { path: 'stub:' + norm, namespace: 'stub' };
      return null;
    });
    build.onResolve({ filter: /^@/ }, (args) => {
      if (STUBS[args.path]) return { path: 'stub:' + args.path, namespace: 'stub' };
      if (args.path === '@core/types') return { path: path.join(ROOT, 'src/core/types.ts') };
      if (args.path === '@core/platformPriority') return { path: path.join(ROOT, 'src/core/platformPriority.ts') };
      return null;
    });
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      const key = args.path.slice('stub:'.length);
      const contents = STUBS[key];
      if (contents == null) return { errors: [{ text: 'no stub for ' + key }] };
      return { contents, loader: 'ts' };
    });
  },
};

async function bundleStub(source, outfile) {
  await esbuild.build({
    stdin: { contents: source, loader: 'ts', resolveDir: ROOT },
    bundle: true, format: 'cjs', platform: 'node', outfile, logLevel: 'silent',
  });
  return require(outfile);
}

function installShims() {
  global.window = global.window || globalThis;
  global.document = global.document || {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible',
  };
  global.navigator = global.navigator || { userAgent: 'node-test' };
  const ls = new Map();
  global.localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => ls.set(k, String(v)),
    removeItem: (k) => ls.delete(k),
    clear: () => ls.clear(),
  };
  global.URL.createObjectURL = global.URL.createObjectURL || (() => 'blob:fake');
  global.URL.revokeObjectURL = global.URL.revokeObjectURL || (() => {});
  class FakeAudio {
    constructor() {
      this._ls = {}; this.paused = true; this.volume = 1;
      this.currentTime = 0; this.duration = NaN; this.crossOrigin = ''; this.src = '';
    }
    addEventListener(t, fn) { (this._ls[t] = this._ls[t] || []).push(fn); }
    removeEventListener() {}
    play() {
      this.paused = false;
      (this._ls.play || []).forEach((f) => f({ type: 'play' }));
      return Promise.resolve();
    }
    pause() {
      const wasPaused = this.paused;
      this.paused = true;
      if (!wasPaused) (this._ls.pause || []).forEach((f) => f({ type: 'pause' }));
    }
  }
  global.Audio = global.Audio || FakeAudio;
  global.HTMLAudioElement = global.HTMLAudioElement || FakeAudio;
}

const G = () => (globalThis.__linkTest = globalThis.__linkTest || {});

// 可配置假源：calls 记录启动时间与 abort 观测；mode: resolve/reject/hang
function makeSource(id, mode, delayMs) {
  return {
    id,
    enabled: true,
    getPlayUrl(songId, quality, signal) {
      const g = G();
      g.calls.push({ id, at: Date.now(), abortedAt: null });
      const rec = g.calls[g.calls.length - 1];
      if (signal) {
        if (signal.aborted) rec.abortedAt = Date.now();
        else signal.addEventListener('abort', () => { rec.abortedAt = rec.abortedAt || Date.now(); });
      }
      return new Promise((resolve, reject) => {
        if (mode === 'hang') {
          // 永不主动落定；abort 时按真实 getPlayUrl 语义 reject，保证竞速可收敛
          if (signal) signal.addEventListener('abort', () => reject(new Error('取链已取消')));
          return;
        }
        setTimeout(() => {
          if (mode === 'reject') {
            reject(new Error('link failed for ' + id));
          } else {
            resolve({
              url: 'https://cdn.example/' + id + '/' + songId + '.mp3',
              quality, bitrate: 128, format: 'mp3', headers: {},
            });
          }
        }, delayMs);
      });
    },
  };
}

function setSources(map) { G().sources = map; G().calls = []; }
function calls() { return G().calls; }

function makeTrack(songId, primary, available) {
  return {
    id: songId,
    title: '歌曲' + songId,
    artist: '测试歌手',
    sourceId: primary,
    sourceSongId: songId,
    uri: '',
    availableSources: (available || [primary]).map((sid) => ({ sourceId: sid, sourceSongId: songId })),
  };
}

let passed = 0; let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' —— ' + detail : '')); }
}

async function main() {
  installShims();

  const OUT = path.join(ROOT, '.tmp-linkrace-v26-bundle.cjs');
  const OUT_TYPES = path.join(ROOT, '.tmp-linkrace-types-bundle.cjs');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/core/player/index.ts')],
    bundle: true, format: 'cjs', platform: 'node', outfile: OUT,
    plugins: [stubPlugin], logLevel: 'silent',
  });
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/core/types.ts')],
    bundle: true, format: 'cjs', platform: 'node', outfile: OUT_TYPES, logLevel: 'silent',
  });

  const { playerEngine } = require(OUT);
  const { Quality } = require(OUT_TYPES);
  const stm = await bundleStub(STUBS['@core/streaming'], path.join(ROOT, '.tmp-linkrace-stub-streaming.cjs'));

  const STAGGER_MS = 2000;

  console.log('== v26 取链错峰并行竞速验证 ==\n');

  // ---- S1: 慢源挂起 → 补位源胜出，胜出即取消慢源 ----
  console.log('S1 首源挂起，补位源竞速胜出并取消在途取链');
  setSources({
    kuwo: makeSource('kuwo', 'hang', 0),
    migu: makeSource('migu', 'resolve', 100),
  });
  {
    const t0 = Date.now();
    const r = await playerEngine.playTrack(makeTrack('song1', 'kuwo', ['kuwo', 'migu']), Quality.STANDARD);
    const elapsed = Date.now() - t0;
    check('补位源 migu 胜出（结果 URL 指向 migu）', r.url.includes('/migu/'), 'url=' + r.url);
    check('总耗时 ≈ STAGGER+补位（<4.5s，旧串行将永久挂起）', elapsed < 4500, 'elapsed=' + elapsed + 'ms');
    check('两源都被启动过', calls().some((c) => c.id === 'kuwo') && calls().some((c) => c.id === 'migu'),
      'calls=' + JSON.stringify(calls().map((c) => c.id)));
    const kuwoRec = calls().find((c) => c.id === 'kuwo');
    check('胜出后首源在途取链被 abort', !!kuwoRec.abortedAt, 'abortedAt=' + kuwoRec.abortedAt);
    check('实际播放发生（流式 load 1 次）', stm.__streamingState.loads.length === 1,
      'loads=' + stm.__streamingState.loads.length);
  }

  // ---- S2: 首源快速失败 → 立即补位，不等 STAGGER ----
  console.log('S2 首源快速失败，立即补位启动下一源');
  setSources({
    kuwo: makeSource('kuwo', 'reject', 50),
    migu: makeSource('migu', 'resolve', 100),
  });
  {
    const t0 = Date.now();
    const r = await playerEngine.playTrack(makeTrack('song2', 'kuwo', ['kuwo', 'migu']), Quality.STANDARD);
    const elapsed = Date.now() - t0;
    check('migu 胜出', r.url.includes('/migu/'), 'url=' + r.url);
    check('未等满 STAGGER 间隔（<1.5s，旧串行 ≥ STAGGER）', elapsed < 1500, 'elapsed=' + elapsed + 'ms');
    check('两源启动间隔 <700ms（失败立即补位）',
      calls().length === 2 && (calls()[1].at - calls()[0].at) < 700,
      'gap=' + (calls().length === 2 ? calls()[1].at - calls()[0].at : 'n/a'));
  }

  // ---- S3: 链序先手窗口 → 首源胜出 ----
  console.log('S3 首源与后备源都快，首源胜出（优先级语义保留）');
  setSources({
    kuwo: makeSource('kuwo', 'resolve', 50),
    migu: makeSource('migu', 'resolve', 50),
  });
  {
    const t0 = Date.now();
    const r = await playerEngine.playTrack(makeTrack('song3', 'kuwo', ['kuwo', 'migu']), Quality.STANDARD);
    const elapsed = Date.now() - t0;
    check('首源 kuwo 胜出', r.url.includes('/kuwo/'), 'url=' + r.url);
    check('无需等待 STAGGER 即出结果（<1.5s）', elapsed < 1500, 'elapsed=' + elapsed + 'ms');
    check('后备源未被启动（首源先手窗口内已成功）', calls().length === 1,
      'calls=' + JSON.stringify(calls().map((c) => c.id)));
  }

  // ---- S4: 全部源失败 → 聚合错误 ----
  console.log('S4 全部源失败，聚合错误 reject');
  setSources({
    kuwo: makeSource('kuwo', 'reject', 40),
    migu: makeSource('migu', 'reject', 40),
  });
  {
    let rejected = false; let errMsg = '';
    try { await playerEngine.playTrack(makeTrack('song4', 'kuwo', ['kuwo', 'migu']), Quality.STANDARD); }
    catch (e) { rejected = true; errMsg = e.message; }
    check('播放失败 reject', rejected, 'errMsg=' + errMsg);
    check('错误信息聚合全部源数', /All 2 sources failed/.test(errMsg), 'errMsg=' + errMsg);
  }

  // ---- S5: 外部切歌 abort → 竞速级联取消，不阻塞新曲 ----
  console.log('S5 切歌取消旧竞速，新曲立即播放');
  setSources({
    kuwo: makeSource('kuwo', 'hang', 0),
    migu: makeSource('migu', 'resolve', 50),
  });
  {
    const slow = playerEngine.playTrack(makeTrack('song5', 'kuwo', ['kuwo', 'migu']), Quality.STANDARD);
    await new Promise((r) => setTimeout(r, 300));
    const next = playerEngine.playTrack(makeTrack('song6', 'kuwo', ['kuwo', 'migu']), Quality.STANDARD);
    let slowSettled = 'pending';
    slow.then(() => { slowSettled = 'fulfilled'; }, () => { slowSettled = 'rejected'; });
    const r6 = await next;
    await new Promise((r) => setTimeout(r, 50));
    check('新曲成功播放', r6.url.includes('song6'), 'url=' + r6.url);
    check('旧竞速已落定（被取消），不再挂起', slowSettled !== 'pending', 'slow=' + slowSettled);
    const st = playerEngine.getState();
    check('状态机未落入非法值', ['idle', 'loading', 'playing', 'paused', 'error'].includes(st), 'state=' + st);
  }

  // ---- S6: 单源链回归 ----
  console.log('S6 单源链行为与旧版一致');
  setSources({ kuwo: makeSource('kuwo', 'resolve', 50) });
  {
    const t0 = Date.now();
    const r = await playerEngine.playTrack(makeTrack('song7', 'kuwo', ['kuwo']), Quality.STANDARD);
    const elapsed = Date.now() - t0;
    check('单源成功返回', r.url.includes('/kuwo/') && r.url.includes('song7'), 'url=' + r.url);
    check('单链只发起一次取链且快速返回（<1s）', calls().length === 1 && elapsed < 1000,
      'calls=' + calls().length + ' elapsed=' + elapsed + 'ms');
  }

  console.log('\n== 结果: ' + passed + ' 通过 / ' + failed + ' 失败 ==');
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
