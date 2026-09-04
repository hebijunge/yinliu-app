import { create } from 'zustand';
import { normalizeTitle, normalizeArtist } from '@core/search';
import { playlistService, type Playlist, type PlaylistSong } from '@shared/services/PlaylistService';
import { playlistImporter, type ImportReport, type PreviewResult } from '@modules/music/playlistImporter';

/** 跨源归一化收藏键：基于歌名+歌手归一化，同一首歌不同平台共享同一键 */
function makeFavoriteKey(title: string, artist?: string): string {
  return `${normalizeTitle(title)}|${normalizeArtist(artist || '')}`;
}

interface PlaylistStore {
  playlists: Playlist[];
  currentPlaylistId: string | null;
  currentPlaylistSongs: PlaylistSong[];
  /** 收藏归一化键集合（跨源去重：同一首歌不同平台视为同一收藏） */
  favorites: Set<string>;
  isLoading: boolean;
  /** P6: 已完整加载歌曲列表的歌单 id；用于 StrictMode 双发去重与「同歌单不重复读库」 */
  loadedPlaylistId: string | null;
  /** v14: 歌单导入流程状态 */
  isImporting: boolean;
  lastImportReport: ImportReport | null;

  // 初始化：从数据库加载
  loadPlaylists: () => Promise<void>;
  loadPlaylistSongs: (playlistId: string, opts?: { force?: boolean }) => Promise<void>;
  loadFavorites: () => Promise<void>;

  addPlaylist: (name: string, description?: string) => Promise<void>;
  removePlaylist: (id: string) => Promise<void>;
  renamePlaylist: (id: string, name: string) => Promise<void>;
  setCurrentPlaylist: (id: string | null) => void;
  /** 歌单无封面且有歌曲时，取第一首歌封面作为歌单封面（懒补齐并持久化） */
  refreshPlaylistCovers: () => Promise<void>;

  // 歌曲操作
  addSongToPlaylist: (playlistId: string, song: PlaylistSongInput) => Promise<void>;
  removeSongFromPlaylist: (playlistId: string, songId: string) => Promise<void>;
  toggleFavorite: (song: PlaylistSongInput) => Promise<void>;
  /** 按归一化键判断歌曲是否已收藏（支持跨源） */
  isFavorite: (song: { title: string; artist?: string }) => boolean;

  // v14: 多平台歌单导入
  previewPlaylistUrl: (url: string) => Promise<PreviewResult>;
  importPlaylistFromUrl: (url: string) => Promise<ImportReport>;
  clearLastImportReport: () => void;
}

export interface PlaylistSongInput {
  songId: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  coverUrl?: string;
  source: string;
  quality: string;
}

