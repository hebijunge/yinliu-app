import { create } from 'zustand';
import { playHistoryService, type HistoryRecord, type HistoryInput } from '@shared/services/PlayHistoryService';

export type { HistoryRecord, HistoryInput };

interface PlayHistoryStore {
  records: HistoryRecord[];
  isLoading: boolean;

  loadRecords: () => Promise<void>;
  addRecord: (input: HistoryInput) => Promise<void>;
  clearHistory: () => Promise<void>;
  removeRecord: (id: number) => Promise<void>;
}

export const usePlayHistoryStore = create<PlayHistoryStore>((set, get) => ({
  records: [],
  isLoading: false,

  loadRecords: async () => {
    set({ isLoading: true });
    try {
      const records = await playHistoryService.getRecent(200);
      set({ records });
    } finally {
      set({ isLoading: false });
    }
  },

  addRecord: async (input) => {
    await playHistoryService.addRecord(input);
    await get().loadRecords();
  },

  clearHistory: async () => {
    await playHistoryService.clearAll();
    set({ records: [] });
  },

  removeRecord: async (id) => {
    await playHistoryService.removeRecord(id);
    set({ records: get().records.filter((r) => r.id !== id) });
  },
}));
