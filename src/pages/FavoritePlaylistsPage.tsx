import { useState, useEffect, useCallback } from 'react';
import { Heart, Music, ChevronRight, Play, Trash2, ListMusic } from 'lucide-react';
import { SOURCE_BADGE_COLORS } from '../shared/utils/sourceBadge';
import { useFavoritePlaylistStore } from '@shared/store/favoritePlaylistStore';
import { sourceRegistry } from '@providers/music/registry';
import { playerEngine } from '@core/player';
import { usePlayerStore } from '@shared/store/playerStore';
import { useSearchStore } from '@shared/store/searchStore';
import type { SearchResult } from '@core/types';
import SmartCover from '../components/ui/SmartCover';

export default function FavoritePlaylistsPage() {
  const { items, loadItems, removeFavorite } = useFavoritePlaylistStore();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [expandedSongs, setExpandedSongs] = useState<SearchResult[]>([]);
  const [expandingKey, setExpandingKey] = useState<string | null>(null);
  const { selectedQuality } = useSearchStore();

  useEffect(() => {
    loadItems();
  }, [loadItems]);

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
    if (tracks.length > 0) {
      // D9 队列语义统一：经 store 入队，保证队列视图/迷你播放器同步
      usePlayerStore.getState().setQueue(tracks, 0);
      void playerEngine.playTrack(tracks[0], selectedQuality);
    }
  }, [selectedQuality]);

  return (
    <div className="max-w-4xl mx-auto pb-20">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Heart className="w-6 h-6 text-[var(--accent)]" />
          收藏歌单
        </h1>
      </div>

      {/* Empty state */}
      {items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-[var(--text-tertiary)]">
          <Heart className="w-12 h-12 mb-3 opacity-40" />
          <p>暂无收藏歌单</p>
          <p className="text-sm mt-1">去歌单聚合页收藏喜欢的歌单吧</p>
        </div>
      )}

      {/* Playlist list */}
      <div className="space-y-3">
        {items.map((item) => {
          const key = `${item.sourceId}-${item.playlistId}`;
          return (
            <div key={key}>
              <div className="flex items-center gap-4 p-3 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] hover:border-[var(--accent)]/30 transition-all">
                <div
                  onClick={() => handleExpand(item.sourceId, item.playlistId)}
                  className="flex items-center gap-4 flex-1 min-w-0 cursor-pointer"
                >
                  <div className="w-16 h-16 rounded-lg bg-[var(--bg-primary)] overflow-hidden flex-shrink-0">
                    {item.coverUrl ? (
                      <SmartCover src={item.coverUrl} alt={item.title} className="w-full h-full" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <ListMusic className="w-6 h-6 text-[var(--text-tertiary)]" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{item.title}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] text-white ${SOURCE_BADGE_COLORS[item.sourceId] || 'bg-gray-500'}`}>
                        {item.sourceId}
                      </span>
                      {item.creator && (
                        <span className="text-xs text-[var(--text-tertiary)]">{item.creator}</span>
                      )}
                    </div>
                    <div className="text-xs text-[var(--text-tertiary)] mt-0.5">
                      {item.trackCount ?? '?'} 首歌曲
                    </div>
                  </div>
                  <ChevronRight className={`w-5 h-5 text-[var(--text-tertiary)] transition-transform flex-shrink-0 ${
                    expandedKey === key ? 'rotate-90' : ''
                  }`} />
                </div>

                {/* Remove favorite button */}
                <button
                  onClick={() => removeFavorite(item.playlistId, item.sourceId)}
                  className="flex-shrink-0 p-2 rounded-full hover:bg-red-500/10 transition-colors"
                  title="取消收藏"
                >
                  <Trash2 className="w-5 h-5 text-red-400" />
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
                              <SmartCover src={song.coverUrl} alt={song.title} className="w-full h-full" />
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
    </div>
  );
}
