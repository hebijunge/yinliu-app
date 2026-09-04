import { create } from 'zustand';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeStore {
  mode: ThemeMode;
  isDark: boolean;
  setMode: (mode: ThemeMode) => void;
  toggleTheme: () => void;
}

function getSystemDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function loadSavedMode(): ThemeMode {
  try {
    const saved = localStorage.getItem('yinliu-theme');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed?.state?.mode) return parsed.state.mode as ThemeMode;
    }
  } catch { /* ignore */ }
  return 'system';
}

function saveMode(mode: ThemeMode, isDark: boolean): void {
  try {
    localStorage.setItem('yinliu-theme', JSON.stringify({ state: { mode, isDark } }));
  } catch { /* ignore */ }
}

const initialMode = loadSavedMode();
const initialIsDark = initialMode === 'system' ? getSystemDark() : initialMode === 'dark';

document.documentElement.classList.toggle('dark', initialIsDark);

export const useThemeStore = create<ThemeStore>((set, get) => ({
  mode: initialMode,
  isDark: initialIsDark,

  setMode: (mode: ThemeMode) => {
    const isDark = mode === 'system' ? getSystemDark() : mode === 'dark';
    set({ mode, isDark });
    document.documentElement.classList.toggle('dark', isDark);
    saveMode(mode, isDark);
  },

  toggleTheme: () => {
    const newMode = get().isDark ? 'light' : 'dark';
    get().setMode(newMode);
  },
}));

// v23：「跟随系统」模式下监听系统主题运行时切换（用户在系统设置里切深色/浅色时实时生效）
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemChange = (e: MediaQueryListEvent) => {
    const { mode } = useThemeStore.getState();
    if (mode !== 'system') return;
    useThemeStore.getState().setMode('system');
    // setMode('system') 内部已按 getSystemDark() 重算 isDark，这里再兜底同步一次 class
    document.documentElement.classList.toggle('dark', e.matches);
  };
  if (mq.addEventListener) {
    mq.addEventListener('change', onSystemChange);
  } else if ((mq as unknown as { addListener?: (cb: (e: MediaQueryListEvent) => void) => void }).addListener) {
    // 兼容旧版 Safari / Android WebView
    (mq as unknown as { addListener: (cb: (e: MediaQueryListEvent) => void) => void }).addListener(onSystemChange);
  }
}
