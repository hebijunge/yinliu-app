import { create } from 'zustand';
import type { AggregatedSearchResult } from '@core/search';
import type { MvQuality, MvSourceInfo } from '@core/types';
import { mvEngine } from '@core/mv';

interface MvSourceWithQualities extends MvSourceInfo {
  qualitiesFetched: boolean;
}

// C10 修复：请求代数计数器。旧实现异步回调只检查 isOpen——
// 快速关闭 A 再打开 B 时，A 的迟到回调会误判「仍打开」并把 A 的 URL 写进 B 的会话。
let requestGen = 0;

interface MvPlayerStore {
  isOpen: boolean;
  title: string;
  artist: string;
  coverUrl: string;
  duration: number;
  sources: MvSourceWithQualities[];
  currentSourceId: string | null;
  currentQuality: MvQuality | null;
  videoUrl: string | null;
  isLoading: boolean;
  isFetchingQualities: boolean;
  error: string | null;
  /** C10: 当前会话请求代数，用于使过期异步回调失效 */
  requestGen: number;

  openMv: (result: AggregatedSearchResult) => void;
  closeMv: () => void;
  switchSource: (sourceId: string) => void;
  switchQuality: (quality: MvQuality) => void;
}

async function fetchQualitiesForSources(sources: MvSourceWithQualities[]): Promise<MvSourceWithQualities[]> {
  const results = await Promise.all(
    sources.map(async (s) => {
      try {
        const qualities = await mvEngine.getMvQualities(s.sourceId, s.sourceMvId);
        return { ...s, availableQualities: qualities, qualitiesFetched: true };
      } catch {
        return { ...s, qualitiesFetched: true };
      }
    })
  );
  return results;
}

async function loadMvUrl(
  sourceId: string,
  mvId: string,
  quality: MvQuality
): Promise<string | null> {
  try {
    const result = await mvEngine.getMvUrl(sourceId, mvId, quality);
    return result?.url || null;
  } catch {
    return null;
  }
}

export const useMvPlayerStore = create<MvPlayerStore>((set, get) => ({
  isOpen: false,
  title: '',
  artist: '',
  coverUrl: '',
  duration: 0,
  sources: [],
  currentSourceId: null,
  currentQuality: null,
  videoUrl: null,
  isLoading: false,
  isFetchingQualities: false,
  error: null,
  requestGen: 0,

  openMv: (result) => {
    const gen = ++requestGen;
    const isStale = () => get().requestGen !== gen || !get().isOpen;
    const mvSources = result.mvSources || [];
    let sources: MvSourceWithQualities[];

    if (mvSources.length === 0) {
      // 退化：无多源信息时，用单源构造一条
      sources = [{
        sourceId: result.sourceId,
        sourceName: result.sourceId,
        sourceMvId: result.sourceSongId,
        availableQualities: [],
        qualitiesFetched: false,
      }];
    } else {
      sources = mvSources.map((s) => ({
        ...s,
        qualitiesFetched: false,
      }));
    }

    const defaultSource = sources[0];
    set({
      isOpen: true,
      title: result.title,
      artist: result.artist || '',
      coverUrl: result.coverUrl || '',
      duration: result.duration || 0,
      sources,
      currentSourceId: defaultSource.sourceId,
      currentQuality: null,
      videoUrl: result.mvUrl || null,
      isLoading: false,
      isFetchingQualities: true,
      error: null,
    });

    // 并发获取所有源的画质，然后自动加载（带请求代数守卫）
    fetchQualitiesForSources(sources).then((updatedSources) => {
      if (isStale()) return; // 已关闭或已被更新的请求取代

      const state = get();
      const currentSource = updatedSources.find((s) => s.sourceId === state.currentSourceId);
      const bestQuality = currentSource?.availableQualities?.[0] || null;

      set({
        sources: updatedSources,
        isFetchingQualities: false,
        currentQuality: bestQuality,
      });

      if (currentSource && bestQuality) {
        set({ isLoading: true, videoUrl: null, error: null });
        loadMvUrl(currentSource.sourceId, currentSource.sourceMvId, bestQuality).then((url) => {
          if (isStale()) return;
          if (url) {
            set({ videoUrl: url, isLoading: false });
          } else {
            set({ isLoading: false, error: '该源当前无法播放，请尝试切换其他来源' });
          }
        });
      }
    });
  },

  closeMv: () => {
    requestGen++; // 使在途回调全部失效
    set({
      isOpen: false,
      title: '',
      artist: '',
      coverUrl: '',
      duration: 0,
      sources: [],
      currentSourceId: null,
      currentQuality: null,
      videoUrl: null,
      isLoading: false,
      isFetchingQualities: false,
      error: null,
    });
  },

  switchSource: (sourceId) => {
    const state = get();
    const source = state.sources.find((s) => s.sourceId === sourceId);
    if (!source) return;
    const gen = ++requestGen;
    const isStale = () => get().requestGen !== gen || !get().isOpen;

    const bestQuality = source.availableQualities?.[0] || null;

    set({
      currentSourceId: sourceId,
      currentQuality: bestQuality,
      videoUrl: null,
      error: null,
      isLoading: !!bestQuality,
    });

    if (bestQuality) {
      loadMvUrl(source.sourceId, source.sourceMvId, bestQuality).then((url) => {
        if (isStale()) return;
        if (url) {
          set({ videoUrl: url, isLoading: false });
        } else {
          set({ isLoading: false, error: '该源当前无法播放，请尝试切换其他来源' });
        }
      });
    }
  },

  switchQuality: (quality) => {
    const state = get();
    const source = state.sources.find((s) => s.sourceId === state.currentSourceId);
    if (!source) return;
    const gen = ++requestGen;
    const isStale = () => get().requestGen !== gen || !get().isOpen;

    set({
      currentQuality: quality,
      videoUrl: null,
      error: null,
      isLoading: true,
    });

    loadMvUrl(source.sourceId, source.sourceMvId, quality).then((url) => {
      if (isStale()) return;
      if (url) {
        set({ videoUrl: url, isLoading: false });
      } else {
        set({ isLoading: false, error: '该画质当前无法播放，请尝试切换其他画质或来源' });
      }
    });
  },
}));
