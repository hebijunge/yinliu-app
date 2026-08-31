import { create } from 'zustand';
import { playlistService, type Playlist, type PlaylistSong } from '@shared/services/PlaylistService';
import { playlistImporter, type ImportReport, type PreviewResult } from '@modules/music/playlistImporter';

interface PlaylistStore {
  playlists: Playlist[];
  currentPlaylistId: string | null;
  currentPlaylistSongs: PlaylistSong[];
  favorites: Set<string>; // songId set for quick lookup
  isLoading: boolean;
  /** v14: 歌单导入流程状态 */
  isImporting: boolean;
  lastImportReport: ImportReport | null;

  // 初始化：从数据库加载
  loadPlaylists: () => Promise<void>;
  loadPlaylistSongs: (playlistId: string) => Promise<void>;
  loadFavorites: () => Promise<void>;

  addPlaylist: (name: string, description?: string) => Promise<void>;
  removePlaylist: (id: string) => Promise<void>;
  renamePlaylist: (id: string, name: string) => Promise<void>;
  setCurrentPlaylist: (id: string | null) => void;

  // 歌曲操作
  addSongToPlaylist: (playlistId: string, song: PlaylistSongInput) => Promise<void>;
  removeSongFromPlaylist: (playlistId: string, songId: string) => Promise<void>;
  toggleFavorite: (song: PlaylistSongInput) => Promise<void>;

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

  loadPlaylistSongs: async (playlistId) => {
    set({ isLoading: true });
    try {
      const songs = await playlistService.getPlaylistSongs(playlistId);
      set({ currentPlaylistSongs: songs });
    } finally {
      set({ isLoading: false });
    }
  },

  loadFavorites: async () => {
    const songs = await playlistService.getPlaylistSongs('favorites');
    const favSet = new Set(songs.map((s) => s.songId));
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

  addSongToPlaylist: async (playlistId, song) => {
    await playlistService.addSongToPlaylist(playlistId, song);
    await get().loadPlaylistSongs(playlistId);
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
    const isFav = await playlistService.isFavorite(song.songId);
    if (isFav) {
      await playlistService.removeFromFavorites(song.songId);
      set((s) => {
        const newFav = new Set(s.favorites);
        newFav.delete(song.songId);
        return { favorites: newFav };
      });
    } else {
      await playlistService.addToFavorites(song);
      set((s) => {
        const newFav = new Set(s.favorites);
        newFav.add(song.songId);
        return { favorites: newFav };
      });
    }
    // 刷新当前歌单歌曲列表（如果在看 favorites）
    const { currentPlaylistId } = get();
    if (currentPlaylistId) {
      await get().loadPlaylistSongs(currentPlaylistId);
    }
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
