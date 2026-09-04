import { useState, useEffect, useCallback } from 'react';
import { Trophy, ListMusic, Music, Loader2, AlertCircle, ChevronRight, WifiOff } from 'lucide-react';
import { CHART_CATEGORIES } from '@modules/chart/chartMappings';
import { aggregateChartsByCategory, type SourceChartResult, type AggregatedChartSong } from '@modules/chart/aggregator';
import { aggregatePlaylistsByCategory, type SourcePlaylistResult } from '@modules/playlist/aggregator';
import { playerEngine } from '@core/player';
import { useSearchStore } from '@shared/store/searchStore';
import { toast } from '@shared/components/Toast';
import EmptyState from '../components/common/EmptyState';
import { useNetworkStatus } from '@shared/hooks/useNetworkStatus';
import { allowPlayWhenOffline } from '@shared/utils/playGuard';

const SOURCE_BADGE_COLORS: Record<string, string> = {
  netease: 'bg-red-500',
  kugou: 'bg-blue-500',
  qq: 'bg-yellow-500',
  kuwo: 'bg-orange-500',
  migu: 'bg-teal-500',
};

type TabKey = 'charts' | 'playlists';

/**
 * 曲库页：「聚合榜单」+「聚合歌单」双 Tab 切换
 * - 顶部双 Tab，点击切换，只加载并显示当前 Tab 的数据
 * - 未进入的 Tab 不预拉数据，切 Tab 时按需异步加载
 * - 每个 Tab 内仍按固定分类呈现，分类下多源聚合
 */
