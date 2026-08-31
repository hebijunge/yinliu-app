/**
 * 播放历史 Store
 * v13: 管理最近播放列表（UI 持久化部分）
 */
import { create } from 'zustand';

export interface PlayHistoryItem {
  id?: string;
  songId: string;
  title: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  source: string;
  duration?: number;
  playedAt: number;
}

interface PlayHistoryState {
  /** v13 SearchPage 使用的别名 */
  records: PlayHistoryItem[];
  /** 兼容旧字段 */
  items: PlayHistoryItem[];
  addItem: (item: Omit<PlayHistoryItem, 'playedAt'>) => void;
  addRecord: (item: Omit<PlayHistoryItem, 'playedAt'>) => void;
  clear: () => void;
}

export const usePlayHistoryStore = create<PlayHistoryState>((set) => ({
  records: [],
  items: [],
  addItem: (item) =>
    set((s) => {
      const next = [{ ...item, playedAt: Date.now() }, ...s.items].slice(0, 200);
      return { items: next, records: next };
    }),
  addRecord: (item) =>
    set((s) => {
      const next = [{ ...item, playedAt: Date.now() }, ...s.records].slice(0, 200);
      return { records: next, items: next };
    }),
  clear: () => set({ items: [], records: [] }),
}));