export const usePlaylistStore = create<PlaylistStore>((set, get) => ({
  playlists: [],
  currentPlaylistId: null,
  currentPlaylistSongs: [],
  favorites: new Set(),
  isLoading: false,
  loadedPlaylistId: null,
  isImporting: false,
  lastImportReport: null,

  loadPlaylists: async () => {
    set({ isLoading: true });
    try {
      const playlists = await playlistService.getAllPlaylists();
      set({ playlists });
    } finally {
      set({ isLoading: false });
    }
  },

  loadPlaylistSongs: async (playlistId, opts) => {
    const force = opts?.force ?? false;
    const state = get();
    // P6 ① in-flight 合并去重：同一歌单加载中，StrictMode 双发/重复触发直接跳过
    if (!force && state.isLoading && state.loadedPlaylistId === playlistId) return;
    // P6 ② 已加载过同一歌单且非强制：不重复读库（连续进出同一歌单只读一次）
    if (!force && !state.isLoading && state.loadedPlaylistId === playlistId) return;
    // P6 ③ 切歌单：先清空旧数据防串单，骨架屏立即可见
    const switching = state.loadedPlaylistId !== playlistId;
    set({
      isLoading: true,
      loadedPlaylistId: playlistId,
      ...(switching ? { currentPlaylistSongs: [] } : {}),
    });
    try {
      const songs = await playlistService.getPlaylistSongs(playlistId);
      // 期间用户已切走：丢弃本次结果，避免写入别个歌单的视图
      if (get().loadedPlaylistId !== playlistId) return;
      set({ currentPlaylistSongs: songs, isLoading: false });
    } catch (e) {
      if (get().loadedPlaylistId === playlistId) set({ isLoading: false });
      throw e;
    }
  },

  loadFavorites: async () => {
    const songs = await playlistService.getPlaylistSongs('favorites');
    const favSet = new Set(songs.map((s) => makeFavoriteKey(s.title, s.artist)));
    set({ favorites: favSet });
  },

  addPlaylist: async (name, description) => {
    await playlistService.createPlaylist(name, description);
    await get().loadPlaylists();
  },

  removePlaylist: async (id) => {
    await playlistService.deletePlaylist(id);
    set((s) => ({
      playlists: s.playlists.filter((p) => p.id !== id),
      currentPlaylistId: s.currentPlaylistId === id ? null : s.currentPlaylistId,
      loadedPlaylistId: s.loadedPlaylistId === id ? null : s.loadedPlaylistId,
    }));
  },

  renamePlaylist: async (id, name) => {
    await playlistService.renamePlaylist(id, name);
    set((s) => ({
      playlists: s.playlists.map((p) =>
        p.id === id ? { ...p, name, updatedAt: Date.now() } : p
      ),
    }));
  },

  setCurrentPlaylist: (id) => set({ currentPlaylistId: id }),

  refreshPlaylistCovers: async () => {
    const playlists = get().playlists;
    // 仅处理「无封面但有歌曲」的歌单；本地 sqlite 查询，逐个补齐即可
    const pending = playlists.filter((p) => !p.coverUrl && p.songCount > 0);
    let changed = false;
    const covers = new Map<string, string>();
    for (const p of pending) {
      try {
        const songs = await playlistService.getPlaylistSongs(p.id);
        const firstCover = songs.find((s) => s.coverUrl)?.coverUrl;
        if (firstCover) {
          covers.set(p.id, firstCover);
          await playlistService.setPlaylistCover(p.id, firstCover);
          changed = true;
        }
      } catch {
        // 单个歌单封面补齐失败不影响其余
      }
    }
    if (changed) {
      set((s) => ({
        playlists: s.playlists.map((p) =>
          covers.has(p.id) ? { ...p, coverUrl: covers.get(p.id) } : p
        ),
      }));
    }
  },

  addSongToPlaylist: async (playlistId, song) => {
    // 同歌单同源去重：同一平台同一 songId 不重复添加
    const exists = get().currentPlaylistSongs.some(
      (s) => s.playlistId === playlistId && s.songId === song.songId && s.source === song.source
    );
    if (exists) {
      return;
    }
    await playlistService.addSongToPlaylist(playlistId, song);
    // 歌单无封面时取第一首歌封面作为歌单封面
    const target = get().playlists.find((p) => p.id === playlistId);
    if (!target?.coverUrl && song.coverUrl) {
      try {
        await playlistService.setPlaylistCover(playlistId, song.coverUrl);
      } catch {
        // 封面写入失败不影响加歌主流程
      }
    }
    await get().loadPlaylistSongs(playlistId, { force: true }); // 增歌后强制刷新当前视图
    await get().loadPlaylists(); // 刷新 songCount
  },

  removeSongFromPlaylist: async (playlistId, songId) => {
    await playlistService.removeSongFromPlaylist(playlistId, songId);
    set((s) => ({
      currentPlaylistSongs: s.currentPlaylistSongs.filter((song) => song.songId !== songId),
    }));
    await get().loadPlaylists();
  },

  toggleFavorite: async (song) => {
    const normKey = makeFavoriteKey(song.title, song.artist);
    const isFav = get().favorites.has(normKey);
    if (isFav) {
      await playlistService.removeFromFavoritesByNormKey(song.title, song.artist);
      set((s) => {
        const newFav = new Set(s.favorites);
        newFav.delete(normKey);
        return { favorites: newFav };
      });
    } else {
      await playlistService.addToFavorites(song);
      set((s) => {
        const newFav = new Set(s.favorites);
        newFav.add(normKey);
        return { favorites: newFav };
      });
    }
    // 刷新当前歌单歌曲列表（如果在看 favorites）
    const { currentPlaylistId } = get();
    if (currentPlaylistId) {
      await get().loadPlaylistSongs(currentPlaylistId, { force: true });
    }
  },

  isFavorite: (song) => {
    return get().favorites.has(makeFavoriteKey(song.title, song.artist));
  },

  // === v14: 多平台歌单导入 ===

  /** 仅预览：解析 URL + 抓源歌单，不落库 */
  previewPlaylistUrl: async (url: string) => {
    return playlistImporter.preview(url);
  },

  /**
   * 完整导入：解析 → 跨平台匹配降级 → 落库
   * 流程较长（每首曲目需取链探活），UI 应在调用前进入 loading 态
   */
  importPlaylistFromUrl: async (url: string) => {
    set({ isImporting: true });
    try {
      const report = await playlistImporter.importAndPersist(url);
      set({ lastImportReport: report });
      // 刷新歌单列表（新增了导入歌单）
      await get().loadPlaylists();
      return report;
    } finally {
      set({ isImporting: false });
    }
  },

  clearLastImportReport: () => set({ lastImportReport: null }),
}));
