import { useState, useEffect, useCallback } from 'react';
import { ListMusic, Music, AlertCircle, ChevronRight } from 'lucide-react';
import { CHART_CATEGORIES } from '@modules/chart/chartMappings';
import { aggregatePlaylistsByCategory, type SourcePlaylistResult } from '@modules/playlist/aggregator';
import { playerEngine } from '@core/player';
import { useSearchStore } from '@shared/store/searchStore';

const SOURCE_BADGE_COLORS: Record<string, string> = {
  netease: 'bg-red-500',
  kugou: 'bg-blue-500',
  qq: 'bg-yellow-500',
  kuwo: 'bg-orange-500',
  migu: 'bg-teal-500',
};

export default function PlaylistAggregationPage() {
  const [activeCategory, setActiveCategory] = useState(CHART_CATEGORIES[0].id);
  const [loading, setLoading] = useState(false);
  const [sourceResults, setSourceResults] = useState<SourcePlaylistResult[]>([]);
  const [expandedSource, setExpandedSource] = useState<string | null>(null);
  const { selectedQuality } = useSearchStore();

  const loadCategory = useCallback(async (catId: string) => {
    setLoading(true);
    setExpandedSource(null);
    try {
      const results = await aggregatePlaylistsByCategory(catId);
      setSourceResults(results);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCategory(activeCategory);
  }, [activeCategory, loadCategory]);

  const activeCatName = CHART_CATEGORIES.find((c) => c.id === activeCategory)?.name || '';

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
        {CHART_CATEGORIES.map((cat) => (
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
      {!loading && sourceResults.length > 0 && sourceResults.every((r) => r.playlists.length === 0) && (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--text-tertiary)]">
          <AlertCircle className="w-10 h-10 mb-3" />
          <p>「{activeCatName}」分类下暂无文档映射的固定歌单/榜单</p>
          <p className="text-sm mt-1">该分类在各源的对应ID未在文档中明确给出</p>
        </div>
      )}

      {/* By Source Sections */}
      {!loading && (
        <div className="space-y-6">
          {sourceResults.map((result) => (
            <div key={result.sourceId}>
              {/* Source Header */}
              <div className="flex items-center gap-2 mb-3">
                <span className={`w-2 h-2 rounded-full ${SOURCE_BADGE_COLORS[result.sourceId] || 'bg-gray-500'}`} />
                <h3 className="font-semibold">{result.sourceName}</h3>
                {result.error && <span className="text-xs text-red-400">({result.error})</span>}
              </div>

              {result.playlists.length === 0 ? (
                <p className="text-sm text-[var(--text-tertiary)] py-2">暂无数据</p>
              ) : (
                <div className="space-y-3">
                  {result.playlists.map((playlist) => (
                    <div key={playlist.id}>
                      {/* Playlist Card */}
                      <div
                        onClick={() => setExpandedSource(
                          expandedSource === `${result.sourceId}-${playlist.id}`
                            ? null
                            : `${result.sourceId}-${playlist.id}`
                        )}
                        className="flex items-center gap-4 p-3 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] hover:border-[var(--accent)]/30 transition-all cursor-pointer"
                      >
                        <div className="w-16 h-16 rounded-lg bg-[var(--bg-primary)] overflow-hidden flex-shrink-0">
                          {playlist.coverUrl ? (
                            <img src={playlist.coverUrl} alt={playlist.name} className="w-full h-full object-cover" loading="lazy" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <ListMusic className="w-6 h-6 text-[var(--text-tertiary)]" />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{playlist.name}</div>
                          <div className="text-sm text-[var(--text-tertiary)] truncate">
                            {playlist.description}
                          </div>
                          <div className="text-xs text-[var(--text-tertiary)] mt-0.5">
                            {playlist.songCount} 首歌曲
                          </div>
                        </div>
                        <ChevronRight className={`w-5 h-5 text-[var(--text-tertiary)] transition-transform ${
                          expandedSource === `${result.sourceId}-${playlist.id}` ? 'rotate-90' : ''
                        }`} />
                      </div>

                      {/* Expanded Song List */}
                      {expandedSource === `${result.sourceId}-${playlist.id}` && playlist.songs && (
                        <div className="mt-2 ml-4 space-y-1">
                          {playlist.songs.map((song, idx) => (
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
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
