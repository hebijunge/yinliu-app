import { Quality } from '@core/types';
import type { PlayUrlResult } from '@core/types';
import { sourceRegistry } from '@providers/music/registry';
import type { RepeatMode } from '@shared/store/playerStore';

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
  stateChange: { state: PlayerState; track?: PlayerTrack; index?: number };
  progress: { currentTime: number; duration: number; progress: number };
  error: { message: string };
  ended: void;
}

type PlayerEventCallback<T> = (data: T) => void;

export class PlayerEngine {
  private audio: HTMLAudioElement | null = null;
  private currentTrack: PlayerTrack | null = null;
  private state: PlayerState = 'idle';
  private listeners: { [K in keyof PlayerEventMap]?: Array<PlayerEventCallback<PlayerEventMap[keyof PlayerEventMap]>> } = {};
  private progressInterval: number | null = null;

  // Queue state
  queue: PlayerTrack[] = [];
  currentIndex: number = -1;
  repeatMode: RepeatMode = 'sequence';
  shuffledIndices: number[] = [];
  lastQuality: Quality = Quality.STANDARD;

  private emit<K extends keyof PlayerEventMap>(event: K, data: PlayerEventMap[K]) {
    const callbacks = (this.listeners[event] || []) as Array<PlayerEventCallback<PlayerEventMap[K]>>;
    callbacks.forEach((cb) => cb(data));
  }

  on<K extends keyof PlayerEventMap>(event: K, callback: PlayerEventCallback<PlayerEventMap[K]>): () => void {
    if (!this.listeners[event]) this.listeners[event] = [];
    (this.listeners[event] as Array<PlayerEventCallback<PlayerEventMap[K]>>).push(callback);
    return () => {
      this.listeners[event] = (this.listeners[event] || []).filter((cb) => cb !== callback);
    };
  }

  private setState(state: PlayerState) {
    this.state = state;
    this.emit('stateChange', { state, track: this.currentTrack || undefined, index: this.currentIndex });
  }

  getState(): PlayerState {
    return this.state;
  }

  getCurrentTrack(): PlayerTrack | null {
    return this.currentTrack;
  }

  setQueue(queue: PlayerTrack[], index: number = -1): void {
    this.queue = queue;
    this.currentIndex = index;
    this.updateShuffleIndices();
  }

  setRepeatMode(mode: RepeatMode): void {
    this.repeatMode = mode;
    this.updateShuffleIndices();
  }

  private updateShuffleIndices(): void {
    if (this.repeatMode === 'shuffle') {
      this.shuffledIndices = this.fisherYatesShuffle([...Array(this.queue.length).keys()]);
      // Ensure current index is first if valid
      if (this.currentIndex >= 0 && this.shuffledIndices.length > 0) {
        const currentPos = this.shuffledIndices.indexOf(this.currentIndex);
        if (currentPos > 0) {
          [this.shuffledIndices[0], this.shuffledIndices[currentPos]] = [this.shuffledIndices[currentPos], this.shuffledIndices[0]];
        }
      }
    } else {
      this.shuffledIndices = [];
    }
  }

  private fisherYatesShuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  getNextIndex(): number {
    if (this.queue.length === 0) return -1;

    switch (this.repeatMode) {
      case 'repeat-one':
        return this.currentIndex;
      case 'repeat-all':
        return (this.currentIndex + 1) % this.queue.length;
      case 'shuffle': {
        if (this.shuffledIndices.length === 0) return -1;
        const currentPos = this.shuffledIndices.indexOf(this.currentIndex);
        const nextPos = currentPos + 1;
        if (nextPos < this.shuffledIndices.length) {
          return this.shuffledIndices[nextPos];
        }
        // Reshuffle and continue
        this.updateShuffleIndices();
        return this.shuffledIndices[0] ?? 0;
      }
      case 'sequence':
      default:
        return this.currentIndex + 1 < this.queue.length ? this.currentIndex + 1 : -1;
    }
  }

  getPreviousIndex(): number {
    if (this.queue.length === 0) return -1;

    switch (this.repeatMode) {
      case 'repeat-one':
        return this.currentIndex;
      case 'repeat-all':
        return (this.currentIndex - 1 + this.queue.length) % this.queue.length;
      case 'shuffle': {
        if (this.shuffledIndices.length === 0) return -1;
        const currentPos = this.shuffledIndices.indexOf(this.currentIndex);
        const prevPos = currentPos - 1;
        if (prevPos >= 0) {
          return this.shuffledIndices[prevPos];
        }
        return this.shuffledIndices[this.shuffledIndices.length - 1] ?? 0;
      }
      case 'sequence':
      default:
        return this.currentIndex > 0 ? this.currentIndex - 1 : -1;
    }
  }

  async playNext(): Promise<void> {
    const nextIndex = this.getNextIndex();
    if (nextIndex >= 0 && nextIndex < this.queue.length) {
      this.currentIndex = nextIndex;
      await this.playTrack(this.queue[nextIndex], this.lastQuality);
    } else {
      this.stop();
    }
  }

  async playPrevious(): Promise<void> {
    // If current time > 3s, seek to start instead of going to previous track
    if (this.audio && this.audio.currentTime > 3) {
      this.seek(0);
      return;
    }
    const prevIndex = this.getPreviousIndex();
    if (prevIndex >= 0 && prevIndex < this.queue.length) {
      this.currentIndex = prevIndex;
      await this.playTrack(this.queue[prevIndex], this.lastQuality);
    }
  }

  async playTrack(track: PlayerTrack, quality: Quality = Quality.STANDARD): Promise<void> {
    this.lastQuality = quality;
    this.setState('loading');
    this.currentTrack = track;

    try {
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

      await this.loadAndPlay(playUrl.url, track);
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
      this.handleTrackEnded();
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

  private handleTrackEnded(): void {
    this.setState('idle');
    this.stopProgressTracking();
    this.emit('ended', undefined);

    // Auto-advance based on repeat mode
    const nextIndex = this.getNextIndex();
    if (nextIndex >= 0 && nextIndex < this.queue.length) {
      this.currentIndex = nextIndex;
      this.playTrack(this.queue[nextIndex], this.lastQuality);
    }
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
