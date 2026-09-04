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
 * 注意：此模块与 PlayerEngine 协同工作，使用 `import type` 避免运行时循环依赖
 * （debugLogger 位于 shared/utils，与 player 无依赖关系，可安全引入落盘日志）。
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { debugLogger } from '@shared/utils/debugLogger';
import type { PlayerEngine } from './index';

/**
 * v20 原生音频焦点桥（仅 Android 原生端注册，Web/Tauri 上调用为 no-op）
 * 对应 android/app/src/main/java/com/yinliu/app/AudioFocusManagerPlugin.java
 */
interface AudioFocusManagerPluginShape {
  requestFocus(): Promise<{ granted?: boolean }>;
  abandonFocus(): Promise<void>;
  addListener(
    eventName: string,
    listenerFunc: (data: { change?: number }) => void
  ): Promise<PluginListenerHandle> & PluginListenerHandle;
  removeAllListeners(): Promise<void>;
}
const AudioFocusManager = registerPlugin<AudioFocusManagerPluginShape>('AudioFocusManager');

// Android AudioManager 焦点变化常量
const AUDIOFOCUS_LOSS = -1;
const AUDIOFOCUS_LOSS_TRANSIENT = -2;
const AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK = -3;

const isAndroidNative = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

// 原生监听是否已挂接（幂等）
let nativeListenersAttached = false;
let nativeListeners: PluginListenerHandle[] = [];
// 焦点是否已持有（避免每次播放重复 IPC）
let nativeFocusHeld = false;

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
  /** v20：系统（焦点丢失/耳机拔出）导致的暂停，保留用户播放意图；v28 带 reason 供归因日志 */
  pauseBySystem: (reason?: string) => void;
  /**
   * v28：CAN_DUCK 压低音量（ducked=true 压低，false 还原）。
   * 按 Android 音频焦点规范，TRANSIENT_CAN_DUCK 应压低音量继续播放而非暂停。
   */
  duckVolume: (ducked: boolean) => void;
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
// v28：CAN_DUCK 是否已压低音量（配合引擎 duckVolume 的还原调用）
let duckedDueToCanDuck = false;
// v28：CAN_DUCK 压低音量比例（Android 规范建议压低而非暂停，取常用 duck 比例）
const DUCK_VOLUME_RATIO = 0.3;

export function configureAudioFocus(engine: AudioFocusEngine, opts: AudioFocusOptions): void {
  engineRef = engine;
  options = opts;
  attachListeners();
  startVisibilityMonitor();
  attachNativeListeners();
}

/**
 * v20：挂接原生音频焦点 / 耳机拔出事件（仅 Android）
 * - focusChange(GAIN)：其他 App 释放焦点 → 按设置自动续播
 * - focusChange(LOSS_TRANSIENT*)：来电/其他 App 播放 → 系统暂停（保留续播意图）
 * - focusChange(LOSS)：永久失去焦点 → 暂停且不再自动续播
 * - becomingNoisy：耳机/蓝牙拔出 → 立即暂停且不自动续播
 */
