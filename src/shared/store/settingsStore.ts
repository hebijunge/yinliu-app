import { create } from 'zustand';
import { Quality } from '@core/types';
import { downloadEngine } from '@core/download';
import { debugLogger } from '@shared/utils/debugLogger';
import type { RepeatMode } from './playerStore';

const STORAGE_KEY = 'yinliu.settings.v1';

/** 将下载设置应用到下载引擎，保证设置真实生效 */
function applyDownloadSettings(quality: Quality, concurrency: number, dir?: string): void {
  downloadEngine.setMaxConcurrent(concurrency);
  downloadEngine.setDefaultQuality(quality);
  if (dir) downloadEngine.setDownloadDir(dir);
}

export interface SettingsPersisted {
  preferredQuality?: Quality;
  enabledSources?: Record<string, boolean>;
  downloadQuality?: Quality;
  maxConcurrentDownloads?: number;
  /** 音频焦点恢复后是否自动续播 */
  autoResumeOnAudioFocus?: boolean;
  /** 通知栏媒体控制启用（关闭后系统通知栏不显示媒体卡片） */
  enableNotificationControls?: boolean;
  /** 播放结束后自动从通知栏移除（默认 false，避免频繁出现/消失） */
  dismissNotificationOnPause?: boolean;
  /** 调试模式：开启后记录所有操作和事件日志 */
  debugMode?: boolean;
  /** 车机模式：简化 UI，放大控件 */
  carMode?: boolean;
  /** Android 桌面悬浮歌词开关 */
  enableFloatingLyrics?: boolean;
  /** 播放模式：顺序/列表循环/单曲循环/随机 */
  repeatMode?: RepeatMode;
  /** 下载目录（应用私有数据目录下的相对路径） */
  downloadDir?: string;
}

function loadPersisted(): SettingsPersisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as SettingsPersisted;
  } catch {
    return {};
  }
}

