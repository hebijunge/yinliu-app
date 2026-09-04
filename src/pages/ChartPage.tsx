import { useState, useEffect, useCallback } from 'react';
import { Trophy, Music, AlertCircle } from 'lucide-react';
import { CHART_CATEGORIES } from '@modules/chart/chartMappings';
import { aggregateChartsByCategory, mergeChartSongsByCategory, type SourceChartResult } from '@modules/chart/aggregator';
import type { AggregatedChartSong } from '@modules/chart/aggregator';
import { playerEngine } from '@core/player';
import { useSearchStore } from '@shared/store/searchStore';
import { toast } from '@shared/components/Toast';
import EmptyState from '../components/common/EmptyState';
import { toUserMessage } from '../shared/utils/errorCopy';

const SOURCE_BADGE_COLORS: Record<string, string> = {
  netease: 'bg-red-500',
  kugou: 'bg-blue-500',
  qq: 'bg-yellow-500',
  kuwo: 'bg-orange-500',
  migu: 'bg-teal-500',
};

export default function ChartPage() {
  const [activeCategory, setActiveCategory] = useState(CHART_CATEGORIES[0].id);
  const [viewMode, setViewMode] = useState<'merged' | 'bySource'>('merged');
  const [loading, setLoading] = useState(false);
  const [sourceResults, setSourceResults] = useState<SourceChartResult[]>([]);
  const [mergedSongs, setMergedSongs] = useState<AggregatedChartSong[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { selectedQuality } = useSearchStore();

  const loadCategory = useCallback(async (catId: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const results = await aggregateChartsByCategory(catId);
      setSourceResults(results);
      const merged = await mergeChartSongsByCategory(catId, 20);
      setMergedSongs(merged);
    } catch (err) {
      console.error('榜单加载失败:', err);
      setSourceResults([]);
      setMergedSongs([]);
      setLoadError(toUserMessage(err, '榜单加载失败，请稍后重试'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCategory(activeCategory);
  }, [activeCategory, loadCategory]);

  const activeCatName = CHART_CATEGORIES.find((c) => c.id === activeCategory)?.name || '';

  const handlePlay = async (song: AggregatedChartSong) => {
    try {
      await playerEngine.playTrack({
        id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        coverUrl: song.coverUrl,
        duration: song.duration,
        sourceId: song.sourceId,
        sourceSongId: song.sourceSongId,
        uri: `stream://${song.sourceId}/${song.sourceSongId}`,
      }, selectedQuality);
    } catch (err) {
      const msg = toUserMessage(err, '播放失败');
      toast.error('播放失败', msg);
    }
  };

  return (
    <div className="max-w-4xl mx-auto pb-20">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Trophy className="w-6 h-6 text-[var(--accent)]" />
          榜单聚合
        </h1>
        <div className="flex gap-2">
          <button
            onClick={() => setViewMode('merged')}
            className={`px-3 py-1.5 rounded-full text-sm ${
              viewMode === 'merged'
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]'
            }`}
          >
            混合排行
          </button>
          <button
            onClick={() => setViewMode('bySource')}
            className={`px-3 py-1.5 rounded-full text-sm ${
              viewMode === 'bySource'
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]'
            }`}
          >
            分源展示
          </button>
        </div>
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

      {/* Load Error：错误态 + 重试 */}
      {!loading && loadError && (
        <EmptyState
          icon={AlertCircle}
          title="榜单加载失败"
          description={loadError}
          onRetry={() => void loadCategory(activeCategory)}
        />
      )}

      {/* Empty：用户可读文案 */}
      {!loading && !loadError && sourceResults.length > 0 && sourceResults.every((r) => r.songs.length === 0) && (
        <EmptyState
          icon={Music}
          title={`暂无相关榜单（${activeCatName}）`}
          description="该分类下暂时没有可用的榜单内容"
          onRetry={() => void loadCategory(activeCategory)}
        />
      )}

      {/* Merged View */}
      {!loading && viewMode === 'merged' && mergedSongs.length > 0 && (
        <div className="space-y-1">
          {mergedSongs.map((song, idx) => (
            <div
              key={`${song.sourceId}-${song.id}-${idx}`}
              onClick={() => handlePlay(song)}
              className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-[var(--bg-secondary)] transition-colors cursor-pointer group"
            >
              <span className={`w-8 text-center text-sm font-bold ${
                idx < 3 ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]'
              }`}>
                {idx + 1}
              </span>
              <div className="w-12 h-12 rounded-lg bg-[var(--bg-secondary)] overflow-hidden flex-shrink-0">
                {song.coverUrl ? (
                  <img src={song.coverUrl} alt={song.title} className="w-full h-full object-cover" loading="lazy" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Music className="w-5 h-5 text-[var(--text-tertiary)]" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{song.title}</div>
                <div className="text-sm text-[var(--text-tertiary)] truncate">
                  {song.artist} {song.album ? `· ${song.album}` : ''}
                </div>
              </div>
              <span className={`px-2 py-0.5 rounded text-[10px] text-white ${SOURCE_BADGE_COLORS[song.sourceId] || 'bg-gray-500'}`}>
                {song.sourceName}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* By Source View */}
      {!loading && viewMode === 'bySource' && (
        <div className="space-y-6">
          {sourceResults.map((result) => (
            <div key={result.sourceId}>
              <div className="flex items-center gap-2 mb-2">
                <span className={`w-2 h-2 rounded-full ${SOURCE_BADGE_COLORS[result.sourceId] || 'bg-gray-500'}`} />
                <h3 className="font-semibold">{result.sourceName}</h3>
                <span className="text-xs text-[var(--text-tertiary)]">{result.chartName}</span>
                {result.error && <span className="text-xs text-red-400">({result.error})</span>}
              </div>
              {result.songs.length === 0 ? (
                <p className="text-sm text-[var(--text-tertiary)] py-2">暂无数据</p>
              ) : (
                <div className="space-y-1">
                  {result.songs.map((song) => (
                    <div
                      key={`${result.sourceId}-${song.id}`}
                      onClick={() => handlePlay(song)}
                      className="flex items-center gap-3 p-2 rounded-xl hover:bg-[var(--bg-secondary)] transition-colors cursor-pointer"
                    >
                      <span className={`w-6 text-center text-sm font-bold ${
                        (song.rank || 0) <= 3 ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]'
                      }`}>
                        {song.rank}
                      </span>
                      <div className="w-10 h-10 rounded-lg bg-[var(--bg-secondary)] overflow-hidden flex-shrink-0">
                        {song.coverUrl ? (
                          <img src={song.coverUrl} alt={song.title} className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Music className="w-4 h-4 text-[var(--text-tertiary)]" />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">{song.title}</div>
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
  );
}
