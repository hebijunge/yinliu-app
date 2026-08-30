import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set, get) => ({
      mode: 'system',
      isDark: getSystemDark(),

      setMode: (mode) => {
        const isDark = mode === 'system' ? getSystemDark() : mode === 'dark';
        set({ mode, isDark });
        document.documentElement.classList.toggle('dark', isDark);
      },

      toggleTheme: () => {
        const newMode = get().isDark ? 'light' : 'dark';
        get().setMode(newMode);
      },
    }),
    {
      name: 'yinliu-theme',
    }
  )
);