function persist(state: SettingsState): void {
  try {
    const data: SettingsPersisted = {
      preferredQuality: state.preferredQuality,
      enabledSources: state.enabledSources,
      downloadQuality: state.downloadQuality,
      maxConcurrentDownloads: state.maxConcurrentDownloads,
      autoResumeOnAudioFocus: state.autoResumeOnAudioFocus,
      enableNotificationControls: state.enableNotificationControls,
      dismissNotificationOnPause: state.dismissNotificationOnPause,
      debugMode: state.debugMode,
      carMode: state.carMode,
      enableFloatingLyrics: state.enableFloatingLyrics,
      repeatMode: state.repeatMode,
      downloadDir: state.downloadDir,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // 存储不可用时静默降级，设置仅在本次会话生效
  }
}

interface SettingsState {
  /** 音质偏好：播放页音质切换与搜索页默认档共用同一持久化 */
  preferredQuality: Quality;
  /** 音源开关：关闭后聚合搜索只走启用的源（缺省视为启用） */
  enabledSources: Record<string, boolean>;
  /** 下载音质 */
  downloadQuality: Quality;
  /** 最大并发下载数 */
  maxConcurrentDownloads: number;
  /** 下载目录（应用私有数据目录下的相对路径，可在设置页修改） */
  downloadDir: string;
  /** 系统媒体焦点恢复后是否自动续播（默认 true） */
  autoResumeOnAudioFocus: boolean;
  /** 是否在系统通知栏 / 锁屏显示媒体控制（默认 true） */
  enableNotificationControls: boolean;
  /** 暂停后是否让通知栏卡片自动消失（默认 false，避免频繁变化） */
  dismissNotificationOnPause: boolean;
  /** 调试模式：开启后记录所有操作和事件日志 */
  debugMode: boolean;
  /** 车机模式：简化 UI，放大控件 */
  carMode: boolean;
  /** Android 桌面悬浮歌词开关 */
  enableFloatingLyrics: boolean;
  /** 播放模式：顺序/列表循环/单曲循环/随机 */
  repeatMode: RepeatMode;

  setPreferredQuality: (quality: Quality) => void;
  setSourceEnabled: (sourceId: string, enabled: boolean) => void;
  setDownloadQuality: (quality: Quality) => void;
  setMaxConcurrentDownloads: (n: number) => void;
  setAutoResumeOnAudioFocus: (v: boolean) => void;
  setEnableNotificationControls: (v: boolean) => void;
  setDismissNotificationOnPause: (v: boolean) => void;
  setDebugMode: (enabled: boolean) => void;
  setCarMode: (enabled: boolean) => void;
  setFloatingLyricsEnabled: (enabled: boolean) => void;
  setRepeatMode: (mode: RepeatMode) => void;
  setDownloadDir: (dir: string) => void;
  clearAllSettings: () => void;
}

const persisted = typeof window !== 'undefined' ? loadPersisted() : {};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  preferredQuality: persisted.preferredQuality ?? Quality.STANDARD,
  enabledSources: persisted.enabledSources ?? {},
  downloadQuality: persisted.downloadQuality ?? Quality.STANDARD,
  maxConcurrentDownloads: persisted.maxConcurrentDownloads ?? 3,
  downloadDir: persisted.downloadDir ?? 'yinliu/downloads',
  autoResumeOnAudioFocus: persisted.autoResumeOnAudioFocus ?? true,
  enableNotificationControls: persisted.enableNotificationControls ?? true,
  dismissNotificationOnPause: persisted.dismissNotificationOnPause ?? false,
  debugMode: persisted.debugMode ?? false,
  carMode: persisted.carMode ?? false,
  enableFloatingLyrics: persisted.enableFloatingLyrics ?? false,
  repeatMode: persisted.repeatMode ?? 'sequence',

  setPreferredQuality: (preferredQuality) => {
    set({ preferredQuality });
    persist(get());
  },

  setSourceEnabled: (sourceId, enabled) => {
    set((s) => ({ enabledSources: { ...s.enabledSources, [sourceId]: enabled } }));
    persist(get());
  },

  setDownloadQuality: (downloadQuality) => {
    set({ downloadQuality });
    applyDownloadSettings(downloadQuality, get().maxConcurrentDownloads);
    persist(get());
  },

  setMaxConcurrentDownloads: (maxConcurrentDownloads) => {
    set({ maxConcurrentDownloads });
    applyDownloadSettings(get().downloadQuality, maxConcurrentDownloads);
    persist(get());
  },

  setAutoResumeOnAudioFocus: (autoResumeOnAudioFocus) => {
    set({ autoResumeOnAudioFocus });
    persist(get());
  },

  setEnableNotificationControls: (enableNotificationControls) => {
    set({ enableNotificationControls });
    persist(get());
  },

  setDismissNotificationOnPause: (dismissNotificationOnPause) => {
    set({ dismissNotificationOnPause });
    persist(get());
  },

  setDebugMode: (debugMode) => {
    set({ debugMode });
    debugLogger.setEnabled(debugMode);
    persist(get());
  },

  setCarMode: (carMode) => {
    set({ carMode });
    persist(get());
  },

  setFloatingLyricsEnabled: (enableFloatingLyrics) => {
    set({ enableFloatingLyrics });
    persist(get());
  },

  setRepeatMode: (repeatMode: RepeatMode) => {
    set({ repeatMode });
    persist(get());
  },

  setDownloadDir: (downloadDir: string) => {
    const trimmed = (downloadDir || '').trim().replace(/^\/+|\/+$/g, '');
    if (!trimmed) return;
    set({ downloadDir: trimmed });
    downloadEngine.setDownloadDir(trimmed);
    persist(get());
  },

  clearAllSettings: () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    set({
      preferredQuality: Quality.STANDARD,
      enabledSources: {},
      downloadQuality: Quality.STANDARD,
      maxConcurrentDownloads: 3,
      downloadDir: 'yinliu/downloads',
      autoResumeOnAudioFocus: true,
      enableNotificationControls: true,
      dismissNotificationOnPause: false,
      debugMode: false,
      carMode: false,
      enableFloatingLyrics: false,
      repeatMode: 'sequence',
    });
    // C10 修复：clearAll 原先只重置了目录，音质/并发设置仍留在下载引擎里
    applyDownloadSettings(Quality.STANDARD, 3, 'yinliu/downloads');
    debugLogger.setEnabled(false);
  },
}));

/** 某音源当前是否启用（缺省视为启用） */
export function isSourceEnabled(enabledSources: Record<string, boolean>, sourceId: string): boolean {
  return enabledSources[sourceId] !== false;
}

// 启动时把持久化的下载设置应用到下载引擎，保证重启后设置依然生效
// 同时同步调试模式开关到日志服务——修复 v13.2 重启后调试日志不记录的根因
if (typeof window !== 'undefined') {
  const s = useSettingsStore.getState();
  applyDownloadSettings(s.downloadQuality, s.maxConcurrentDownloads, s.downloadDir);
  debugLogger.setEnabled(s.debugMode);
}
