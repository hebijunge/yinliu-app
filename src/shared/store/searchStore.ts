import { create } from 'zustand';
import type { AggregatedSearchResult } from '@core/search';
import { Quality } from '@core/types';

interface SearchStore {
  keyword: string;
  results: AggregatedSearchResult[];
  isSearching: boolean;
  sourceStats: Record<string, { total: number; latency: number; error?: string; errorType?: string }>;
  selectedSources: string[];
  selectedQuality: Quality;
  searchHistory: string[];

  setKeyword: (keyword: string) => void;
  setResults: (results: AggregatedSearchResult[]) => void;
  setSearching: (isSearching: boolean) => void;
  setSourceStats: (stats: Record<string, { total: number; latency: number; error?: string; errorType?: string }>) => void;
  toggleSource: (sourceId: string) => void;
  setQuality: (quality: Quality) => void;
  addToHistory: (keyword: string) => void;
  clearHistory: () => void;
}

export const useSearchStore = create<SearchStore>((set) => ({
  keyword: '',
  results: [],
  isSearching: false,
  sourceStats: {},
  selectedSources: ['netease', 'qq', 'kuwo', 'kugou', 'migu'],
  selectedQuality: Quality.STANDARD,
  searchHistory: [],

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
  addToHistory: (keyword) =>
    set((s) => ({
      searchHistory: [keyword, ...s.searchHistory.filter((k) => k !== keyword)].slice(0, 20),
    })),
  clearHistory: () => set({ searchHistory: [] }),
}));
