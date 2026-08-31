import { create } from 'zustand';
import { Quality } from '@core/types';

const STORAGE_KEY = 'yinliu.settings.v1';

export interface SettingsPersisted {
  preferredQuality?: Quality;
  enabledSources?: Record<string, boolean>;
  downloadQuality?: Quality;
  maxConcurrentDownloads?: number;
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

  setPreferredQuality: (quality: Quality) => void;
  setSourceEnabled: (sourceId: string, enabled: boolean) => void;
  setDownloadQuality: (quality: Quality) => void;
  setMaxConcurrentDownloads: (n: number) => void;
  clearAllSettings: () => void;
}

const persisted = typeof window !== 'undefined' ? loadPersisted() : {};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  preferredQuality: persisted.preferredQuality ?? Quality.STANDARD,
  enabledSources: persisted.enabledSources ?? {},
  downloadQuality: persisted.downloadQuality ?? Quality.STANDARD,
  maxConcurrentDownloads: persisted.maxConcurrentDownloads ?? 3,
  downloadDir: '/storage/emulated/0/YinliuDownloads/',

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
    persist(get());
  },

  setMaxConcurrentDownloads: (maxConcurrentDownloads) => {
    set({ maxConcurrentDownloads });
    persist(get());
  },

  clearAllSettings: () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    set({ preferredQuality: Quality.STANDARD, enabledSources: {}, downloadQuality: Quality.STANDARD, maxConcurrentDownloads: 3 });
  },
}));

/** 某音源当前是否启用（缺省视为启用） */
export function isSourceEnabled(enabledSources: Record<string, boolean>, sourceId: string): boolean {
  return enabledSources[sourceId] !== false;
}
