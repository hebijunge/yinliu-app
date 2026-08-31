/**
 * 音频焦点（Audio Focus）管理
 *
 * 目标：让本应用在与其他音频应用交互时表现正确
 * - 其他应用获取焦点（如来电、其他音乐 App 播放） → 自动暂停
 * - 焦点恢复（来电挂断、对方 App 退出）           → 按用户设置决定是否自动续播
 *
 * 实现策略（多平台协同）：
 * 1. Android：通过 @jofr/capacitor-media-session 注册的 MediaSession，
 *    系统在来电/其他 App 抢焦点时会自动暂停播放（音频元素触发 pause 事件）。
 * 2. Web/iOS：使用 Web Audio API 监听 audio 元素的 pause 事件，
 *    区分「用户主动暂停」与「系统焦点丢失导致的暂停」。
 * 3. 焦点恢复检测：综合使用 `document.visibilitychange` + 定时器轮询 audio 的
 *    paused/currentTime 状态，避免在后台过度唤醒。
 *
 * 注意：此模块与 PlayerEngine 协同工作，使用 `import type` 避免运行时循环依赖。
 */
import type { PlayerEngine } from './index';

export interface AudioFocusOptions {
  /** 当系统焦点恢复时是否自动续播（用户在设置页可关闭） */
  autoResumeOnFocusGain: boolean;
}

/**
 * 引擎提供的最小操作接口（避免直接 import PlayerEngine 类型）
 * 只暴露音频焦点模块需要的方法
 */
export interface AudioFocusEngine {
  getState: () => string;
  resume: () => void;
}

let engineRef: AudioFocusEngine | null = null;
let options: AudioFocusOptions = { autoResumeOnFocusGain: true };

// 上一次用户主动调用的播放状态（用于区分「用户暂停」与「系统焦点丢失」）
let userIntentPlay: boolean = false;
// 系统焦点丢失时是否处于播放状态
let wasPlayingBeforeFocusLoss: boolean = false;
// 检测定时器
let visibilityCheckTimer: number | null = null;
// resume 去重：挂起的 timeout id
let resumeTimeoutId: number | null = null;
// resume 去重：上次实际执行 resume 的时间戳
let lastResumeTime = 0;
// resume 冷却窗口（ms）
const RESUME_COOLDOWN_MS = 500;

export function configureAudioFocus(engine: AudioFocusEngine, opts: AudioFocusOptions): void {
  engineRef = engine;
  options = opts;
  attachListeners();
  startVisibilityMonitor();
}

export function updateAudioFocusOptions(opts: Partial<AudioFocusOptions>): void {
  options = { ...options, ...opts };
}

function attachListeners(): void {
  if (typeof document === 'undefined') return;
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  window.removeEventListener('pagehide', handlePageHide);
  window.addEventListener('pagehide', handlePageHide);

  window.removeEventListener('pageshow', handlePageShow);
  window.addEventListener('pageshow', handlePageShow);
}

function handleVisibilityChange(): void {
  // App 回到前台时，尝试检测是否需要恢复播放
  if (document.visibilityState === 'visible') {
    maybeResumeAfterFocusGain();
  } else {
    // App 进入后台时记录状态
    recordFocusLossState();
  }
}

function handlePageHide(): void {
  recordFocusLossState();
}

function handlePageShow(): void {
  maybeResumeAfterFocusGain();
}

function recordFocusLossState(): void {
  if (!engineRef) return;
  const state = engineRef.getState();
  wasPlayingBeforeFocusLoss = state === 'playing' || state === 'loading';
}

/**
 * 检测系统焦点恢复后是否需要自动续播
 *
 * 触发时机：App 回到前台
 * 判断条件：
 *   - 用户在失去焦点前正在播放
 *   - 引擎当前状态为 paused（系统强制暂停的标志）
 *   - 开启 autoResumeOnFocusGain 设置
 *   - 没有 pending 的用户主动暂停意图
 *   - 距离上次 resume 超过冷却窗口（去重）
 */
function maybeResumeAfterFocusGain(): void {
  if (!engineRef) return;
  if (!options.autoResumeOnFocusGain) return;
  if (!wasPlayingBeforeFocusLoss) return;
  if (!userIntentPlay) return;
  // 只有在当前确实是暂停状态时才续播
  if (engineRef.getState() !== 'paused') return;

  const now = Date.now();
  if (now - lastResumeTime < RESUME_COOLDOWN_MS) return;

  if (typeof window !== 'undefined') {
    // 清除之前挂起的 timeout，防止重复调度
    if (resumeTimeoutId !== null) {
      window.clearTimeout(resumeTimeoutId);
      resumeTimeoutId = null;
    }

    resumeTimeoutId = window.setTimeout(() => {
      resumeTimeoutId = null;
      try {
        // 再次检查状态，timeout 期间用户可能已主动操作
        if (engineRef?.getState() === 'paused') {
          engineRef?.resume();
          lastResumeTime = Date.now();
        }
      } catch (err) {
        console.warn('[audioFocus] auto resume failed:', err);
      }
    }, 300);
  }
}

/**
 * 由 PlayerEngine 在状态变化时调用，通知音频焦点模块
 * 用以同步内部「用户意图」与「系统状态」
 */
export function notifyPlaybackStateChange(state: 'playing' | 'paused' | 'idle' | 'loading' | 'error', source: 'user' | 'system' | 'engine'): void {
  if (source === 'user') {
    userIntentPlay = state === 'playing' || state === 'loading';
  } else if (source === 'system') {
    // 系统导致的暂停 → 标记之前是否在播放
    if (state === 'paused' || state === 'idle') {
      if (userIntentPlay) {
        wasPlayingBeforeFocusLoss = true;
      }
    } else if (state === 'playing') {
      wasPlayingBeforeFocusLoss = false;
    }
  }
}

function startVisibilityMonitor(): void {
  if (typeof window === 'undefined') return;
  if (visibilityCheckTimer !== null) return;
  // 兜底：每 3s 检查一次 audio 实际状态，避免 visibilitychange 漏触发
  visibilityCheckTimer = window.setInterval(() => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'visible') {
      maybeResumeAfterFocusGain();
    }
  }, 3000);
}

export function disposeAudioFocus(): void {
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('pagehide', handlePageHide);
    window.removeEventListener('pageshow', handlePageShow);
    if (visibilityCheckTimer !== null) {
      window.clearInterval(visibilityCheckTimer);
      visibilityCheckTimer = null;
    }
  }
  engineRef = null;
}
