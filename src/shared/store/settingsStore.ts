import { create } from 'zustand';
import { Quality } from '@core/types';
import { downloadEngine } from '@core/download';

const STORAGE_KEY = 'yinliu.settings.v1';

/** 将下载设置应用到下载引擎，保证设置真实生效 */
function applyDownloadSettings(quality: Quality, concurrency: number): void {
  downloadEngine.setMaxConcurrent(concurrency);
  downloadEngine.setDefaultQuality(quality);
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
  /** 下载目录（Android 外部存储，只读展示） */
  readonly downloadDir: string;
  /** 系统媒体焦点恢复后是否自动续播（默认 true） */
  autoResumeOnAudioFocus: boolean;
  /** 是否在系统通知栏 / 锁屏显示媒体控制（默认 true） */
  enableNotificationControls: boolean;
  /** 暂停后是否让通知栏卡片自动消失（默认 false，避免频繁变化） */
  dismissNotificationOnPause: boolean;

  setPreferredQuality: (quality: Quality) => void;
  setSourceEnabled: (sourceId: string, enabled: boolean) => void;
  setDownloadQuality: (quality: Quality) => void;
  setMaxConcurrentDownloads: (n: number) => void;
  setAutoResumeOnAudioFocus: (v: boolean) => void;
  setEnableNotificationControls: (v: boolean) => void;
  setDismissNotificationOnPause: (v: boolean) => void;
  clearAllSettings: () => void;
}

const persisted = typeof window !== 'undefined' ? loadPersisted() : {};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  preferredQuality: persisted.preferredQuality ?? Quality.STANDARD,
  enabledSources: persisted.enabledSources ?? {},
  downloadQuality: persisted.downloadQuality ?? Quality.STANDARD,
  maxConcurrentDownloads: persisted.maxConcurrentDownloads ?? 3,
  downloadDir: '/storage/emulated/0/YinliuDownloads/',
  autoResumeOnAudioFocus: persisted.autoResumeOnAudioFocus ?? true,
  enableNotificationControls: persisted.enableNotificationControls ?? true,
  dismissNotificationOnPause: persisted.dismissNotificationOnPause ?? false,

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
      autoResumeOnAudioFocus: true,
      enableNotificationControls: true,
      dismissNotificationOnPause: false,
    });
  },
}));

/** 某音源当前是否启用（缺省视为启用） */
export function isSourceEnabled(enabledSources: Record<string, boolean>, sourceId: string): boolean {
  return enabledSources[sourceId] !== false;
}

// 启动时把持久化的下载设置应用到下载引擎，保证重启后设置依然生效
if (typeof window !== 'undefined') {
  const s = useSettingsStore.getState();
  applyDownloadSettings(s.downloadQuality, s.maxConcurrentDownloads);
}
