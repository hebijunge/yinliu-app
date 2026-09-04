/* eslint-disable */
/**
 * 播放去重锁竞态验证（Node，esbuild 打包 + 虚拟模块打桩）。
 *
 * 场景与验收标准对应：
 *   S1 快速连续点击同一首歌（同 tick 并发）→ 只取链一次、只实际播放一次
 *   S2 播放失败（异常路径）后播放另一首 → 新曲必须真正取链播放（不被残留锁卡死）
 *   S3 同 tick 并发点击两首不同歌 → 两首各自取链、各自播放一次，结果互不串
 *   S4 异常后重试同一首歌 → 必须重新发起取链（锁已释放）
 *   S5 正常播放完成后播放新曲 → 锁已释放，新曲立即生效；状态机不落非法值
 *
 * 运行：node scripts/verify-player-race.cjs
 */
const esbuild = require('esbuild');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// —— 虚拟打桩模块（隔离浏览器/原生依赖，只保留被测的竞态逻辑）——
const STUBS = {
  './mediaSession': `
    export async function initMediaSession() { return {}; }
    export async function updateMetadata() {}
    export async function updatePlaybackState() {}
    export async function updatePosition() {}
    export function startPositionSync() {}
    export async function clearMediaSession() {}
  `,
  './audioFocus': `
    export function notifyPlaybackStateChange() {}
  `,
  './equalizer': `
    export const eqService = {
      ensureActive() {},
      attachElement() { return Promise.resolve(); },
      setElementProvider() {},
    };
  `,
  '@core/streaming': `
    const g = (globalThis.__playerTest = globalThis.__playerTest || {});
    const state = (g.streaming = g.streaming || { loads: [], resetCount: 0, callbacks: null });
    export const __streamingState = state;
    export const streamingAudioPlayer = {
      async load(opts) { state.loads.push(opts); await new Promise((r) => setTimeout(r, 25)); },
      setCallbacks(cb) { state.callbacks = cb; },
      setAudioElementListener() {},
      async reset() { state.resetCount++; state.callbacks = null; },
      pause() {},
      play() { return Promise.resolve(); },
      seek() {},
      setVolume() {},
      getVolume() { return 1; },
      getCurrentTime() { return 0; },
      getDuration() { return 180; },
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
    const g = (globalThis.__playerTest = globalThis.__playerTest || {});
    const calls = (g.linkCalls = g.linkCalls || []);
    export const __linkCalls = calls;
    const fakeSource = {
      enabled: true,
      async getPlayUrl(songId, quality, signal) {
        calls.push({ songId, quality, at: calls.length });
        await new Promise((r) => setTimeout(r, 25));
        if (signal && signal.aborted) {
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        }
        if (String(songId).startsWith('fail')) {
          throw new Error('link failed for ' + songId);
        }
        return {
          url: 'https://cdn.example/' + songId + '.mp3',
          quality,
          bitrate: 128,
          format: 'mp3',
          headers: {},
        };
      },
    };
    export const sourceRegistry = { get() { return fakeSource; } };
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
    // 相对导入打桩：仅拦截 player/index.ts 发出的相对依赖
    build.onResolve({ filter: /^\.\.?\/|^\// }, (args) => {
      const importer = args.importer.replace(/\\/g, '/');
      if (!importer.endsWith('core/player/index.ts')) return null;
      const norm = args.path.replace(/\\/g, '/');
      if (STUBS[norm]) return { path: 'stub:' + norm, namespace: 'stub' };
      // 红测副本放在仓库内的临时目录，其真实相对依赖重定向到仓库内对应文件
      if (importer.includes('.tmp-red')) {
        const base = path.join(ROOT, 'src/core/player', norm);
        const real = path.extname(base) ? base : base + '.ts';
        return { path: real };
      }
      return null;
    });
    // '@xxx' 别名打桩；@core/types / @core/platformPriority 走真实文件
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

// —— 浏览器全局垫片 ——
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

function makeTrack(songId, sourceId = 'kuwo') {
  return {
    id: songId,
    title: '歌曲' + songId,
    artist: '测试歌手',
    sourceId,
    sourceSongId: songId,
    uri: '',
    availableSources: [{ sourceId, sourceSongId: songId }],
  };
}

let passed = 0; let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' —— ' + detail : '')); }
}

async function main() {
  installShims();

  const OUT = path.join(ROOT, '.tmp-player-race-bundle.cjs');
  const OUT_TYPES = path.join(ROOT, '.tmp-player-types-bundle.cjs');
  // 可选参数：被测 index.ts 路径（默认工作区文件；红测时传入修复前的副本）
  const ENTRY = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'src/core/player/index.ts');
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true, format: 'cjs', platform: 'node', outfile: OUT,
    plugins: [stubPlugin], logLevel: 'silent',
  });
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/core/types.ts')],
    bundle: true, format: 'cjs', platform: 'node', outfile: OUT_TYPES, logLevel: 'silent',
  });

  const { playerEngine } = require(OUT);
  const { Quality } = require(OUT_TYPES);

  // 单独打包打桩模块，提供观测点（linkCalls / streaming loads）
  const OUT_REG = path.join(ROOT, '.tmp-stub-registry.cjs');
  const OUT_STM = path.join(ROOT, '.tmp-stub-streaming.cjs');
  const reg = await bundleStub(STUBS['@providers/music/registry'], OUT_REG);
  const stm = await bundleStub(STUBS['@core/streaming'], OUT_STM);

  function resetStubs() {
    reg.__linkCalls.length = 0;
    stm.__streamingState.loads.length = 0;
    stm.__streamingState.resetCount = 0;
    stm.__streamingState.callbacks = null;
  }

  console.log('== 播放去重锁竞态验证 ==\n');

  // ---- S1: 快速连续点击同一首歌（同 tick 并发）----
  console.log('S1 快速连续点击同一首歌（同 tick 并发）');
  resetStubs();
  {
    const t = makeTrack('song1');
    const [r1, r2] = await Promise.allSettled([
      playerEngine.playTrack(t, Quality.STANDARD),
      playerEngine.playTrack(t, Quality.STANDARD),
    ]);
    check('两次调用都成功', r1.status === 'fulfilled' && r2.status === 'fulfilled',
      'r1=' + r1.status + ' r2=' + r2.status + (r1.reason ? ' err=' + r1.reason.message : ''));
    check('取链只发生一次', reg.__linkCalls.length === 1,
      '实际 ' + reg.__linkCalls.length + ' 次: ' + JSON.stringify(reg.__linkCalls.map((c) => c.songId)));
    check('实际播放只发生一次', stm.__streamingState.loads.length === 1,
      '实际 load ' + stm.__streamingState.loads.length + ' 次');
    check('两次结果一致且指向同曲',
      r1.status === 'fulfilled' && r2.status === 'fulfilled'
      && r1.value.url === r2.value.url
      && r1.value.url.includes('song1'),
      'url1=' + (r1.value && r1.value.url) + ' url2=' + (r2.value && r2.value.url));
  }

  // ---- S2: 失败后播放另一首（不被残留锁卡死）----
  console.log('S2 播放失败后播放另一首歌');
  resetStubs();
  {
    const bad = makeTrack('fail1');
    let firstRejected = false;
    try { await playerEngine.playTrack(bad, Quality.STANDARD); } catch { firstRejected = true; }
    check('失败曲目确实抛错', firstRejected);
    const good = makeTrack('song2');
    let ok = false; let errMsg = '';
    try {
      const r = await playerEngine.playTrack(good, Quality.STANDARD);
      ok = !!r && r.url.includes('song2');
    } catch (e) { errMsg = e.message; }
    check('新曲成功取链并返回自身 URL', ok,
      'errMsg=' + errMsg + ' linkCalls=' + JSON.stringify(reg.__linkCalls.map((c) => c.songId)));
    check('新曲真正发起了取链', reg.__linkCalls.some((c) => c.songId === 'song2'),
      'linkCalls=' + JSON.stringify(reg.__linkCalls.map((c) => c.songId)));
    check('新曲真正被播放',
      stm.__streamingState.loads.length === 1 && stm.__streamingState.loads[0].url.includes('song2'),
      'loads=' + JSON.stringify(stm.__streamingState.loads.map((l) => l.url)));
  }

  // ---- S3: 同 tick 并发点击两首不同歌 ----
  console.log('S3 同 tick 并发点击两首不同歌');
  resetStubs();
  {
    const ta = makeTrack('songA');
    const tb = makeTrack('songB');
    const [ra, rb] = await Promise.allSettled([
      playerEngine.playTrack(ta, Quality.STANDARD),
      playerEngine.playTrack(tb, Quality.STANDARD),
    ]);
    check('两首调用都成功', ra.status === 'fulfilled' && rb.status === 'fulfilled',
      'ra=' + ra.status + ' rb=' + rb.status + (rb.reason ? ' rbErr=' + rb.reason.message : ''));
    check('两首各自取链一次', reg.__linkCalls.length === 2
      && reg.__linkCalls.some((c) => c.songId === 'songA')
      && reg.__linkCalls.some((c) => c.songId === 'songB'),
      'linkCalls=' + JSON.stringify(reg.__linkCalls.map((c) => c.songId)));
    check('两首各自实际播放一次', stm.__streamingState.loads.length === 2,
      'loads=' + stm.__streamingState.loads.length);
    check('结果不串曲',
      ra.status === 'fulfilled' && ra.value.url.includes('songA')
      && rb.status === 'fulfilled' && rb.value.url.includes('songB'),
      'urlA=' + (ra.value && ra.value.url) + ' urlB=' + (rb.value && rb.value.url));
    const st = playerEngine.getState();
    check('状态机未落入非法值', ['idle', 'loading', 'playing', 'paused', 'error'].includes(st), 'state=' + st);
  }

  // ---- S4: 异常后重试同一首歌（锁必须已释放）----
  console.log('S4 异常后重试同一首歌');
  resetStubs();
  {
    const bad = makeTrack('fail1');
    try { await playerEngine.playTrack(bad, Quality.STANDARD); } catch {}
    const before = reg.__linkCalls.length;
    let secondRejected = false;
    try { await playerEngine.playTrack(bad, Quality.STANDARD); } catch { secondRejected = true; }
    check('重试同样抛错', secondRejected);
    check('重试重新发起取链（锁无残留）', reg.__linkCalls.length === before + 1,
      'before=' + before + ' after=' + reg.__linkCalls.length);
  }

  // ---- S5: 正常播放完成后播新曲（锁释放 + 状态合法）----
  console.log('S5 正常播放完成后播放新曲');
  resetStubs();
  {
    const t1 = makeTrack('song1');
    await playerEngine.playTrack(t1, Quality.STANDARD);
    // 模拟流式引擎回调 playing
    stm.streamingAudioPlayer.__simulatePlaying();
    check('播放中状态为 playing', playerEngine.getState() === 'playing', 'state=' + playerEngine.getState());
    const t3 = makeTrack('song3');
    let ok = false; let errMsg = '';
    try {
      const r = await playerEngine.playTrack(t3, Quality.STANDARD);
      ok = !!r && r.url.includes('song3');
    } catch (e) { errMsg = e.message; }
    check('新曲立即生效（锁已释放）', ok && stm.__streamingState.loads.length === 2,
      'ok=' + ok + ' loads=' + stm.__streamingState.loads.length + ' errMsg=' + errMsg);
  }

  console.log('\n== 结果: ' + passed + ' 通过 / ' + failed + ' 失败 ==');
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
