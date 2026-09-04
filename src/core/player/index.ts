import type { PlayUrlResult } from '@core/types';
import { Quality } from '@core/types';
import { sourceRegistry } from '@providers/music/registry';
import { downloadEngine } from '@core/download';
import { sourceHealthChecker } from '@core/health/SourceHealthChecker';
import { readLocalAudioAsUrl } from '@modules/music/localScanner';
import {
  buildFallbackChain,
  PLATFORM_DISPLAY_NAMES,
} from '@core/platformPriority';
import { toast } from '@shared/components/Toast';
import {
  initMediaSession,
  updateMetadata,
  updatePlaybackState,
  updatePosition,
  startPositionSync,
  clearMediaSession,
} from './mediaSession';
import { notifyPlaybackStateChange } from './audioFocus';
import { PlayGate } from './playGate';
import { playHistoryService } from '@shared/services/PlayHistoryService';
import { debugLogger } from '@shared/utils/debugLogger';
import { streamingAudioPlayer, type StreamingState, type StreamingCallbacks } from '@core/streaming';
import { eqService } from './equalizer';
import { decryptCencMp4 } from '@shared/audio/crypto';
import { platformFetch } from '@shared/utils/platformFetch';
import { deriveRawKey } from '../../utils/crypto/kuwoEkey';
import { qmc2DecryptBytes, isDecryptedMagic } from '../../utils/crypto/qmc2';

export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface PlayerTrack {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  duration?: number;
  sourceId: string;
  sourceSongId: string;
  uri: string;
  /**
   * 该曲可用平台列表（按平台优先级升序）。
   * v13 新增：来自聚合搜索结果，resolvePlayUrl 取链失败时按此列表自动降级。
   * 单平台歌曲 / 历史/歌单里没有此字段的曲目 → 不参与降级，保持原行为。
   */
  availableSources?: Array<{ sourceId: string; sourceSongId: string }>;
}

interface PlayerEventMap {
  stateChange: { state: PlayerState; track?: PlayerTrack };
  progress: { currentTime: number; duration: number; progress: number };
  error: { message: string };
  ended: void;
  /** 取链完成（含实际音质/试听标记），UI 据此回写 actualQuality */
  trackLoaded: { track: PlayerTrack; result: PlayUrlResult; actualSourceId: string };
  /**
   * v13: 取链降级事件。首选源不可用时触发，携带从哪个源降级到哪个源。
   * 上层可监听做埋点 / 提示。
   */
  linkFallback: {
    track: PlayerTrack;
    fromSourceId: string;
    toSourceId: string;
    reason: string;
  };
  /** 系统媒体会话 / 锁屏控制触发的事件 */
  mediaAction: { action: string; seekTime: number | null };
  /** v23: 缓冲状态变化（流式 buffering/seeking 或普通 audio waiting） */
  bufferingChange: { buffering: boolean };
}

export class PlayerEngine {
  private audio: HTMLAudioElement | null = null;
  private currentTrack: PlayerTrack | null = null;
  private state: PlayerState = 'idle';
  private listeners: Record<string, Array<(data: unknown) => void>> = {};
  private progressInterval: number | null = null;
  private currentBlobUrl: string | null = null;
  /** 媒体会话是否已初始化 */
  private mediaSessionReady: boolean = false;
  /** v22：系统暂停标记 —— pauseBySystem 与流式回调之间传递 system 来源 */
  private systemPausePending = false;

  // Queue state (兼容 v10 调用方)
  queue: PlayerTrack[] = [];
  currentIndex: number = -1;
  lastQuality: Quality = Quality.STANDARD;

  // v14.4: 流式播放状态
  private isStreaming = false;
  private streamingCurrentUrl = '';
  private streamingHeaders: Record<string, string> = {};
  private prefetchTriggered = false;

  // v16: 预加载缓存（url + blobUrl + actualSourceId）
  private prefetchCache = new Map<string, { url: string; result: PlayUrlResult; actualSourceId: string }>();
  // v24: 播放闸门 —— 同 key 去重 + 不同 key 串行 + 异常路径释放。
  // 替代 v14.5 的 resolvePlayUrlPromise 裸 Promise 去重（比较归属错误、Promise 永不清理、
  // 判定位于副作用之后），消除重入/连点导致的状态机并发突变与图标错乱。
  private playGate = new PlayGate();
  // v20.1-fix: 切歌取消旧取链 AbortController
  private playAbortController: AbortController | null = null;

  // v23: 快速切歌竞态防护 —— 每次 playTrack 递增，过期请求的错误不再上报 UI
  private playGeneration = 0;
  // v23: 上一首/下一首切歌进行中标记（防抖锁：切歌过程中再次点击无效）
  private switchInProgress = false;
  // v23: 缓冲状态缓存（去重，避免重复 emit）
  private bufferingActive = false;

  private emit<K extends keyof PlayerEventMap>(event: K, data: PlayerEventMap[K]) {
    const callbacks = this.listeners[event] || [];
    callbacks.forEach((cb) => cb(data as unknown));
  }

  /** v23: 缓冲状态变化（去重后广播，UI 据此显示缓冲指示器） */
  private setBuffering(buffering: boolean): void {
    if (this.bufferingActive === buffering) return;
    this.bufferingActive = buffering;
    this.emit('bufferingChange', { buffering });
  }

