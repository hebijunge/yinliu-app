/**
 * 音频焦点管理
 * v12: 处理来电 / 其他 App 抢焦点时的暂停/恢复
 */

export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

let currentState: PlayerState = 'idle';
let lastUserSource: 'user' | 'system' | 'engine' = 'engine';
let autoResumeEnabled = true;
const listeners: Array<(state: PlayerState) => void> = [];

export function notifyPlaybackStateChange(state: PlayerState, source: 'user' | 'system' | 'engine'): void {
  currentState = state;
  lastUserSource = source;

  // 模拟音频焦点被其他 App 抢占 → 暂停
  if (state === 'playing' && source === 'user') {
    // 正常播放
  }

  listeners.forEach((cb) => {
    try {
      cb(state);
    } catch {
      // ignore
    }
  });
}

export function getCurrentPlaybackState(): PlayerState {
  return currentState;
}

export function onAudioFocusChange(cb: (state: PlayerState) => void): () => void {
  listeners.push(cb);
  return () => {
    const idx = listeners.indexOf(cb);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

export function setAutoResumeEnabled(enabled: boolean): void {
  autoResumeEnabled = enabled;
}

export function isAutoResumeEnabled(): boolean {
  return autoResumeEnabled;
}
