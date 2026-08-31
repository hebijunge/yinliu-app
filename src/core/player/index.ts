import type { PlayUrlResult } from '@core/types';
import { Quality } from '@core/types';
import { sourceRegistry } from '@providers/music/registry';
import { downloadEngine } from '@core/download';
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
  stopPositionSync,
  clearMediaSession,
} from './mediaSession';
import { notifyPlaybackStateChange } from './audioFocus';
import { playHistoryService } from '@shared/services/PlayHistoryService';
import { debugLogger } from '@shared/utils/debugLogger';
import { streamCache } from './streamCache';
import { Capacitor } from '@capacitor/core';

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

  // Queue state (兼容 v10 调用方)
  queue: PlayerTrack[] = [];
  currentIndex: number = -1;
  lastQuality: Quality = Quality.STANDARD;

  private emit<K extends keyof PlayerEventMap>(event: K, data: PlayerEventMap[K]) {
    const callbacks = this.listeners[event] || [];
    callbacks.forEach((cb) => cb(data as unknown));
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
  }

  getState(): PlayerState {
    return this.state;
  }

  getCurrentTrack(): PlayerTrack | null {
    return this.currentTrack;
  }

  // === 统一 URL 解析器：本地歌曲 → 已下载本地文件 → 在线取链（带优先级降级链） ===
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

    // 2. 在线取链 —— v13: 多平台降级链
    const availableIds = (track.availableSources || []).map((s) => s.sourceId);
    const sourceSongIdMap = new Map<string, string>();
    for (const s of track.availableSources || []) {
      sourceSongIdMap.set(s.sourceId, s.sourceSongId);
    }
    // 兜底：保证首选源也能找到自己的 songId
    sourceSongIdMap.set(track.sourceId, track.sourceSongId);

    const chain = buildFallbackChain(track.sourceId, availableIds);

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
        const playUrl = await source.getPlayUrl(trySongId, quality);
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

        // 原生平台：绕过 WebView 防盗链，先缓存再播放
        if (Capacitor.isNativePlatform()) {
          try {
            const cachedUrl = await streamCache.fetchAndCache(
              playUrl.url,
              trySourceId,
              trySongId,
              quality,
              playUrl.format,
              playUrl.headers
            );
            return {
              url: cachedUrl,
              isLocal: true,
              result: playUrl,
              actualSourceId: trySourceId,
            };
          } catch (cacheErr) {
            const cacheErrMsg = cacheErr instanceof Error ? cacheErr.message : String(cacheErr);
            debugLogger.warn('player', `streamCache 失败，回退 CDN 直链: ${track.title}`, {
              sourceId: trySourceId,
              error: cacheErrMsg,
            });
            // 回退到 CDN 直链（在 WebView 中可能仍失败，但保留原行为）
            return { url: playUrl.url, isLocal: false, result: playUrl, actualSourceId: trySourceId };
          }
        }

        // Web / Tauri：CDN 直链通常可用
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
    this.lastQuality = quality;
    this.setState('loading');
    this.currentTrack = track;

    // 提前把 metadata 推到系统（用户切歌时立即更新通知）
    void updateMetadata({
      title: track.title,
      artist: track.artist ?? '',
      album: track.album ?? '',
      artwork: track.coverUrl,
    });

    // 清理之前的 blob URL
    if (this.currentBlobUrl) {
      URL.revokeObjectURL(this.currentBlobUrl);
      this.currentBlobUrl = null;
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

      await this.loadAndPlay(url, track);
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

    this.audio.addEventListener('canplay', () => {
      // 标记为用户主动播放意图
      this.setState('playing', 'user');
      this.startProgressTracking();
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

  pause(): void {
    this.audio?.pause();
    this.setState('paused', 'user');
    this.stopProgressTracking();
    debugLogger.info('player', '用户暂停播放', {
      track: this.currentTrack?.title,
    });
  }

  resume(): void {
    this.audio?.play();
    debugLogger.info('player', '用户恢复播放', {
      track: this.currentTrack?.title,
    });
  }

  stop(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
    }
    this.setState('idle', 'user');
    this.stopProgressTracking();
    void clearMediaSession();
    debugLogger.info('player', '用户停止播放', {
      track: this.currentTrack?.title,
    });
  }

  seek(time: number): void {
    if (this.audio) {
      this.audio.currentTime = Math.max(0, Math.min(time, this.audio.duration || 0));
    }
  }

  setVolume(volume: number): void {
    if (this.audio) {
      this.audio.volume = Math.max(0, Math.min(1, volume));
    }
  }

  getVolume(): number {
    return this.audio?.volume ?? 1;
  }

  getCurrentTime(): number {
    return this.audio?.currentTime ?? 0;
  }

  getDuration(): number {
    return this.audio?.duration ?? 0;
  }

  // === 队列控制（兼容 v10 调用方）===
  setQueue(queue: PlayerTrack[], index: number = -1): void {
    this.queue = queue;
    this.currentIndex = index;
  }

  async playNext(): Promise<void> {
    const nextIndex = this.currentIndex + 1;
    if (nextIndex >= 0 && nextIndex < this.queue.length) {
      this.currentIndex = nextIndex;
      try {
        await this.playTrack(this.queue[nextIndex], this.lastQuality);
      } catch {
        // 错误已由 error 事件上报
      }
    } else {
      this.stop();
    }
  }

  async playPrevious(): Promise<void> {
    if (this.audio && this.audio.currentTime > 3) {
      this.seek(0);
      return;
    }
    const prevIndex = this.currentIndex - 1;
    if (prevIndex >= 0 && prevIndex < this.queue.length) {
      this.currentIndex = prevIndex;
      try {
        await this.playTrack(this.queue[prevIndex], this.lastQuality);
      } catch {
        // 错误已由 error 事件上报
      }
    }
  }

  /** 切换音质：对当前曲目重新取链并接续播放进度 */
  async switchQuality(quality: Quality): Promise<PlayUrlResult | null> {
    if (!this.currentTrack) return null;

    // 本地歌曲不支持音质切换
    if (this.currentTrack.sourceId === 'local') {
      return null;
    }

    const track = this.currentTrack;
    const resumeTime = this.audio?.currentTime ?? 0;

    debugLogger.info('player', `切换音质: ${track.title} → ${quality}`, {
      fromQuality: this.lastQuality,
      toQuality: quality,
    });

    const result = await this.playTrack(track, quality);

    if (resumeTime > 0 && this.audio) {
      try {
        this.audio.currentTime = Math.min(resumeTime, this.audio.duration || resumeTime);
      } catch {
        // seek 失败不影响播放
      }
    }

    return result;
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
