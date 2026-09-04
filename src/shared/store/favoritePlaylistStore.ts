import { create } from 'zustand';
import { favoritePlaylistService, type FavoritePlaylist, type FavoritePlaylistInput } from '@shared/services/FavoritePlaylistService';

export type { FavoritePlaylist, FavoritePlaylistInput };

interface FavoritePlaylistStore {
  items: FavoritePlaylist[];
  isLoading: boolean;
  favMap: Set<string>; // key = `${sourceId}:${playlistId}`

  loadItems: () => Promise<void>;
  addFavorite: (input: FavoritePlaylistInput) => Promise<void>;
  removeFavorite: (playlistId: string, sourceId: string) => Promise<void>;
  isFavorite: (playlistId: string, sourceId: string) => boolean;
}

function makeKey(sourceId: string, playlistId: string): string {
  return `${sourceId}:${playlistId}`;
}

export const useFavoritePlaylistStore = create<FavoritePlaylistStore>((set, get) => ({
  items: [],
  isLoading: false,
  favMap: new Set(),

  loadItems: async () => {
    set({ isLoading: true });
    try {
      const items = await favoritePlaylistService.getAll();
      const favMap = new Set(items.map((i) => makeKey(i.sourceId, i.playlistId)));
      set({ items, favMap });
    } finally {
      set({ isLoading: false });
    }
  },

  addFavorite: async (input) => {
    await favoritePlaylistService.add(input);
    set((s) => {
      const newMap = new Set(s.favMap);
      newMap.add(makeKey(input.sourceId, input.playlistId));
      return { favMap: newMap };
    });
    await get().loadItems();
  },

  removeFavorite: async (playlistId, sourceId) => {
    await favoritePlaylistService.remove(playlistId, sourceId);
    set((s) => {
      const newMap = new Set(s.favMap);
      newMap.delete(makeKey(sourceId, playlistId));
      return { favMap: newMap };
    });
    await get().loadItems();
  },

  isFavorite: (playlistId, sourceId) => {
    return get().favMap.has(makeKey(sourceId, playlistId));
  },
}));
