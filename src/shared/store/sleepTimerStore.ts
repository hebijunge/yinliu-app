import { create } from 'zustand';
import { playerEngine } from '@core/player';
import { toast } from '@shared/components/Toast';
import { debugLogger } from '@shared/utils/debugLogger';

export type SleepTimerMode = 'duration' | 'end-of-track';

interface SleepTimerState {
  /** 是否激活 */
  active: boolean;
  /** 模式：倒计时 或 播完当前曲 */
  mode: SleepTimerMode;
  /** 总倒计时（秒），mode='duration' 时有效 */
  totalSeconds: number;
  /** 剩余秒数 */
  remainingSeconds: number;
  /** 是否正在渐弱音量中 */
  fading: boolean;

  // Actions
  startDuration: (minutes: number) => void;
  startEndOfTrack: () => void;
  cancel: () => void;
  tick: () => void;
  setRemaining: (seconds: number) => void;
  setFading: (fading: boolean) => void;
}

/** 防冻结时间戳检查：记录上次 tick 时间，用于检测后台冻结 */
let lastTickAt = 0;
let fadeInterval: number | null = null;
let timerInterval: number | null = null;

/** 启动全局定时器检查（由 App.tsx 在应用启动时调用一次） */
export function initSleepTimerWatcher(): () => void {
  if (timerInterval !== null) return () => {};

  lastTickAt = Date.now();
  timerInterval = window.setInterval(() => {
    const store = useSleepTimerStore.getState();
    if (!store.active || store.fading) return;

    const now = Date.now();
    const elapsed = Math.floor((now - lastTickAt) / 1000);
    lastTickAt = now;

    // 防冻结：如果 elapsed 远大于 1 秒，说明后台被冻结，按实际经过时间扣减
    if (elapsed > 2 && store.mode === 'duration') {
      const newRemaining = Math.max(0, store.remainingSeconds - elapsed + 1);
      store.setRemaining(newRemaining);
      debugLogger.info('sleepTimer', `后台冻结补偿: 跳过 ${elapsed - 1}s, 剩余 ${newRemaining}s`);
    } else {
      store.tick();
    }

    // 检查是否到达触发点
    const afterTick = useSleepTimerStore.getState();
    if (afterTick.active && afterTick.remainingSeconds <= 0 && !afterTick.fading) {
      void triggerSleepAction();
    }
  }, 1000);

  return () => {
    if (timerInterval !== null) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  };
}

/** 执行睡眠动作：渐弱音量后暂停 */
async function triggerSleepAction(): Promise<void> {
  const store = useSleepTimerStore.getState();
  if (store.fading || !store.active) return;

  store.setFading(true);
  debugLogger.info('sleepTimer', '睡眠定时触发，开始渐弱音量');

  const startVolume = playerEngine.getVolume();
  const fadeSteps = 20;
  const fadeDuration = 3000; // 3 秒渐弱
  const stepDuration = fadeDuration / fadeSteps;
  let step = 0;

  fadeInterval = window.setInterval(() => {
    step++;
    const ratio = Math.max(0, 1 - step / fadeSteps);
    playerEngine.setVolume(startVolume * ratio);

    if (step >= fadeSteps) {
      if (fadeInterval !== null) {
        clearInterval(fadeInterval);
        fadeInterval = null;
      }
      playerEngine.pause();
      playerEngine.setVolume(startVolume); // 恢复原始音量，下次播放生效
      useSleepTimerStore.getState().cancel();
      toast.info('睡眠定时', '已到达设定时间，播放已暂停');
      debugLogger.info('sleepTimer', '睡眠定时完成，播放已暂停');
    }
  }, stepDuration);
}

/** 监听播放结束事件，用于 "播完当前曲" 模式 */
export function initSleepTimerEndedListener(): () => void {
  return playerEngine.on('ended', () => {
    const store = useSleepTimerStore.getState();
    if (store.active && store.mode === 'end-of-track') {
      store.cancel();
      toast.info('睡眠定时', '当前曲目播放完毕，已暂停');
      debugLogger.info('sleepTimer', '播完当前曲模式触发');
    }
  });
}

export const useSleepTimerStore = create<SleepTimerState>((set, get) => ({
  active: false,
  mode: 'duration',
  totalSeconds: 0,
  remainingSeconds: 0,
  fading: false,

  startDuration: (minutes: number) => {
    const seconds = Math.max(1, Math.floor(minutes * 60));
    lastTickAt = Date.now();
    set({
      active: true,
      mode: 'duration',
      totalSeconds: seconds,
      remainingSeconds: seconds,
      fading: false,
    });
    toast.info('睡眠定时已开启', `${minutes} 分钟后自动暂停`);
    debugLogger.info('sleepTimer', `开启倒计时模式: ${minutes}min`);
  },

  startEndOfTrack: () => {
    lastTickAt = Date.now();
    set({
      active: true,
      mode: 'end-of-track',
      totalSeconds: 0,
      remainingSeconds: 0,
      fading: false,
    });
    toast.info('睡眠定时已开启', '当前曲目播放完毕后自动暂停');
    debugLogger.info('sleepTimer', '开启播完当前曲模式');
  },

  cancel: () => {
    if (fadeInterval !== null) {
      clearInterval(fadeInterval);
      fadeInterval = null;
    }
    set({
      active: false,
      mode: 'duration',
      totalSeconds: 0,
      remainingSeconds: 0,
      fading: false,
    });
    debugLogger.info('sleepTimer', '睡眠定时已取消');
  },

  tick: () => {
    const { active, mode, remainingSeconds, fading } = get();
    if (!active || mode !== 'duration' || fading) return;
    const next = Math.max(0, remainingSeconds - 1);
    set({ remainingSeconds: next });
  },

  setRemaining: (seconds: number) => {
    set({ remainingSeconds: seconds });
  },

  setFading: (fading: boolean) => {
    set({ fading });
  },
}));

/** 格式化剩余时间为 mm:ss */
export function formatSleepTimerRemaining(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
