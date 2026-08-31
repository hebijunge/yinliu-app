/**
 * 系统媒体会话桥接（v12）
 * - 通知栏 / 锁屏 媒体控制
 * - 与系统 MediaSession API 通信
 */

import { Capacitor } from '@capacitor/core';

type MediaSessionAction =
  | 'play'
  | 'pause'
  | 'previoustrack'
  | 'nexttrack'
  | 'seekbackward'
  | 'seekforward'
  | 'seekto'
  | 'stop';

export type MediaAction =
  | 'play'
  | 'pause'
  | 'previoustrack'
  | 'nexttrack'
  | 'seekbackward'
  | 'seekforward'
  | 'seekto'
  | 'stop';

export type MediaActionHandler = (action: MediaAction, details: { seekTime: number | null }) => void;

let initialized = false;
let positionTimer: number | null = null;
let lastPosition: number = 0;
let lastDuration: number = 0;
let lastState: 'playing' | 'paused' | 'none' = 'none';

export async function initMediaSession(handler: MediaActionHandler): Promise<void> {
  if (initialized) return;
  initialized = true;

  if (Capacitor.isNativePlatform()) {
    try {
      const plugins = (Capacitor as any).Plugins as Record<string, any> | undefined;
      const plugin = plugins?.MediaSession;
      if (plugin && typeof plugin.setActionHandler === 'function') {
        await plugin.setActionHandler({ action: 'play' });
        await plugin.setActionHandler({ action: 'pause' });
        await plugin.setActionHandler({ action: 'previoustrack' });
        await plugin.setActionHandler({ action: 'nexttrack' });
      }
    } catch {
      // MediaSession 插件未安装时静默降级
    }
  } else if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
    try {
      const ms = navigator.mediaSession;
      (['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto', 'stop'] as MediaAction[]).forEach((action) => {
        try {
          ms.setActionHandler(action as MediaSessionAction, (details: any) => {
            handler(action, { seekTime: details?.seekTime ?? null });
          });
        } catch {
          // 某些 action 浏览器不支持
        }
      });
    } catch {
      // 浏览器不支持时静默降级
    }
  }
}

export async function updateMetadata(meta: {
  title: string;
  artist: string;
  album: string;
  artwork?: string;
}): Promise<void> {
  if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        artwork: meta.artwork ? [{ src: meta.artwork, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
    } catch {
      // ignore
    }
  }
}

export async function updatePlaybackState(state: 'playing' | 'paused' | 'none'): Promise<void> {
  lastState = state;
  if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = state;
    } catch {
      // ignore
    }
  }
}

export function startPositionSync(getPos: () => { currentTime: number; duration: number }): void {
  stopPositionSync();
  positionTimer = window.setInterval(() => {
    const { currentTime, duration } = getPos();
    lastPosition = currentTime;
    lastDuration = duration;
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      try {
        navigator.mediaSession.setPositionState({
          duration: duration || 0,
          playbackRate: 1,
          position: currentTime || 0,
        });
      } catch {
        // ignore
      }
    }
  }, 1000);
}

export function stopPositionSync(): void {
  if (positionTimer !== null) {
    clearInterval(positionTimer);
    positionTimer = null;
  }
}

export async function updatePosition(currentTime: number, duration: number): Promise<void> {
  lastPosition = currentTime;
  lastDuration = duration;
}

export async function clearMediaSession(): Promise<void> {
  if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    } catch {
      // ignore
    }
  }
}

export { lastPosition, lastDuration, lastState };
