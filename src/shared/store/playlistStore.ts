import { create } from 'zustand';

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  coverUrl?: string;
  songCount: number;
  createdAt: number;
  updatedAt: number;
}

interface PlaylistStore {
  playlists: Playlist[];
  currentPlaylistId: string | null;
  
  addPlaylist: (name: string, description?: string) => void;
  removePlaylist: (id: string) => void;
  renamePlaylist: (id: string, name: string) => void;
  setCurrentPlaylist: (id: string | null) => void;
}

export const usePlaylistStore = create<PlaylistStore>((set) => ({
  playlists: [
    { id: 'favorites', name: '我喜欢的音乐', songCount: 0, createdAt: Date.now(), updatedAt: Date.now() },
    { id: 'recent', name: '最近播放', songCount: 0, createdAt: Date.now(), updatedAt: Date.now() },
  ],
  currentPlaylistId: null,

  addPlaylist: (name, description) =>
    set((s) => ({
      playlists: [
        ...s.playlists,
        {
          id: `pl_${Date.now()}`,
          name,
          description,
          songCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    })),

  removePlaylist: (id) =>
    set((s) => ({
      playlists: s.playlists.filter((p) => p.id !== id),
    })),

  renamePlaylist: (id, name) =>
    set((s) => ({
      playlists: s.playlists.map((p) =>
        p.id === id ? { ...p, name, updatedAt: Date.now() } : p
      ),
    })),

  setCurrentPlaylist: (id) => set({ currentPlaylistId: id }),
}));
