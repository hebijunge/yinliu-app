import { create } from 'zustand';
import type { AggregatedSearchResult } from '@core/search';
import { Quality, type SearchType } from '@core/types';

const HISTORY_STORAGE_KEY = 'yinliu_search_history';
const HISTORY_MAX = 20;

/** 从 localStorage 恢复搜索历史（持久化：重启不丢） */
function loadHistoryFromStorage(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string' && k.length > 0).slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

/** 搜索历史写回 localStorage */
function saveHistoryToStorage(history: string[]): void {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // 存储不可用（隐私模式等）时静默降级为仅内存
  }
}

interface SearchStore {
  keyword: string;
  results: AggregatedSearchResult[];
  isSearching: boolean;
  sourceStats: Record<string, { total: number; latency: number; error?: string; errorType?: string }>;
  selectedSources: string[];
  selectedQuality: Quality;
  searchHistory: string[];
  /** 搜索类型（歌曲/歌手/专辑/MV） */
  searchType: SearchType;

  setKeyword: (keyword: string) => void;
  setResults: (results: AggregatedSearchResult[]) => void;
  setSearching: (isSearching: boolean) => void;
  setSourceStats: (stats: Record<string, { total: number; latency: number; error?: string; errorType?: string }>) => void;
  toggleSource: (sourceId: string) => void;
  setQuality: (quality: Quality) => void;
  setSearchType: (type: SearchType) => void;
  addToHistory: (keyword: string) => void;
  removeHistory: (keyword: string) => void;
  clearHistory: () => void;
}

export const useSearchStore = create<SearchStore>((set) => ({
  keyword: '',
  results: [],
  isSearching: false,
  sourceStats: {},
  selectedSources: ['qishui', 'netease', 'qq', 'kuwo', 'kugou', 'migu'],
  selectedQuality: Quality.STANDARD,
  searchHistory: loadHistoryFromStorage(),
  searchType: 'song',

  setKeyword: (keyword) => set({ keyword }),
  setResults: (results) => set({ results }),
  setSearching: (isSearching) => set({ isSearching }),
  setSourceStats: (sourceStats) => set({ sourceStats }),
  toggleSource: (sourceId) =>
    set((s) => ({
      selectedSources: s.selectedSources.includes(sourceId)
        ? s.selectedSources.filter((id) => id !== sourceId)
        : [...s.selectedSources, sourceId],
    })),
  setQuality: (selectedQuality) => set({ selectedQuality }),
  setSearchType: (searchType) => set({ searchType }),
  addToHistory: (keyword) =>
    set((s) => {
      const searchHistory = [keyword, ...s.searchHistory.filter((k) => k !== keyword)].slice(0, HISTORY_MAX);
      saveHistoryToStorage(searchHistory);
      return { searchHistory };
    }),
  removeHistory: (keyword) =>
    set((s) => {
      const searchHistory = s.searchHistory.filter((k) => k !== keyword);
      saveHistoryToStorage(searchHistory);
      return { searchHistory };
    }),
  clearHistory: () => {
    saveHistoryToStorage([]);
    set({ searchHistory: [] });
  },
}));
