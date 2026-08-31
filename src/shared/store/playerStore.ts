import { create } from 'zustand';
import type { PlayerTrack, PlayerState } from '@core/player';
import { Quality } from '@core/types';
import { useSettingsStore } from './settingsStore';

export type RepeatMode = 'sequence' | 'repeat-all' | 'repeat-one' | 'shuffle';

interface PlayerStore {
  state: PlayerState;
  currentTrack: PlayerTrack | null;
  currentTime: number;
  duration: number;
  volume: number;
  currentQuality: Quality;
  /** 实际生效音质（由 trackLoaded 事件回写，音源降档时与 currentQuality 不同） */
  actualQuality: Quality | null;
  /** 当前曲目是否为试听片段 */
  isPreview: boolean;
  isMuted: boolean;
  /** 实际生效的音源（多源降级后可能不同于 track.sourceId） */
  actualSourceId: string | null;

  // Queue
  queue: PlayerTrack[];
  currentIndex: number;

  // Playback mode
  repeatMode: RepeatMode;

  setState: (state: PlayerState) => void;
  setTrack: (track: PlayerTrack | null) => void;
  setProgress: (currentTime: number, duration: number) => void;
  setVolume: (volume: number) => void;
  setQuality: (quality: Quality) => void;
  setActualQuality: (quality: Quality | null) => void;
  setActualSourceId: (sourceId: string | null) => void;
  setPreview: (isPreview: boolean) => void;
  toggleMute: () => void;

  // Queue actions
  setQueue: (queue: PlayerTrack[], index?: number) => void;
  addToQueue: (track: PlayerTrack) => void;
  removeFromQueue: (index: number) => void;
  moveQueueItem: (from: number, to: number) => void;
  clearQueue: () => void;
  playTrackAtIndex: (index: number) => void;

  // Mode actions
  cycleRepeatMode: () => void;
  setRepeatMode: (mode: RepeatMode) => void;
}

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  state: 'idle',
  currentTrack: null,
  currentTime: 0,
  duration: 0,
  volume: 0.8,
  currentQuality: useSettingsStore.getState().preferredQuality,
  actualQuality: null,
  isPreview: false,
  isMuted: false,
  actualSourceId: null,

  queue: [],
  currentIndex: -1,

  repeatMode: 'sequence',

  setState: (state) => set({ state }),
  setTrack: (currentTrack) => set({ currentTrack }),
  setProgress: (currentTime, duration) => set({ currentTime, duration }),
  setVolume: (volume) => set({ volume }),
  // 音质选择与设置页音质偏好共用同一持久化
  setQuality: (currentQuality) => {
    set({ currentQuality, actualQuality: null, isPreview: false });
    useSettingsStore.getState().setPreferredQuality(currentQuality);
  },
  setActualQuality: (actualQuality) => set({ actualQuality }),
  setActualSourceId: (actualSourceId) => set({ actualSourceId }),
  setPreview: (isPreview) => set({ isPreview }),
  toggleMute: () => set((s) => ({ isMuted: !s.isMuted })),


  setQueue: (queue, index = 0) =>
    set({
      queue,
      currentIndex: index >= 0 && index < queue.length ? index : queue.length > 0 ? 0 : -1,
      currentTrack: queue[index] ?? queue[0] ?? null,
    }),

  addToQueue: (track) =>
    set((s) => {
      const exists = s.queue.findIndex((t) => t.id === track.id);
      if (exists !== -1) return s; // Already in queue
      const queue = [...s.queue, track];
      return {
        queue,
        currentIndex: s.currentIndex === -1 ? 0 : s.currentIndex,
        currentTrack: s.currentTrack ?? queue[0],
      };
    }),

  removeFromQueue: (index) =>
    set((s) => {
      const queue = s.queue.filter((_, i) => i !== index);
      let currentIndex = s.currentIndex;
      if (index < s.currentIndex) {
        currentIndex = Math.max(0, s.currentIndex - 1);
      } else if (index === s.currentIndex) {
        currentIndex = Math.min(s.currentIndex, queue.length - 1);
      }
      return {
        queue,
        currentIndex,
        currentTrack: queue[currentIndex] ?? null,
      };
    }),

  moveQueueItem: (from, to) =>
    set((s) => {
      if (from === to || from < 0 || to < 0 || from >= s.queue.length || to >= s.queue.length) return s;
      const queue = [...s.queue];
      const [item] = queue.splice(from, 1);
      queue.splice(to, 0, item);
      let currentIndex = s.currentIndex;
      if (s.currentIndex === from) {
        currentIndex = to;
      } else if (from < s.currentIndex && to >= s.currentIndex) {
        currentIndex = s.currentIndex - 1;
      } else if (from > s.currentIndex && to <= s.currentIndex) {
        currentIndex = s.currentIndex + 1;
      }
      return { queue, currentIndex };
    }),

  clearQueue: () => set({ queue: [], currentIndex: -1, currentTrack: null }),

  playTrackAtIndex: (index) =>
    set((s) => ({
      currentIndex: index,
      currentTrack: s.queue[index] ?? null,
    })),

  cycleRepeatMode: () =>
    set((s) => {
      const order: RepeatMode[] = ['sequence', 'repeat-all', 'repeat-one', 'shuffle'];
      const idx = order.indexOf(s.repeatMode);
      const next = order[(idx + 1) % order.length];
      return { repeatMode: next };
    }),

  setRepeatMode: (repeatMode) => set({ repeatMode }),
}));
