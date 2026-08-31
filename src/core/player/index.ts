import type { PlayUrlResult } from '@core/types';
import { Quality } from '@core/types';
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
}

interface PlayerEventMap {
  stateChange: { state: PlayerState; track?: PlayerTrack };
  progress: { currentTime: number; duration: number; progress: number };
  error: { message: string };
  ended: void;
}

export class PlayerEngine {
  private audio: HTMLAudioElement | null = null;
  private currentTrack: PlayerTrack | null = null;
  private state: PlayerState = 'idle';
  private listeners: Record<string, Array<(data: unknown) => void>> = {};
  private progressInterval: number | null = null;
  private currentBlobUrl: string | null = null;

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

  // === 统一 URL 解析器：本地文件优先，否则在线取链 ===
  private async resolvePlayUrl(track: PlayerTrack, quality: Quality): Promise<{ url: string; isLocal: boolean }> {
    // 1. 先检查是否有已下载的本地文件
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
        const localUrl = await downloadEngine.readLocalFileAsUrl(completedTask.filePath);
        console.log('[PlayerEngine] Playing from local file:', completedTask.filePath);
        return { url: localUrl, isLocal: true };
      }
    }

    // 2. 本地不存在，走在线取链
    const source = sourceRegistry.get(track.sourceId);
    if (!source) {
      throw new Error(`Source ${track.sourceId} not found`);
    }

    let playUrl: PlayUrlResult;
    try {
      playUrl = await source.getPlayUrl(track.sourceSongId, quality);
    } catch {
      // Fallback to Kuwo
      const kuwo = sourceRegistry.get('kuwo');
      if (kuwo && source.id !== 'kuwo') {
        playUrl = await kuwo.getPlayUrl(track.sourceSongId, quality);
      } else {
        throw new Error('Failed to get play URL');
      }
    }

    return { url: playUrl.url, isLocal: false };
  }

  async playTrack(track: PlayerTrack, quality: Quality = Quality.STANDARD): Promise<void> {
    this.setState('loading');
    this.currentTrack = track;

    // 清理之前的 blob URL
    if (this.currentBlobUrl) {
      URL.revokeObjectURL(this.currentBlobUrl);
      this.currentBlobUrl = null;
    }

    try {
      const { url, isLocal } = await this.resolvePlayUrl(track, quality);

      if (isLocal) {
        this.currentBlobUrl = url;
      }

      await this.loadAndPlay(url, track);
    } catch (err) {
      this.setState('error');
      this.emit('error', { message: err instanceof Error ? err.message : '播放失败' });
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
