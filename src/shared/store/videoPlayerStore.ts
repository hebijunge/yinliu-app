import { create } from 'zustand';
import type { MvInfo, MvQuality, MvUrlResult } from '@core/types';


export type VideoPlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'error' | 'buffering';

export type PlaybackRate = 0.5 | 0.75 | 1 | 1.25 | 1.5 | 2;

export const PLAYBACK_RATES: PlaybackRate[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

interface VideoPlayerStore {
  state: VideoPlayerState;
  currentMv: MvInfo | null;
  currentTime: number;
  duration: number;
  buffered: number;
  volume: number;
  isMuted: boolean;
  currentQuality: MvQuality;
  availableQualities: MvQuality[];
  playbackRate: PlaybackRate;
  isFullscreen: boolean;
  isLocked: boolean;
  isControlsVisible: boolean;
  showQualitySelector: boolean;
  showRateSelector: boolean;
  errorMessage: string | null;
  /** 亮度（0-1，仅移动端手势用） */
  brightness: number;
  /** 是否正在手势操作中 */
  isGesturing: boolean;
  /** 手势提示文本 */
  gestureHint: string | null;

  setState: (state: VideoPlayerState) => void;
  setCurrentMv: (mv: MvInfo | null) => void;
  setProgress: (currentTime: number, duration: number) => void;
  setBuffered: (buffered: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  setCurrentQuality: (quality: MvQuality) => void;
  setAvailableQualities: (qualities: MvQuality[]) => void;
  setPlaybackRate: (rate: PlaybackRate) => void;
  setFullscreen: (isFullscreen: boolean) => void;
  toggleFullscreen: () => void;
  setLocked: (isLocked: boolean) => void;
  toggleLocked: () => void;
  setControlsVisible: (visible: boolean) => void;
  setShowQualitySelector: (show: boolean) => void;
  setShowRateSelector: (show: boolean) => void;
  setErrorMessage: (msg: string | null) => void;
  setBrightness: (brightness: number) => void;
  setIsGesturing: (isGesturing: boolean) => void;
  setGestureHint: (hint: string | null) => void;

  // 播放进度记忆（按 mvId 存取）
  getSavedProgress: (mvId: string) => number;
  saveProgress: (mvId: string, time: number) => void;
}

const PROGRESS_STORAGE_KEY = 'yinliu_mv_progress';

function loadProgressMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PROGRESS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveProgressMap(map: Record<string, number>) {
  try {
    localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

export const useVideoPlayerStore = create<VideoPlayerStore>((set, get) => ({
  state: 'idle',
  currentMv: null,
  currentTime: 0,
  duration: 0,
  buffered: 0,
  volume: 1,
  isMuted: false,
  currentQuality: '1080p' as MvQuality,
  availableQualities: [],
  playbackRate: 1,
  isFullscreen: false,
  isLocked: false,
  isControlsVisible: true,
  showQualitySelector: false,
  showRateSelector: false,
  errorMessage: null,
  brightness: 1,
  isGesturing: false,
  gestureHint: null,

  setState: (state) => set({ state }),
  setCurrentMv: (currentMv) => set({ currentMv }),
  setProgress: (currentTime, duration) => set({ currentTime, duration }),
  setBuffered: (buffered) => set({ buffered }),
  setVolume: (volume) => set({ volume }),
  toggleMute: () => set((s) => ({ isMuted: !s.isMuted })),
  setCurrentQuality: (currentQuality) => set({ currentQuality }),
  setAvailableQualities: (availableQualities) => set({ availableQualities }),
  setPlaybackRate: (playbackRate) => set({ playbackRate }),
  setFullscreen: (isFullscreen) => set({ isFullscreen }),
  toggleFullscreen: () => set((s) => ({ isFullscreen: !s.isFullscreen })),
  setLocked: (isLocked) => set({ isLocked }),
  toggleLocked: () => set((s) => ({ isLocked: !s.isLocked })),
  setControlsVisible: (isControlsVisible) => set({ isControlsVisible }),
  setShowQualitySelector: (showQualitySelector) => set({ showQualitySelector }),
  setShowRateSelector: (showRateSelector) => set({ showRateSelector }),
  setErrorMessage: (errorMessage) => set({ errorMessage }),
  setBrightness: (brightness) => set({ brightness }),
  setIsGesturing: (isGesturing) => set({ isGesturing }),
  setGestureHint: (gestureHint) => set({ gestureHint }),

  getSavedProgress: (mvId: string) => {
    const map = loadProgressMap();
    return map[mvId] || 0;
  },
  saveProgress: (mvId: string, time: number) => {
    const map = loadProgressMap();
    map[mvId] = time;
    saveProgressMap(map);
  },
}));