  on<K extends keyof PlayerEventMap>(event: K, callback: (data: PlayerEventMap[K]) => void): () => void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback as (data: unknown) => void);
    return () => {
      this.listeners[event] = this.listeners[event].filter((cb) => cb !== callback);
    };
  }

  private setState(state: PlayerState, source: 'user' | 'system' | 'engine' = 'engine') {
    const prev = this.state;
    this.state = state;
    this.emit('stateChange', { state, track: this.currentTrack || undefined });
    // v18 EQ：播放中确保均衡器音频上下文处于运行态（未挂接时为 no-op）
    if (state === 'playing') {
      eqService.ensureActive();
    }
    // 通知音频焦点模块
    notifyPlaybackStateChange(state, source);
    // 同步到系统媒体会话
    void this.syncMediaSessionState(state, prev);
  }

  private async syncMediaSessionState(state: PlayerState, prev: PlayerState): Promise<void> {
    if (state === prev) return;
    if (state === 'playing') {
      await updatePlaybackState('playing');
      if (this.currentTrack) {
        await updateMetadata({
          title: this.currentTrack.title,
          artist: this.currentTrack.artist ?? '',
          album: this.currentTrack.album ?? '',
          artwork: this.currentTrack.coverUrl,
        });
      }
    } else if (state === 'paused') {
      await updatePlaybackState('paused');
    } else if (state === 'idle' || state === 'error') {
      await updatePlaybackState('paused');
    }
  }

  /**
   * 处理来自通知栏 / 锁屏 / 硬件按键的媒体控制事件
   */
  private async handleMediaAction(action: string, details: { seekTime: number | null }): Promise<void> {
    this.emit('mediaAction', { action, seekTime: details.seekTime });
    try {
      switch (action) {
        case 'play':
          if (this.state === 'paused') {
            this.resume();
          } else if (this.currentTrack && this.state !== 'playing') {
            await this.playTrack(this.currentTrack, this.lastQuality);
          }
          break;
        case 'pause':
          if (this.state === 'playing') {
            this.pause();
          }
          break;
        case 'previoustrack':
          await this.playPrevious();
          break;
        case 'nexttrack':
          await this.playNext();
          break;
        case 'seekbackward': {
          const target = Math.max(0, this.getCurrentTime() - (details.seekTime ?? 10));
          this.seek(target);
          break;
        }
        case 'seekforward': {
          const target = this.getCurrentTime() + (details.seekTime ?? 10);
          this.seek(Math.min(target, this.getDuration() || target));
          break;
        }
        case 'seekto':
          if (details.seekTime !== null) {
            this.seek(details.seekTime);
          }
          break;
        case 'stop':
          this.stop();
          await clearMediaSession();
          break;
        default:
          break;
      }
    } catch (err) {
      console.warn('[PlayerEngine] handleMediaAction failed:', action, err);
    }
  }

  /**
   * 初始化媒体会话；幂等，多次调用安全
   */
  async initMediaSessionBridge(): Promise<void> {
    if (this.mediaSessionReady) return;
    this.mediaSessionReady = true;
    await initMediaSession((action, details) => {
      void this.handleMediaAction(action, details);
    });
    startPositionSync(() => ({
      currentTime: this.getCurrentTime(),
      duration: this.getDuration(),
    }));

    // v23: 前后台切换时强制同步状态与进度。
    // 后台期间定时器被系统节流，回前台后进度条/通知栏可能停留在旧值
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        try {
          const currentTime = this.getCurrentTime();
          const duration = this.getDuration();
          // 强制向 UI 广播一次当前进度（修复进度条不同步）
          this.emit('progress', {
            currentTime,
            duration,
            progress: duration > 0 ? currentTime / duration : 0,
          });
          void updatePosition(currentTime, duration);
          // 强制刷新系统媒体会话播放状态（force 绕过内部去重缓存）
          void updatePlaybackState(this.state === 'playing' ? 'playing' : 'paused', true);
        } catch (err) {
          debugLogger.warn('player', '前后台切换同步失败', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }
  }

  getState(): PlayerState {
    return this.state;
  }

  /** v18 EQ：获取普通播放路径的 audio 元素 */
  getEngineAudioElement(): HTMLAudioElement | null {
    return this.audio;
  }

  /** v18 EQ：获取当前活跃播放路径的 audio 元素（流式优先） */
  getActiveAudioElement(): HTMLAudioElement | null {
    return this.isStreaming ? streamingAudioPlayer.getAudioElement() : this.audio;
  }

  getCurrentTrack(): PlayerTrack | null {
    return this.currentTrack;
  }

  // === 统一 URL 解析器：本地歌曲 → 已下载本地文件 → 预加载缓存 → 在线取链（带优先级降级链） ===
  private async resolvePlayUrl(track: PlayerTrack, quality: Quality): Promise<{ url: string; isLocal: boolean; result: PlayUrlResult; actualSourceId: string }> {
    // 0. 本地歌曲（sourceId === 'local'，v12 已合并分支）：直接读取文件系统
    if (track.sourceId === 'local') {
      const filePath = track.sourceSongId;
      const localUrl = await readLocalAudioAsUrl(filePath);
      const ext = filePath.split('.').pop()?.toLowerCase() || 'mp3';
      debugLogger.info('player', `播放本地文件: ${track.title}`, {
        filePath,
        format: ext,
      });
      return {
        url: localUrl,
        isLocal: true,
        result: { url: localUrl, quality, bitrate: 0, format: ext },
        actualSourceId: 'local',
      };
    }

    // 1. 先检查是否有已下载的本地文件（v11 离线播放分支）
    const tasks = downloadEngine.getTasks();
    const completedTask = tasks.find(
      (t) => t.songId === track.sourceSongId
        && t.sourceId === track.sourceId
        && t.status === 'completed'
        && t.filePath
    );

    if (completedTask?.filePath) {
      const exists = await downloadEngine.checkLocalFile(completedTask.filePath);
      if (exists) {
        try {
          const localUrl = await downloadEngine.readLocalFileAsUrl(completedTask.filePath);
          console.log('[PlayerEngine] Playing from local file:', completedTask.filePath);
          debugLogger.info('player', `播放已下载本地文件: ${track.title}`, {
            filePath: completedTask.filePath,
            sourceId: track.sourceId,
          });
          return {
            url: localUrl,
            isLocal: true,
            result: { url: localUrl, quality, bitrate: 0, format: 'mp3' },
            actualSourceId: track.sourceId,
          };
        } catch (localErr) {
          console.warn('[PlayerEngine] Local file read failed, falling back to online:', localErr);
          debugLogger.warn('player', `本地文件读取失败，回退在线取链: ${track.title}`, {
            filePath: completedTask.filePath,
            error: localErr instanceof Error ? localErr.message : String(localErr),
          });
        }
      }
    }

    // 1.5 v16: 检查预加载缓存（命中则零等待取链）
    const cacheKey = `${track.sourceId}_${track.sourceSongId}_${quality}`;
    const prefetchHit = this.prefetchCache.get(cacheKey);
    if (prefetchHit) {
      debugLogger.info('player', `预加载缓存命中: ${track.title}`, {
        sourceId: track.sourceId,
        actualSourceId: prefetchHit.actualSourceId,
        quality,
        urlPrefix: prefetchHit.url.slice(0, 60),
      });
      return {
        url: prefetchHit.url,
        isLocal: false,
        result: prefetchHit.result,
        actualSourceId: prefetchHit.actualSourceId,
      };
    }

    // 2. 在线取链 —— v13: 多平台降级链
    const availableIds = (track.availableSources || []).map((s) => s.sourceId);
    const sourceSongIdMap = new Map<string, string>();
    for (const s of track.availableSources || []) {
      sourceSongIdMap.set(s.sourceId, s.sourceSongId);
    }
    // 兜底：保证首选源也能找到自己的 songId
    sourceSongIdMap.set(track.sourceId, track.sourceSongId);

    const rawChain = buildFallbackChain(track.sourceId, availableIds);
    // W2: 进链前过滤不健康/熔断中的源（跳过继续走链，不碰链序；过滤后为空回退原链防全员误判）
    const chain = sourceHealthChecker.filterChain(rawChain);
    const skippedByHealth = rawChain.filter((id) => !chain.includes(id));
    if (skippedByHealth.length > 0) {
      debugLogger.warn('player', `健康过滤跳过源: ${skippedByHealth.join(',')}`, {
        skipped: skippedByHealth,
        track: track.title,
      });
    }

    if (chain.length === 0) {
      throw new Error(`Source ${track.sourceId} not found and no fallback available`);
    }

    let lastError: unknown = null;
    for (let i = 0; i < chain.length; i++) {
      const trySourceId = chain[i];
      const source = sourceRegistry.get(trySourceId);
      if (!source) continue;
      if (!source.enabled) {
        continue;
      }
      const trySongId = sourceSongIdMap.get(trySourceId) || track.sourceSongId;

      try {
        const playUrl = await source.getPlayUrl(trySongId, quality, this.playAbortController?.signal);
        if (i > 0) {
          const fromName = PLATFORM_DISPLAY_NAMES[chain[i - 1]] || chain[i - 1];
          const toName = PLATFORM_DISPLAY_NAMES[trySourceId] || trySourceId;
          const reason = lastError instanceof Error ? lastError.message : '不可用';
          console.warn(
            `[PlayerEngine] Link fallback: ${chain[i - 1]} → ${trySourceId} (${reason})`
          );
          this.emit('linkFallback', {
            track,
            fromSourceId: chain[i - 1],
            toSourceId: trySourceId,
            reason,
          });
          toast.info(
            `已切换到 ${toName} 播放`,
            `${fromName} 取链失败（${reason}），已自动降级到 ${toName}`
          );
          debugLogger.warn('player', `取链降级: ${fromName} → ${toName}`, {
            track: track.title,
            from: chain[i - 1],
            to: trySourceId,
            reason,
          });
        }
        debugLogger.info('player', `在线取链成功: ${track.title}`, {
          sourceId: trySourceId,
          quality,
          format: playUrl.format,
        });
        // W2: 真实取链成功 → 立即清零探活计数并标 healthy（快速回归，防探活端点误判）
        sourceHealthChecker.reportSuccess(trySourceId);
        return { url: playUrl.url, isLocal: false, result: playUrl, actualSourceId: trySourceId };
      } catch (err) {
        lastError = err;
        console.warn(
          `[PlayerEngine] getPlayUrl failed on ${trySourceId}:`,
          err instanceof Error ? err.message : err
        );
        debugLogger.warn('player', `取链失败: ${trySourceId} · ${track.title}`, {
          sourceId: trySourceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    throw new Error(
      `All ${chain.length} sources failed for "${track.title}": ${
        lastError instanceof Error ? lastError.message : 'unknown'
      }`
    );
  }

  async playTrack(track: PlayerTrack, quality: Quality = Quality.STANDARD): Promise<PlayUrlResult> {
    // v24: 播放闸门入口 —— 去重判定在任何副作用（abort / 清流 / setState）之前同步完成。
    // 同 key（同曲同音质）进行中 → 直接复用该次播放的 Promise，不再重复触发取链；
    // 不同 key → 串行排队，前一条播放管线落定后才开始下一条，状态机不存在并发突变窗口
    // （修复：连点切歌时新请求的 reset 与旧流 load 并发赛跑，旧流回调事后把状态拉回 → 图标与实际播放不符）。
    const key = `${track.sourceId}_${track.sourceSongId}_${quality}`;
    const { reused, promise } = this.playGate.enter(key, () => this.doPlayTrack(track, quality));
    if (reused) {
      debugLogger.info('player', `播放去重命中: ${track.title}`, { key });
      return promise;
    }

    // 非复用的新请求：同步取消上一首的取链（旧管线被 abort 后快速落定，闸门立即放行本请求，
    // 串行排队不会拖慢切歌响应）。AbortController 在 doPlayTrack 任务内重新创建，
    // 避免多次排队请求共享同一个 signal 造成的误伤。
    if (this.playAbortController) {
      this.playAbortController.abort();
      debugLogger.info('player', `切歌取消旧取链: ${track.title}`);
    }

    // 以下同步副作用保持与旧版一致：UI 立即看到切歌意图（loading 态 + 通知栏更新）
    this.lastQuality = quality;
    this.currentTrack = track;
    this.setState('loading');
    this.setBuffering(false);
    this.prefetchTriggered = false;

    // 提前把 metadata 推到系统（用户切歌时立即更新通知）
    void updateMetadata({
      title: track.title,
      artist: track.artist ?? '',
      album: track.album ?? '',
      artwork: track.coverUrl,
    });

    return promise;
  }

  /**
   * v24: 实际播放管线，经 PlayGate 串行执行——同一时刻只有一条管线在跑。
   * 每条管线持有独立的 AbortController（v20.1-fix 快速切歌取消取链）与代际号
   * （v23：被更新请求取代的过期错误不再上报 UI）。
   */
  private async doPlayTrack(track: PlayerTrack, quality: Quality): Promise<PlayUrlResult> {
    // v23: 本次播放请求的代际号 —— 被更新的切歌取代后，其错误不再上报
    const generation = ++this.playGeneration;

    this.playAbortController = new AbortController();

    // v16: 切歌后立即预加载下一首
    this.schedulePrefetchNext();

    // 清理之前的 blob URL
    if (this.currentBlobUrl) {
      URL.revokeObjectURL(this.currentBlobUrl);
      this.currentBlobUrl = null;
    }

    // v14.4: 清理流式播放器状态
    if (this.isStreaming) {
      await streamingAudioPlayer.reset();
      this.isStreaming = false;
    }

    debugLogger.info('player', `开始播放: ${track.title}`, {
      artist: track.artist,
      sourceId: track.sourceId,
      quality,
    });

    try {
      const { url, isLocal, result, actualSourceId } = await this.resolvePlayUrl(track, quality);

      if (isLocal) {
        this.currentBlobUrl = url;
      }

      // v14.4: 在线播放且不是本地文件/已下载文件 → 使用流式播放
      // v21.3: 加密流通过 streamingAudioPlayer 的 decryptStream 路径解密后播放
      if (!isLocal && track.sourceId !== 'local') {
        await this.loadAndPlayStreaming(
          url,
          result.headers || {},
          track,
          result.format,
          actualSourceId,
          result.isEncrypted,
          result.decryptKey,
          result.ekey,
          result.z3dDecryptInfo
        );
      } else {
        await this.loadAndPlay(url, track);
      }

      this.emit('trackLoaded', { track, result, actualSourceId });

      // 记录播放历史（去重由 service 处理）
      playHistoryService.addRecord({
        songId: track.sourceSongId,
        title: track.title,
        artist: track.artist,
        source: track.sourceId,
        duration: track.duration,
      }).catch((err) => {
        console.error('[PlayerEngine] Failed to record play history:', err);
      });

      return result;
    } catch (err) {
      // v23: 过期播放请求（已被更新的切歌取代）不再进入 error 态 ——
      // 修复快速连点切歌时旧请求的 AbortError 误报"播放失败"
      if (generation !== this.playGeneration) {
        debugLogger.info('player', `忽略过期播放请求的错误: ${track.title}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      this.setState('error');
      const msg = err instanceof Error ? err.message : '播放失败';
      this.emit('error', { message: msg });
      debugLogger.error('player', `播放失败: ${track.title}`, {
        artist: track.artist,
        sourceId: track.sourceId,
        error: msg,
      });
      throw err;
    }
  }

  private async loadAndPlay(url: string, track: PlayerTrack): Promise<void> {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
    }

    this.audio = new Audio(url);
    this.audio.crossOrigin = 'anonymous';
    // v18 EQ：均衡器开启时挂接（内部自校验同源/运行态，失败自动直出）
    void eqService.attachElement(this.audio);

    this.audio.addEventListener('canplay', () => {
      // 标记为用户主动播放意图
      this.setState('playing', 'user');
      this.setBuffering(false);
      this.startProgressTracking();
    });

    this.audio.addEventListener('waiting', () => {
      // v23: 播放中数据不足进入缓冲
      if (this.state === 'playing') {
        this.setBuffering(true);
      }
    });

    this.audio.addEventListener('playing', () => {
      this.setBuffering(false);
    });

    this.audio.addEventListener('ended', () => {
      this.setState('idle', 'engine');
      this.stopProgressTracking();
      this.emit('ended', undefined);
      debugLogger.info('player', `播放结束: ${track.title}`);
    });

    this.audio.addEventListener('error', () => {
      this.setState('error', 'system');
      this.emit('error', { message: '音频加载失败' });
      debugLogger.error('player', `音频加载失败: ${track.title}`, {
        src: url.slice(0, 120),
      });
    });

    this.audio.addEventListener('pause', () => {
      // 区分用户主动暂停与系统焦点丢失
      if (this.state === 'playing') {
        this.setState('paused', 'system');
      }
    });

    this.audio.addEventListener('play', () => {
      if (this.state !== 'playing') {
        this.setState('playing', 'user');
      }
    });

    try {
      await this.audio.play();
    } catch (err) {
      // play() 可能因自动播放策略被拒绝
      this.setState('paused', 'system');
      this.emit('error', { message: '自动播放被阻止，请点击播放' });
      debugLogger.warn('player', '自动播放被阻止', {
        track: track.title,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // v14.4: 流式播放加载
  // v21: 支持 CENC 加密音频（汽水音乐）：若提供 decryptKey，先下载完整加密文件并解密后再播放
  // v21.1: 支持 QMC2 加密音频（酷我 mflac/mgg）：若提供 ekey，先下载完整加密文件并 QMC2 解密后再播放
  // v21.3: 新增 isEncrypted / decryptKey 支持 CENC 加密流（流式管道解密，替代全量下载）
  private async loadAndPlayStreaming(
    url: string,
    headers: Record<string, string>,
    track: PlayerTrack,
    format?: string,
    actualSourceId?: string,
    isEncrypted?: boolean,
    decryptKey?: string,
    ekey?: string,
    z3dDecryptInfo?: { z3dUrl: string; p3dUrl: string },
  ): Promise<void> {
    this.isStreaming = true;
    this.streamingCurrentUrl = url;
    this.streamingHeaders = headers;

    // v20.1-fix: 降级后缓存 key 用实际源，避免 kuwo 前缀残留导致缓存串读
    const cacheKey = `${actualSourceId || track.sourceId}_${track.sourceSongId}_${this.lastQuality}`;

    // v18 EQ：流式引擎每创建新 audio 元素时通知均衡器挂接
    streamingAudioPlayer.setAudioElementListener((el) => {
      void eqService.attachElement(el);
    });

    // v21.3: CENC 加密流式处理（汽水音乐 track.php）
    // 流式管道解密：fetch → decryptStream → Blob 刷新，支持长音频无损
    if (isEncrypted && decryptKey) {
      debugLogger.info('player', 'CENC 加密流，启动流式解密播放', {
        track: track.title,
        sourceId: actualSourceId || track.sourceId,
      });
      try {
        await streamingAudioPlayer.load({
          url,
          headers,
          cacheKey,
          format,
          isEncrypted,
          decryptKey,
        });
      } catch (err) {
        debugLogger.error('player', 'CENC 流式解密播放失败', {
          track: track.title,
          error: err instanceof Error ? err.message : String(err),
        });
        throw new Error(
          `CENC 流式解密播放失败: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // 设置回调
      streamingAudioPlayer.setCallbacks(this.buildStreamingCallbacks(track));
      return;
    }

    // v21.4: 咪咕 Z3D 加密流式播放
    if (z3dDecryptInfo) {
      debugLogger.info('player', 'Z3D 加密流，启动流式解密播放', {
        track: track.title,
        sourceId: actualSourceId || track.sourceId,
      });
      try {
        await streamingAudioPlayer.load({
          url,
          headers,
          cacheKey,
          format,
          z3dDecryptInfo,
        });
      } catch (err) {
        debugLogger.error('player', 'Z3D 流式解密播放失败', {
          track: track.title,
          error: err instanceof Error ? err.message : String(err),
        });
        throw new Error(
          `Z3D 流式解密播放失败: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // v23: 统一使用 buildStreamingCallbacks（含缓冲状态上报），避免两套映射漂移
      streamingAudioPlayer.setCallbacks(this.buildStreamingCallbacks(track));
      return;
    }

    // v21: CENC 加密音频处理（全量下载解密，向后兼容非 isEncrypted 源）
    if (decryptKey) {
      debugLogger.info('player', 'CENC 加密音频，开始下载并解密', {
        track: track.title,
        sourceId: actualSourceId || track.sourceId,
      });
      try {
        const resp = await platformFetch(url, { headers });
        if (!resp.ok) {
          throw new Error(`CENC 音频下载失败: ${resp.status}`);
        }
        const encryptedData = await resp.arrayBuffer();
        debugLogger.info('player', 'CENC 音频下载完成，开始解密', {
          track: track.title,
          size: encryptedData.byteLength,
        });

        const decrypted = await decryptCencMp4(encryptedData, decryptKey);
        debugLogger.info('player', 'CENC 解密完成', {
          track: track.title,
          format: decrypted.format,
          size: decrypted.data.length,
        });

        await streamingAudioPlayer.loadDecryptedData(decrypted.data, {
          cacheKey,
          format: decrypted.format,
        });

        // 设置回调（loadDecryptedData 不经过流式下载，但仍需状态回调）
        streamingAudioPlayer.setCallbacks(this.buildStreamingCallbacks(track));
        return;
      } catch (cencErr) {
        debugLogger.error('player', 'CENC 解密播放失败', {
          track: track.title,
          error: cencErr instanceof Error ? cencErr.message : String(cencErr),
        });
        throw new Error(
          `CENC 解密播放失败: ${cencErr instanceof Error ? cencErr.message : String(cencErr)}`
        );
      }
    }

    // v21.1: QMC2 加密音频处理（酷我 mflac/mgg）
    if (ekey) {
      debugLogger.info('player', 'QMC2 加密音频，开始下载并解密', {
        track: track.title,
        sourceId: actualSourceId || track.sourceId,
        format,
      });
      try {
        const resp = await platformFetch(url, { headers });
        if (!resp.ok) {
          throw new Error(`QMC2 音频下载失败: ${resp.status}`);
        }
        const encryptedData = new Uint8Array(await resp.arrayBuffer());
        debugLogger.info('player', 'QMC2 音频下载完成，开始解密', {
          track: track.title,
          size: encryptedData.byteLength,
        });

        const rawKey = deriveRawKey(ekey);
        if (!rawKey) {
          throw new Error('QMC2 ekey 派生密钥失败');
        }

        const decrypted = qmc2DecryptBytes(encryptedData, rawKey);
        debugLogger.info('player', 'QMC2 解密完成', {
          track: track.title,
          size: decrypted.length,
        });

        // 验证解密后魔数（必须为合法 flac/ogg）
        if (!isDecryptedMagic(decrypted)) {
          throw new Error('QMC2 解密后魔数校验失败，数据可能未正确解密');
        }

        // mflac → flac, mgg → ogg
        const decryptedFormat = format === 'mgg' || url.endsWith('.mgg') ? 'ogg' : 'flac';

        await streamingAudioPlayer.loadDecryptedData(decrypted, {
          cacheKey,
          format: decryptedFormat,
        });

        // 设置回调（loadDecryptedData 不经过流式下载，但仍需状态回调）
        streamingAudioPlayer.setCallbacks(this.buildStreamingCallbacks(track));
        return;
      } catch (qmc2Err) {
        debugLogger.error('player', 'QMC2 解密播放失败', {
          track: track.title,
          error: qmc2Err instanceof Error ? qmc2Err.message : String(qmc2Err),
        });
        throw new Error(
          `QMC2 解密播放失败: ${qmc2Err instanceof Error ? qmc2Err.message : String(qmc2Err)}`
        );
      }
    }

    // 设置流式播放器回调
    streamingAudioPlayer.setCallbacks(this.buildStreamingCallbacks(track));

    await streamingAudioPlayer.load({
      url,
      headers,
      cacheKey,
      format,
      isEncrypted,
      decryptKey,
    });
  }

  // v16: 调度预加载下一首（防抖，避免频繁触发）
  private prefetchTimer: number | null = null;
  private schedulePrefetchNext(): void {
    if (this.prefetchTimer) {
      clearTimeout(this.prefetchTimer);
    }
    this.prefetchTimer = window.setTimeout(() => {
      void this.prefetchNextTrack();
    }, 800);
  }

  // v16: 增强预取下一首（流式+非流式统一，存入预加载缓存）
  private async prefetchNextTrack(): Promise<void> {
    const nextIndex = this.currentIndex + 1;
    if (nextIndex < 0 || nextIndex >= this.queue.length) return;

    const nextTrack = this.queue[nextIndex];
    if (!nextTrack || nextTrack.sourceId === 'local') return;

    const cacheKey = `${nextTrack.sourceId}_${nextTrack.sourceSongId}_${this.lastQuality}`;

    // 已预加载过，跳过
    if (this.prefetchCache.has(cacheKey)) return;

    debugLogger.info('player', 'v16 预加载下一首', {
      title: nextTrack.title,
      index: nextIndex,
      sourceId: nextTrack.sourceId,
      quality: this.lastQuality,
    });

    try {
      // 取链下一首（按优先级 酷我>咪咕>网易云>酷狗>QQ）
      const { url, result, actualSourceId } = await this.resolvePlayUrl(nextTrack, this.lastQuality);

      // 存入预加载缓存（key 保持 track.sourceId 用于去重查询）
      this.prefetchCache.set(cacheKey, { url, result, actualSourceId });
      debugLogger.info('player', 'v16 预加载成功', {
        title: nextTrack.title,
        cacheKey,
        actualSourceId,
        urlPrefix: url.slice(0, 60),
      });

      // 流式模式下同时预取首块数据
      // v21.3: 加密流不支持 Range 预取，跳过流式首块预取（prefetchCache 已存储 URL+decryptKey）
      // v21.4: Z3D 同样需要密钥提取，跳过 Range 预取
      if (nextTrack.sourceId !== 'local' && !result.isEncrypted && !result.z3dDecryptInfo) {
        try {
          // v20.1-fix: 流式缓存 key 用 actualSourceId，避免降级后缓存串读
          const streamCacheKey = `${actualSourceId}_${nextTrack.sourceSongId}_${this.lastQuality}`;
          await streamingAudioPlayer.prefetchNext({
            url,
            headers: result.headers || {},
            cacheKey: streamCacheKey,
            format: result.format,
          });
        } catch (streamErr) {
          debugLogger.warn('player', 'v16 流式首块预取失败（不影响缓存）', {
            title: nextTrack.title,
            error: streamErr instanceof Error ? streamErr.message : String(streamErr),
          });
        }
      }
    } catch (err) {
      debugLogger.warn('player', 'v16 预加载失败', {
        title: nextTrack.title,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * v22: 统一构建流式播放回调（4 处注册点共用，避免状态映射漂移）
   * - playing → 引擎 playing（user 来源，保留播放意图）
   * - paused  → 来源由 systemPausePending 决定：焦点丢失/耳机拔出等系统暂停
   *   标记为 system，保证音频焦点模块的自动续播判定在流式路径同样生效
   */
  private buildStreamingCallbacks(track: PlayerTrack): StreamingCallbacks {
    return {
      onStateChange: (streamState: StreamingState) => {
        const stateMap: Record<StreamingState, PlayerState> = {
          idle: 'idle',
          loading: 'loading',
          ready: 'loading',
          playing: 'playing',
          paused: 'paused',
          buffering: 'loading',
          seeking: 'loading',
          completed: 'idle',
          error: 'error',
        };
        const mapped = stateMap[streamState];
        if (mapped && mapped !== this.state) {
          let source: 'user' | 'system' | 'engine' = 'engine';
          if (streamState === 'playing') {
            source = 'user';
          } else if (streamState === 'paused' && this.systemPausePending) {
            source = 'system';
          }
          this.setState(mapped, source);
        }
        // v23: 广播缓冲状态（buffering/seeking → UI 显示缓冲指示器）
        this.setBuffering(streamState === 'buffering' || streamState === 'seeking');
      },
      onProgress: (currentTime: number, duration: number) => {
        this.emit('progress', {
          currentTime,
          duration,
          progress: duration > 0 ? currentTime / duration : 0,
        });
        void updatePosition(currentTime, duration);

        // 播放过半时预取下一首
        if (duration > 0 && currentTime / duration > 0.5 && !this.prefetchTriggered) {
          this.prefetchTriggered = true;
          void this.prefetchNextTrack();
        }
      },
      onError: (message: string) => {
        this.setState('error', 'system');
        this.emit('error', { message });
        debugLogger.error('player', `流式播放错误: ${track.title}`, { message });
      },
      onEnded: () => {
        this.setState('idle', 'engine');
        this.stopProgressTracking();
        this.emit('ended', undefined);
        debugLogger.info('player', `流式播放结束: ${track.title}`);
      },
      onCanPlay: () => {
        this.setState('playing', 'user');
        this.startProgressTracking();
      },
    };
  }

  pause(): void {
    if (this.isStreaming) {
      streamingAudioPlayer.pause();
    } else {
      this.audio?.pause();
    }
    this.setState('paused', 'user');
    this.setBuffering(false);
    this.stopProgressTracking();
    debugLogger.info('player', '用户暂停播放', {
      track: this.currentTrack?.title,
    });
  }

  /**
   * v20：系统原因导致的暂停（音频焦点丢失 / 耳机拔出）。
   * 与用户主动暂停的区别：不改写用户播放意图，焦点恢复后可自动续播。
   */
  pauseBySystem(): void {
    const wasPlaying = this.state === 'playing' || this.state === 'loading';
    if (this.isStreaming) {
      // 流式路径：streamingAudioPlayer.pause() 会同步触发 onStateChange 回调，
      // 用 systemPausePending 让回调把这次暂停标记为 system 来源
      if (wasPlaying) {
        this.systemPausePending = true;
      }
      streamingAudioPlayer.pause();
      this.systemPausePending = false;
    } else if (this.audio) {
      this.audio.pause();
    }
    // HTMLAudio 路径：pause 事件为异步派发，这里同步补记系统暂停；
    // 流式路径若回调已按 system 来源落状态，此处自动跳过
    if (wasPlaying && this.state !== 'paused') {
      this.setState('paused', 'system');
    }
    this.stopProgressTracking();
    debugLogger.info('player', '系统原因暂停播放（焦点/耳机）', {
      track: this.currentTrack?.title,
    });
  }

  resume(): void {
    if (this.isStreaming) {
      void streamingAudioPlayer.play();
    } else {
      this.audio?.play().catch((err) => {
        if (this.state === 'playing') {
          this.setState('paused', 'system');
        }
        debugLogger.warn('player', '恢复播放失败', {
          track: this.currentTrack?.title,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    if (this.state !== 'playing') {
      this.setState('playing', 'user');
      this.startProgressTracking();
    }
    debugLogger.info('player', '用户恢复播放', {
      track: this.currentTrack?.title,
    });
  }

  stop(): void {
    if (this.isStreaming) {
      void streamingAudioPlayer.reset();
      this.isStreaming = false;
    }
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
    }
    this.setState('idle', 'user');
    this.setBuffering(false);
    this.stopProgressTracking();
    void clearMediaSession();
    debugLogger.info('player', '用户停止播放', {
      track: this.currentTrack?.title,
    });
  }

  seek(time: number): void {
    if (this.isStreaming) {
      void streamingAudioPlayer.seek(time);
    } else if (this.audio) {
      // v23: duration 为 NaN/0（元数据未就绪）时不做截断，避免 seek 被钳到 0
      const duration = this.audio.duration;
      const target =
        isFinite(duration) && duration > 0
          ? Math.max(0, Math.min(time, duration))
          : Math.max(0, time);
      try {
        this.audio.currentTime = target;
      } catch (err) {
        debugLogger.warn('player', 'seek 失败', {
          time,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * v23: 播放失败后重试当前曲目（UI"播放失败，点击重试"入口）
   */
  async retry(): Promise<PlayUrlResult | null> {
    if (!this.currentTrack) return null;
    debugLogger.info('player', `重试播放: ${this.currentTrack.title}`);
    return await this.playTrack(this.currentTrack, this.lastQuality);
  }

  setVolume(volume: number): void {
    const v = Math.max(0, Math.min(1, volume));
    if (this.isStreaming) {
      streamingAudioPlayer.setVolume(v);
    }
    if (this.audio) {
      this.audio.volume = v;
    }
  }

  getVolume(): number {
    return this.audio?.volume ?? 1;
  }

  getCurrentTime(): number {
    if (this.isStreaming) {
      return streamingAudioPlayer.getCurrentTime();
    }
    return this.audio?.currentTime ?? 0;
  }

  getDuration(): number {
    if (this.isStreaming) {
      return streamingAudioPlayer.getDuration();
    }
    return this.audio?.duration ?? 0;
  }

  // === 队列控制（兼容 v10 调用方）===
  setQueue(queue: PlayerTrack[], index: number = -1): void {
    this.queue = queue;
    this.currentIndex = index;
  }

  async playNext(): Promise<void> {
    // v23: 切歌防抖锁 —— 切歌过程中再次点击无效（修复快速连点导致的跳歌/误报）
    if (this.switchInProgress) {
      debugLogger.info('player', '切歌进行中，忽略本次下一首请求');
      return;
    }
    this.switchInProgress = true;
    try {
      await this.playNextInternal();
    } finally {
      this.switchInProgress = false;
    }
  }

  private async playNextInternal(): Promise<void> {
    const store = (await import('../../shared/store/playerStore')).usePlayerStore.getState();
    const { queue, currentIndex, repeatMode } = store;
    if (queue.length === 0) {
      this.stop();
      return;
    }

    let nextIndex: number;
    switch (repeatMode) {
      case 'repeat-one':
        nextIndex = currentIndex;
        break;
      case 'shuffle': {
        // 随机选一首不同于当前的（如果队列长度>1）
        if (queue.length > 1) {
          do {
            nextIndex = Math.floor(Math.random() * queue.length);
          } while (nextIndex === currentIndex);
        } else {
          nextIndex = currentIndex;
        }
        break;
      }
      case 'repeat-all':
        nextIndex = currentIndex + 1;
        if (nextIndex >= queue.length) nextIndex = 0;
        break;
      case 'sequence':
      default:
        nextIndex = currentIndex + 1;
        if (nextIndex >= queue.length) {
          this.stop();
          return;
        }
        break;
    }

    // 同步到 store 和 engine
    this.currentIndex = nextIndex;
    store.playTrackAtIndex(nextIndex);
    try {
      await this.playTrack(queue[nextIndex], this.lastQuality);
    } catch {
      // 错误已由 error 事件上报
    }
  }

  async playPrevious(): Promise<void> {
    // v23: 切歌防抖锁（与 playNext 一致）
    if (this.switchInProgress) {
      debugLogger.info('player', '切歌进行中，忽略本次上一首请求');
      return;
    }
    this.switchInProgress = true;
    try {
      await this.playPreviousInternal();
    } finally {
      this.switchInProgress = false;
    }
  }

  private async playPreviousInternal(): Promise<void> {
    const store = (await import('../../shared/store/playerStore')).usePlayerStore.getState();
    const { queue, currentIndex, repeatMode } = store;
    if (queue.length === 0) return;

    // 播放进度超过 3 秒时，先回到开头
    const currentTime = this.getCurrentTime();
    if (currentTime > 3 && repeatMode !== 'shuffle') {
      this.seek(0);
      return;
    }

    let prevIndex: number;
    switch (repeatMode) {
      case 'repeat-one':
        prevIndex = currentIndex;
        break;
      case 'shuffle': {
        if (queue.length > 1) {
          do {
            prevIndex = Math.floor(Math.random() * queue.length);
          } while (prevIndex === currentIndex);
        } else {
          prevIndex = currentIndex;
        }
        break;
      }
      case 'repeat-all':
        prevIndex = currentIndex - 1;
        if (prevIndex < 0) prevIndex = queue.length - 1;
        break;
      case 'sequence':
      default:
        prevIndex = currentIndex - 1;
        if (prevIndex < 0) {
          this.seek(0);
          return;
        }
        break;
    }

    this.currentIndex = prevIndex;
    store.playTrackAtIndex(prevIndex);
    try {
      await this.playTrack(queue[prevIndex], this.lastQuality);
    } catch {
      // 错误已由 error 事件上报
    }
  }

  /** 切换音质：对当前曲目重新取链并接续播放进度（v23: 成功/失败均给 toast 反馈） */
  async switchQuality(quality: Quality): Promise<PlayUrlResult | null> {
    if (!this.currentTrack) return null;

    // 本地歌曲不支持音质切换
    if (this.currentTrack.sourceId === 'local') {
      return null;
    }

    const track = this.currentTrack;
    const resumeTime = this.getCurrentTime();

    debugLogger.info('player', `切换音质: ${track.title} → ${quality}`, {
      fromQuality: this.lastQuality,
      toQuality: quality,
    });

    try {
      const result = await this.playTrack(track, quality);

      if (resumeTime > 0) {
        try {
          this.seek(Math.min(resumeTime, this.getDuration() || resumeTime));
        } catch {
          // seek 失败不影响播放
        }
      }

      toast.success('音质切换成功', `当前曲目已按新音质重新加载，进度已接续`);
      return result;
    } catch (err) {
      toast.error('音质切换失败', '该音源可能未提供所选档位，请尝试其他档位');
      throw err;
    }
  }

  private startProgressTracking() {
    this.stopProgressTracking();
    this.progressInterval = window.setInterval(() => {
      if (this.audio) {
        const currentTime = this.audio.currentTime;
        const duration = this.audio.duration || 1;
        this.emit('progress', {
          currentTime,
          duration,
          progress: currentTime / duration,
        });
        // 同步到系统媒体会话（内部有节流）
        void updatePosition(currentTime, duration);

        // v23: 非流式路径（本地/已下载文件）也触发下一首预加载，
        // 此前预加载只挂在流式回调上，本地路径切歌永远无预加载
        if (
          !this.isStreaming &&
          duration > 0 &&
          currentTime / duration > 0.5 &&
          !this.prefetchTriggered
        ) {
          this.prefetchTriggered = true;
          void this.prefetchNextTrack();
        }
      }
    }, 250);
  }

  private stopProgressTracking() {
    if (this.progressInterval !== null) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
  }
}

export const playerEngine = new PlayerEngine();

// v18 EQ：向均衡器注册「当前活跃 audio 元素」提供者（流式/普通两条路径统一）
eqService.setElementProvider(() => playerEngine.getActiveAudioElement());
