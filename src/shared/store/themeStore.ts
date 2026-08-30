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