export default function LibraryPage() {
  const { selectedQuality } = useSearchStore();

  // ===== 顶部 Tab 切换 =====
  const [activeTab, setActiveTab] = useState<TabKey>('charts');
  const { isOnline } = useNetworkStatus();

  // ===== 聚合榜单数据 =====
  const [chartCat, setChartCat] = useState(CHART_CATEGORIES[0].id);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartResults, setChartResults] = useState<SourceChartResult[]>([]);
  const [expandedChartSource, setExpandedChartSource] = useState<string | null>(null);
  const [chartsLoaded, setChartsLoaded] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);

  const loadCharts = useCallback(async (catId: string) => {
    setChartLoading(true);
    setExpandedChartSource(null);
    setChartError(null);
    // E1：断网时直接给明确空态，不静默白板
    if (!isOnline) {
      setChartResults([]);
      setChartError('当前无网络连接，请检查网络后重试');
      setChartLoading(false);
      return;
    }
    try {
      const results = await aggregateChartsByCategory(catId);
      setChartResults(results);
    } catch (err) {
      console.error('榜单加载失败:', err);
      setChartResults([]);
      setChartError(err instanceof Error ? err.message : '榜单加载失败，请稍后重试');
    } finally {
      setChartLoading(false);
    }
  }, [isOnline]);

  // ===== 聚合歌单数据 =====
  const [playlistCat, setPlaylistCat] = useState(CHART_CATEGORIES[0].id);
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [playlistResults, setPlaylistResults] = useState<SourcePlaylistResult[]>([]);
  const [expandedPlaylist, setExpandedPlaylist] = useState<string | null>(null);
  const [playlistsLoaded, setPlaylistsLoaded] = useState(false);
  const [playlistError, setPlaylistError] = useState<string | null>(null);

  const loadPlaylists = useCallback(async (catId: string) => {
    setPlaylistLoading(true);
    setExpandedPlaylist(null);
    setPlaylistError(null);
    // E1：断网时直接给明确空态，不静默白板
    if (!isOnline) {
      setPlaylistResults([]);
      setPlaylistError('当前无网络连接，请检查网络后重试');
      setPlaylistLoading(false);
      return;
    }
    try {
      const results = await aggregatePlaylistsByCategory(catId);
      setPlaylistResults(results);
    } catch (err) {
      console.error('歌单加载失败:', err);
      setPlaylistResults([]);
      setPlaylistError(err instanceof Error ? err.message : '歌单加载失败，请稍后重试');
    } finally {
      setPlaylistLoading(false);
    }
  }, [isOnline]);

  // ===== 按需加载：切 Tab 时才加载对应数据 =====
  useEffect(() => {
    if (activeTab === 'charts' && !chartsLoaded) {
      loadCharts(chartCat);
      setChartsLoaded(true);
    }
  }, [activeTab, chartsLoaded, chartCat, loadCharts]);

  useEffect(() => {
    if (activeTab === 'playlists' && !playlistsLoaded) {
      loadPlaylists(playlistCat);
      setPlaylistsLoaded(true);
    }
  }, [activeTab, playlistsLoaded, playlistCat, loadPlaylists]);

  // ===== 分类切换时重载当前 Tab 数据 =====
  useEffect(() => {
    if (activeTab === 'charts' && chartsLoaded) {
      loadCharts(chartCat);
    }
  }, [chartCat, activeTab, chartsLoaded, loadCharts]);

  useEffect(() => {
    if (activeTab === 'playlists' && playlistsLoaded) {
      loadPlaylists(playlistCat);
    }
  }, [playlistCat, activeTab, playlistsLoaded, loadPlaylists]);

  const handlePlay = async (song: AggregatedChartSong) => {
    // E1：断网时在线曲目直接拦截并提示（本地/已下载歌曲放行）
    if (!allowPlayWhenOffline({ sourceId: song.sourceId, sourceSongId: song.sourceSongId })) return;
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
      const msg = err instanceof Error ? err.message : '播放失败';
      toast.error('播放失败', msg);
    }
  };

  const chartCatName = CHART_CATEGORIES.find((c) => c.id === chartCat)?.name || '';
  const playlistCatName = CHART_CATEGORIES.find((c) => c.id === playlistCat)?.name || '';

  const TABS: { key: TabKey; label: string; icon: typeof Trophy }[] = [
    { key: 'charts', label: '聚合榜单', icon: Trophy },
    { key: 'playlists', label: '聚合歌单', icon: ListMusic },
  ];

  return (
    <div className="max-w-4xl mx-auto pb-20">
      <h1 className="text-2xl font-bold mb-6">曲库</h1>

      {/* ===== 顶部 Tab 切换 ===== */}
      <div className="flex gap-2 mb-6 border-b border-[var(--border-color)]">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-[1px] ${
              activeTab === key
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {/* ===== 聚合榜单 Tab ===== */}
      {activeTab === 'charts' && (
        <section>
          {/* 榜单分类选择器 */}
          <div className="flex gap-2 overflow-x-auto pb-2 mb-4 scrollbar-hide -mx-1 px-1">
            {CHART_CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setChartCat(cat.id)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  chartCat === cat.id
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]/80'
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>

          {/* 榜单内容 */}
          {chartLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--text-tertiary)]" />
              <span className="ml-2 text-sm text-[var(--text-tertiary)]">加载中…</span>
            </div>
          ) : chartError ? (
            <EmptyState
              icon={chartError.includes('无网络连接') ? WifiOff : AlertCircle}
              title={chartError.includes('无网络连接') ? '当前无网络连接' : '榜单加载失败'}
              description={chartError}
              onRetry={() => void loadCharts(chartCat)}
            />
          ) : chartResults.length > 0 && chartResults.every((r) => r.songs.length === 0) ? (
            <EmptyState
              icon={Music}
              title={`暂无相关榜单（${chartCatName}）`}
              description="该分类下暂时没有可用的榜单内容"
              onRetry={() => void loadCharts(chartCat)}
            />
          ) : (
            <div className="space-y-4">
              {chartResults.map((result) => (
                <div key={result.sourceId}>
                  {/* 源标题 */}
                  <div
                    className="flex items-center gap-2 mb-2 cursor-pointer"
                    onClick={() => setExpandedChartSource(
                      expandedChartSource === result.sourceId ? null : result.sourceId
                    )}
                  >
                    <span className={`w-2 h-2 rounded-full ${SOURCE_BADGE_COLORS[result.sourceId] || 'bg-gray-500'}`} />
                    <span className="text-sm font-semibold">{result.sourceName}</span>
                    <span className="text-xs text-[var(--text-tertiary)]">{result.chartName}</span>
                    {result.error && <span className="text-xs text-red-400">({result.error})</span>}
                    <ChevronRight className={`w-4 h-4 text-[var(--text-tertiary)] ml-auto transition-transform ${
                      expandedChartSource === result.sourceId ? 'rotate-90' : ''
                    }`} />
                  </div>

                  {/* 展开的歌曲列表 */}
                  {expandedChartSource === result.sourceId && (
                    <div className="ml-4 space-y-1">
                      {result.songs.length === 0 ? (
                        <p className="text-sm text-[var(--text-tertiary)] py-2">暂无数据</p>
                      ) : (
                        result.songs.map((song) => (
                          <div
                            key={`${result.sourceId}-${song.id}`}
                            onClick={() => handlePlay(song)}
                            className="flex items-center gap-3 p-2 rounded-lg hover:bg-[var(--bg-secondary)] transition-colors cursor-pointer"
                          >
                            <span className={`w-5 text-center text-xs font-bold ${
                              (song.rank || 0) <= 3 ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]'
                            }`}>
                              {song.rank}
                            </span>
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
                        ))
                      )}
                    </div>
                  )}

                  {/* 折叠时显示前3首预览 */}
                  {expandedChartSource !== result.sourceId && result.songs.length > 0 && (
                    <div className="ml-4 space-y-1">
                      {result.songs.slice(0, 3).map((song) => (
                        <div
                          key={`${result.sourceId}-${song.id}-preview`}
                          onClick={() => handlePlay(song)}
                          className="flex items-center gap-3 p-1.5 rounded-lg hover:bg-[var(--bg-secondary)] transition-colors cursor-pointer"
                        >
                          <span className={`w-5 text-center text-xs font-bold ${
                            (song.rank || 0) <= 3 ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]'
                          }`}>
                            {song.rank}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm truncate">{song.title}</div>
                            <div className="text-xs text-[var(--text-tertiary)] truncate">{song.artist}</div>
                          </div>
                        </div>
                      ))}
                      {result.songs.length > 3 && (
                        <p className="text-xs text-[var(--text-tertiary)] pl-5 py-1">
                          还有 {result.songs.length - 3} 首…
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ===== 聚合歌单 Tab ===== */}
      {activeTab === 'playlists' && (
        <section>
          {/* 歌单分类选择器 */}
          <div className="flex gap-2 overflow-x-auto pb-2 mb-4 scrollbar-hide -mx-1 px-1">
            {CHART_CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setPlaylistCat(cat.id)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  playlistCat === cat.id
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]/80'
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>

          {/* 歌单内容 */}
          {playlistLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--text-tertiary)]" />
              <span className="ml-2 text-sm text-[var(--text-tertiary)]">加载中…</span>
            </div>
          ) : playlistError ? (
            <EmptyState
              icon={playlistError.includes('无网络连接') ? WifiOff : AlertCircle}
              title={playlistError.includes('无网络连接') ? '当前无网络连接' : '歌单加载失败'}
              description={playlistError}
              onRetry={() => void loadPlaylists(playlistCat)}
            />
          ) : playlistResults.length > 0 && playlistResults.every((r) => r.playlists.length === 0) ? (
            <EmptyState
              icon={ListMusic}
              title={`暂无相关歌单（${playlistCatName}）`}
              description="该分类下暂时没有可用的歌单内容"
              onRetry={() => void loadPlaylists(playlistCat)}
            />
          ) : (
            <div className="space-y-4">
              {playlistResults.map((result) => (
                <div key={result.sourceId}>
                  {/* 源标题 */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`w-2 h-2 rounded-full ${SOURCE_BADGE_COLORS[result.sourceId] || 'bg-gray-500'}`} />
                    <span className="text-sm font-semibold">{result.sourceName}</span>
                    {result.error && <span className="text-xs text-red-400">({result.error})</span>}
                  </div>

                  {result.playlists.length === 0 ? (
                    <p className="text-sm text-[var(--text-tertiary)] py-2">暂无数据</p>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {result.playlists.map((playlist) => (
                        <div key={playlist.id}>
                          <div
                            onClick={() => setExpandedPlaylist(
                              expandedPlaylist === `${result.sourceId}-${playlist.id}`
                                ? null
                                : `${result.sourceId}-${playlist.id}`
                            )}
                            className="text-left cursor-pointer"
                          >
                            <div className="aspect-square rounded-lg overflow-hidden bg-[var(--bg-secondary)] mb-1.5">
                              {playlist.coverUrl ? (
                                <img src={playlist.coverUrl} alt={playlist.name} className="w-full h-full object-cover" loading="lazy" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                  <ListMusic className="w-8 h-8 text-[var(--text-tertiary)]" />
                                </div>
                              )}
                            </div>
                            <div className="text-xs font-medium line-clamp-2">{playlist.name}</div>
                            <div className="text-[10px] text-[var(--text-tertiary)]">{playlist.songCount} 首</div>
                          </div>

                          {/* 展开的歌曲预览 */}
                          {expandedPlaylist === `${result.sourceId}-${playlist.id}` && playlist.songs && (
                            <div className="mt-2 space-y-1">
                              {playlist.songs.map((song, idx) => (
                                <div
                                  key={`${song.id}-${idx}`}
                                  onClick={() => {
                                    playerEngine.playTrack({
                                      id: song.id,
                                      title: song.title,
                                      artist: song.artist,
                                      album: song.album,
                                      coverUrl: song.coverUrl,
                                      duration: song.duration,
                                      sourceId: song.sourceId,
                                      sourceSongId: song.sourceSongId,
                                      uri: `stream://${song.sourceId}/${song.sourceSongId}`,
                                    }, selectedQuality).catch((err) => {
                                      const msg = err instanceof Error ? err.message : '播放失败';
                                      toast.error('播放失败', msg);
                                    });
                                  }}
                                  className="flex items-center gap-2 p-1.5 rounded hover:bg-[var(--bg-secondary)] transition-colors cursor-pointer"
                                >
                                  <span className="w-4 text-center text-[10px] text-[var(--text-tertiary)]">{idx + 1}</span>
                                  <div className="flex-1 min-w-0">
                                    <div className="text-xs truncate">{song.title}</div>
                                    <div className="text-[10px] text-[var(--text-tertiary)] truncate">{song.artist}</div>
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
        </section>
      )}
    </div>
  );
}
