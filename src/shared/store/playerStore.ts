import { create } from 'zustand';
import type { PlayerTrack, PlayerState } from '@core/player';
import { Quality } from '@core/types';

interface PlayerStore {
  state: PlayerState;
  currentTrack: PlayerTrack | null;
  currentTime: number;
  duration: number;
  volume: number;
  currentQuality: Quality;
  isMuted: boolean;
  
  setState: (state: PlayerState) => void;
  setTrack: (track: PlayerTrack | null) => void;
  setProgress: (currentTime: number, duration: number) => void;
  setVolume: (volume: number) => void;
  setQuality: (quality: Quality) => void;
  toggleMute: () => void;
}

export const usePlayerStore = create<PlayerStore>((set) => ({
  state: 'idle',
  currentTrack: null,
  currentTime: 0,
  duration: 0,
  volume: 0.8,
  currentQuality: Quality.STANDARD,
  isMuted: false,

  setState: (state) => set({ state }),
  setTrack: (currentTrack) => set({ currentTrack }),
  setProgress: (currentTime, duration) => set({ currentTime, duration }),
  setVolume: (volume) => set({ volume }),
  setQuality: (currentQuality) => set({ currentQuality }),
  toggleMute: () => set((s) => ({ isMuted: !s.isMuted })),
}));
