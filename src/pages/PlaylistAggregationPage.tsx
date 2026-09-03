import { useState, useEffect, useCallback } from 'react';
import { ListMusic, Music, AlertCircle, ChevronRight, Heart, Play } from 'lucide-react';
import { PLAYLIST_CATEGORIES, getCategoryPlaylists, type SourcePlaylistGroup } from '@core/playlistCategories';
import { sourceRegistry } from '@providers/music/registry';
import { playerEngine } from '@core/player';
import { useSearchStore } from '@shared/store/searchStore';
import { useFavoritePlaylistStore } from '@shared/store/favoritePlaylistStore';
import type { SearchResult } from '@core/types';

const SOURCE_BADGE_COLORS: Record<string, string> = {
  netease: 'bg-red-500',
  kugou: 'bg-blue-500',
  qq: 'bg-yellow-500',
  kuwo: 'bg-orange-500',
  migu: 'bg-teal-500',
  qishui: 'bg-purple-500',
  bilibili: 'bg-pink-500',
};

export default function PlaylistAggregationPage() {
  const [activeCategory, setActiveCategory] = useState(PLAYLIST_CATEGORIES[0].id);
  const [loading, setLoading] = useState(false);
  const [sourceGroups, setSourceGroups] = useState<SourcePlaylistGroup[]>([]);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [expandedSongs, setExpandedSongs] = useState<SearchResult[]>([]);
  const [expandingKey, setExpandingKey] = useState<string | null>(null);
  const { selectedQuality } = useSearchStore();
  const { favMap, addFavorite, removeFavorite, isFavorite } = useFavoritePlaylistStore();

  const loadCategory = useCallback(async (catId: string) => {
    setLoading(true);
    setExpandedKey(null);
    setExpandedSongs([]);
    try {
      const catName = PLAYLIST_CATEGORIES.find((c) => c.id === catId)?.name || catId;
      const groups = await getCategoryPlaylists(catName, 0);
      setSourceGroups(groups);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCategory(activeCategory);
  }, [activeCategory, loadCategory]);

  const activeCatName = PLAYLIST_CATEGORIES.find((c) => c.id === activeCategory)?.name || '';

  const handleToggleFavorite = useCallback(async (playlist: {
    id: string;
    title: string;
    coverUrl?: string;
    creator?: string;
    playCount?: number;
    trackCount?: number;
  }, sourceId: string) => {
    const fav = isFavorite(playlist.id, sourceId);
    if (fav) {
      await removeFavorite(playlist.id, sourceId);
    } else {
      await addFavorite({
        playlistId: playlist.id,
        sourceId,
        title: playlist.title,
        coverUrl: playlist.coverUrl,
        creator: playlist.creator,
        playCount: playlist.playCount,
        trackCount: playlist.trackCount,
      });
    }
  }, [addFavorite, removeFavorite, isFavorite]);

  const handleExpand = useCallback(async (sourceId: string, playlistId: string) => {
    const key = `${sourceId}-${playlistId}`;
    if (expandedKey === key) {
      setExpandedKey(null);
      setExpandedSongs([]);
      return;
    }
    setExpandingKey(key);
    setExpandedKey(key);
    try {
      const provider = sourceRegistry.get(sourceId);
      if (provider && provider.getPlaylist) {
        const detail = await provider.getPlaylist(playlistId);
        setExpandedSongs(detail.songs || []);
      } else {
        setExpandedSongs([]);
      }
    } catch {
      setExpandedSongs([]);
    } finally {
      setExpandingKey(null);
    }
  }, [expandedKey]);

  const handlePlayAll = useCallback((songs: SearchResult[]) => {
    if (songs.length === 0) return;
    const tracks = songs.map((s) => ({
      id: s.id,
      title: s.title,
      artist: s.artist,
      album: s.album,
      coverUrl: s.coverUrl,
      duration: s.duration,
      sourceId: s.sourceId,
      sourceSongId: s.sourceSongId,
      uri: `stream://${s.sourceId}/${s.sourceSongId}`,
    }));
    void playerEngine.playQueue(tracks, selectedQuality);
  }, [selectedQuality]);

  return (
    <div className="max-w-4xl mx-auto pb-20">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ListMusic className="w-6 h-6 text-[var(--accent)]" />
          歌单聚合
        </h1>
      </div>

      {/* Category Capsules */}
      <div className="flex gap-2 overflow-x-auto pb-3 mb-4 scrollbar-hide">
        {PLAYLIST_CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            onClick={() => setActiveCategory(cat.id)}
            className={`px-4 py-2 rounded-full text-sm whitespace-nowrap transition-colors ${
              activeCategory === cat.id
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]/80'
            }`}
          >
            {cat.name}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent)]" />
        </div>
      )}

      {/* Empty */}
      {!loading && sourceGroups.length > 0 && sourceGroups.every((g) => g.playlists.length === 0) && (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--text-tertiary)]">
          <AlertCircle className="w-10 h-10 mb-3" />
          <p>「{activeCatName}」分类下暂无歌单</p>
          <p className="text-sm mt-1">该分类在各源未提供对应数据</p>
        </div>
      )}

      {/* By Source Sections */}
      {!loading && (
        <div className="space-y-6">
          {sourceGroups.map((group) => (
            <div key={group.sourceId}>
              {/* Source Header */}
              <div className="flex items-center gap-2 mb-3">
                <span className={`w-2 h-2 rounded-full ${SOURCE_BADGE_COLORS[group.sourceId] || 'bg-gray-500'}`} />
                <h3 className="font-semibold">{group.sourceName}</h3>
              </div>

              {group.playlists.length === 0 ? (
                <p className="text-sm text-[var(--text-tertiary)] py-2">暂无数据</p>
              ) : (
                <div className="space-y-3">
                  {group.playlists.map((playlist) => {
                    const key = `${group.sourceId}-${playlist.id}`;
                    const fav = isFavorite(playlist.id, group.sourceId);
                    return (
                      <div key={playlist.id}>
                        {/* Playlist Card */}
                        <div className="flex items-center gap-4 p-3 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] hover:border-[var(--accent)]/30 transition-all">
                          <div
                            onClick={() => handleExpand(group.sourceId, playlist.id)}
                            className="flex items-center gap-4 flex-1 min-w-0 cursor-pointer"
                          >
                            <div className="w-16 h-16 rounded-lg bg-[var(--bg-primary)] overflow-hidden flex-shrink-0">
                              {playlist.coverUrl ? (
                                <img src={playlist.coverUrl} alt={playlist.title} className="w-full h-full object-cover" loading="lazy" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                  <ListMusic className="w-6 h-6 text-[var(--text-tertiary)]" />
                                </div>
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="font-medium truncate">{playlist.title}</div>
                              <div className="text-sm text-[var(--text-tertiary)] truncate">
                                {playlist.creator || `${group.sourceName}官方歌单`}
                              </div>
                              <div className="text-xs text-[var(--text-tertiary)] mt-0.5">
                                {playlist.trackCount ?? '?'} 首歌曲
                                {playlist.playCount ? ` · ${formatPlayCount(playlist.playCount)}播放` : ''}
                              </div>
                            </div>
                            <ChevronRight className={`w-5 h-5 text-[var(--text-tertiary)] transition-transform flex-shrink-0 ${
                              expandedKey === key ? 'rotate-90' : ''
                            }`} />
                          </div>

                          {/* Favorite button */}
                          <button
                            onClick={() => handleToggleFavorite(playlist, group.sourceId)}
                            className="flex-shrink-0 p-2 rounded-full hover:bg-[var(--bg-primary)] transition-colors"
                            title={fav ? '取消收藏' : '收藏歌单'}
                          >
                            <Heart className={`w-5 h-5 ${fav ? 'fill-red-500 text-red-500' : 'text-[var(--text-tertiary)]'}`} />
                          </button>
                        </div>

                        {/* Expanded Song List */}
                        {expandedKey === key && (
                          <div className="mt-2 ml-4 space-y-1">
                            {expandingKey === key ? (
                              <div className="flex items-center justify-center py-4">
                                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-[var(--accent)]" />
                              </div>
                            ) : expandedSongs.length === 0 ? (
                              <p className="text-sm text-[var(--text-tertiary)] py-2">暂无歌曲预览</p>
                            ) : (
                              <>
                                <button
                                  onClick={() => handlePlayAll(expandedSongs)}
                                  className="flex items-center gap-2 px-3 py-1.5 mb-2 rounded-lg bg-[var(--accent)]/10 text-[var(--accent)] text-sm hover:bg-[var(--accent)]/20 transition-colors"
                                >
                                  <Play className="w-4 h-4" />
                                  播放全部（{expandedSongs.length} 首）
                                </button>
                                {expandedSongs.map((song, idx) => (
                                  <div
                                    key={`${song.id}-${idx}`}
                                    onClick={() => playerEngine.playTrack({
                                      id: song.id,
                                      title: song.title,
                                      artist: song.artist,
                                      album: song.album,
                                      coverUrl: song.coverUrl,
                                      duration: song.duration,
                                      sourceId: song.sourceId,
                                      sourceSongId: song.sourceSongId,
                                      uri: `stream://${song.sourceId}/${song.sourceSongId}`,
                                    }, selectedQuality)}
                                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-[var(--bg-secondary)]/50 transition-colors cursor-pointer"
                                  >
                                    <span className="w-5 text-center text-xs text-[var(--text-tertiary)]">{idx + 1}</span>
                                    <div className="w-8 h-8 rounded bg-[var(--bg-secondary)] overflow-hidden flex-shrink-0">
                                      {song.coverUrl ? (
                                        <img src={song.coverUrl} alt={song.title} className="w-full h-full object-cover" loading="lazy" />
                                      ) : (
                                        <div className="w-full h-full flex items-center justify-center">
                                          <Music className="w-3 h-3 text-[var(--text-tertiary)]" />
                                        </div>
                                      )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="text-sm font-medium truncate">{song.title}</div>
                                      <div className="text-xs text-[var(--text-tertiary)] truncate">{song.artist}</div>
                                    </div>
                                  </div>
                                ))}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatPlayCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}
