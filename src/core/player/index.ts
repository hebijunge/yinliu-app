import type { PlayUrlResult } from '@core/types';
import { Quality, getSourcePriority } from '@core/types';
import { sourceRegistry } from '@providers/music/registry';
import { downloadEngine } from '@core/download';

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
  /** 多源降级候选（聚合结果有多源时使用），已按优先级排序 */
  fallbackSources?: Array<{ sourceId: string; sourceSongId: string }>;
}

interface PlayerEventMap {
  stateChange: { state: PlayerState; track?: PlayerTrack };
  progress: { currentTime: number; duration: number; progress: number };
  error: { message: string };
  ended: void;
  /** 取链完成（含实际音质/试听标记），UI 据此回写 actualQuality */
  trackLoaded: { track: PlayerTrack; result: PlayUrlResult; actualSourceId?: string };
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

  // === 统一 URL 解析器：本地文件优先 → 多源降级取链 ===
  private async resolvePlayUrl(
    track: PlayerTrack,
    quality: Quality
  ): Promise<{ url: string; isLocal: boolean; result: PlayUrlResult; actualSourceId: string }> {
    // 1. 先检查是否有已下载的本地文件（仍优先直接播本地）
    try {
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
          // readLocalFileAsUrl 失败时降级到在线取链（不阻断在线分支）
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
            // 降级到在线取链
          }
        }
      }
    } catch (err) {
      // 本地检查任意异常不应阻断在线播放
      console.warn('[PlayerEngine] Local file check failed, falling back to online:', err);
    }

    // 2. 构建候选源列表：当前源优先，fallbackSources 按优先级已排序
    const candidates: Array<{ sourceId: string; sourceSongId: string }> = [
      { sourceId: track.sourceId, sourceSongId: track.sourceSongId },
      ...(track.fallbackSources || []).filter((f) => f.sourceId !== track.sourceId),
    ];

    const errors: string[] = [];

    // 3. 按优先级逐一尝试取链
    for (const candidate of candidates) {
      const source = sourceRegistry.get(candidate.sourceId);
      if (!source) {
        errors.push(`${candidate.sourceId}: 音源未注册`);
        continue;
      }
      try {
        const playUrl = await source.getPlayUrl(candidate.sourceSongId, quality);
        console.log('[PlayerEngine] Play URL resolved from', candidate.sourceId);
        return {
          url: playUrl.url,
          isLocal: false,
          result: playUrl,
          actualSourceId: candidate.sourceId,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${candidate.sourceId}: ${msg}`);
        console.warn(`[PlayerEngine] Source ${candidate.sourceId} failed for "${track.title}": ${msg}`);
        // 继续尝试下一个候选源
      }
    }

    // 4. 全部失败：抛出聚合错误，不允许静默无响应
    throw new Error(`取链失败 — ${errors.join('；')}`);
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
      this.emit('error', { message: err instanceof Error ? err.message : '播放失败' });
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
