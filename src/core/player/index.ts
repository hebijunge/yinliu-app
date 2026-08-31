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
}

export class PlayerEngine {
  private audio: HTMLAudioElement | null = null;
  private currentTrack: PlayerTrack | null = null;
  private state: PlayerState = 'idle';
  private listeners: Record<string, Array<(data: unknown) => void>> = {};
  private progressInterval: number | null = null;
  private currentBlobUrl: string | null = null;

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

  private setState(state: PlayerState) {
    this.state = state;
    this.emit('stateChange', { state, track: this.currentTrack || undefined });
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
          return {
            url: localUrl,
            isLocal: true,
            result: { url: localUrl, quality, bitrate: 0, format: 'mp3' },
            actualSourceId: track.sourceId,
          };
        } catch (localErr) {
          console.warn('[PlayerEngine] Local file read failed, falling back to online:', localErr);
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
        }
        return { url: playUrl.url, isLocal: false, result: playUrl, actualSourceId: trySourceId };
      } catch (err) {
        lastError = err;
        console.warn(
          `[PlayerEngine] getPlayUrl failed on ${trySourceId}:`,
          err instanceof Error ? err.message : err
        );
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

    // 清理之前的 blob URL
    if (this.currentBlobUrl) {
      URL.revokeObjectURL(this.currentBlobUrl);
      this.currentBlobUrl = null;
    }

    try {
      const { url, isLocal, result, actualSourceId } = await this.resolvePlayUrl(track, quality);

      if (isLocal) {
        this.currentBlobUrl = url;
      }

      await this.loadAndPlay(url, track);
      this.emit('trackLoaded', { track, result, actualSourceId });
      return result;
    } catch (err) {
      this.setState('error');
      const msg = err instanceof Error ? err.message : '播放失败';
      this.emit('error', { message: msg });
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
      this.setState('playing');
      this.startProgressTracking();
    });

    this.audio.addEventListener('ended', () => {
      this.setState('idle');
      this.stopProgressTracking();
      this.emit('ended', undefined);
    });

    this.audio.addEventListener('error', () => {
      this.setState('error');
      this.emit('error', { message: '音频加载失败' });
    });

    this.audio.addEventListener('pause', () => {
      if (this.state === 'playing') {
        this.setState('paused');
      }
    });

    this.audio.addEventListener('play', () => {
      if (this.state !== 'playing') {
        this.setState('playing');
      }
    });

    await this.audio.play();
  }

  pause(): void {
    this.audio?.pause();
    this.setState('paused');
    this.stopProgressTracking();
  }

  resume(): void {
    this.audio?.play();
  }

  stop(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
    }
    this.setState('idle');
    this.stopProgressTracking();
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