function attachNativeListeners(): void {
  if (!isAndroidNative() || nativeListenersAttached) return;
  nativeListenersAttached = true;
  try {
    void AudioFocusManager.addListener(
      'focusChange',
      (data: { change?: number }) => {
        const change = data?.change ?? 0;
        debugLogger.info('player', `音频焦点变化 focusChange: ${change}`, {
          change,
          meaning:
            change === 1
              ? 'GAIN 焦点恢复'
              : change === AUDIOFOCUS_LOSS
                ? 'LOSS 永久丢失'
                : change === AUDIOFOCUS_LOSS_TRANSIENT
                  ? 'LOSS_TRANSIENT 暂时丢失（来电等）'
                  : change === AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK
                    ? 'LOSS_TRANSIENT_CAN_DUCK 可压低'
                    : '未知',
          playing: engineRef?.getState() === 'playing' || engineRef?.getState() === 'loading',
        });
        if (change === 1) {
          // v28：若此前 CAN_DUCK 压低了音量，先还原，再走统一的自动续播判定
          if (duckedDueToCanDuck) {
            duckedDueToCanDuck = false;
            engineRef?.duckVolume(false);
          }
          // 焦点恢复：走统一的自动续播判定（含设置开关 / 用户意图 / 冷却去重）
          maybeResumeAfterFocusGain(true);
        } else if (change === AUDIOFOCUS_LOSS) {
          // 永久失去：暂停且清除续播意图；若此前压低了音量，先还原再暂停
          if (duckedDueToCanDuck) {
            duckedDueToCanDuck = false;
            engineRef?.duckVolume(false);
          }
          wasPlayingBeforeFocusLoss = false;
          userIntentPlay = false;
          void AudioFocusManager.abandonFocus().then(() => { nativeFocusHeld = false; }).catch(() => {});
          engineRef?.pauseBySystem(`focusChange(LOSS=-1) 永久失去音频焦点`);
        } else if (change === AUDIOFOCUS_LOSS_TRANSIENT) {
          // 暂时失去（来电/其他 App 抢焦点）：暂停但保留续播意图
          engineRef?.pauseBySystem(`focusChange(LOSS_TRANSIENT=-2) 暂时失去音频焦点（如来电/其他应用播放）`);
        } else if (change === AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
          // v28：可压低（通知音/短提示音等）→ 按 Android 规范压低音量继续播放，不暂停
          duckedDueToCanDuck = true;
          engineRef?.duckVolume(true);
          debugLogger.info('player', '音频焦点 CAN_DUCK：压低音量继续播放', {
            ratio: DUCK_VOLUME_RATIO,
          });
        }
      }
    ).then((h) => { nativeListeners.push(h); }).catch(() => {});

    void AudioFocusManager.addListener('becomingNoisy', () => {
      debugLogger.info('player', 'becomingNoisy：耳机/蓝牙拔出，暂停播放（不自动续播）');
      wasPlayingBeforeFocusLoss = false;
      userIntentPlay = false;
      engineRef?.pauseBySystem('becomingNoisy 耳机/蓝牙拔出');
    }).then((h) => { nativeListeners.push(h); }).catch(() => {});
  } catch (err) {
    console.warn('[audioFocus] native listener attach failed:', err);
  }
}

// v28：debugLog 已由 debugLogger（'player' 类别，进导出日志）取代并移除

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
function maybeResumeAfterFocusGain(fromFocus = false): void {
  if (!engineRef) return;
  // v20：来自原生焦点恢复事件时，跳过「回到前台」前置检查（用户可能正锁屏听歌）
  if (!fromFocus && typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
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
  // v20：Android 上由 JS 显式管理音频焦点（WebView 播放路径系统不会自动申请）
  if (isAndroidNative()) {
    if (state === 'playing' && !nativeFocusHeld) {
      nativeFocusHeld = true;
      void AudioFocusManager.requestFocus().catch(() => { nativeFocusHeld = false; });
    } else if (source === 'user' && (state === 'paused' || state === 'idle') && nativeFocusHeld) {
      nativeFocusHeld = false;
      void AudioFocusManager.abandonFocus().catch(() => {});
    }
    // v28：用户主动起播时解除 CAN_DUCK 压低（兜底：若 GAIN 事件迟到/丢失，
    // 避免用户手动恢复播放后音量停留在压低值）
    if (state === 'playing' && source === 'user' && duckedDueToCanDuck) {
      duckedDueToCanDuck = false;
      engineRef?.duckVolume(false);
      debugLogger.info('player', '用户主动起播，解除 CAN_DUCK 音量压低');
    }
  }
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
  for (const h of nativeListeners) {
    void h.remove().catch(() => {});
  }
  nativeListeners = [];
  nativeListenersAttached = false;
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
