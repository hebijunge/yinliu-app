import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, Flame, Loader2, Music } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from '../shared/components/Toast';
import { useSearchStore } from '../shared/store/searchStore';
import { searchEngine } from '../core/search';
import { playerEngine } from '../core/player';
import { downloadEngine } from '../core/download';
import { usePlaylistStore } from '../shared/store/playlistStore';
import { usePlayHistoryStore } from '../shared/store/playHistoryStore';
import SongListItem from '../components/common/SongListItem';
import DownloadQualitySheet from '../components/common/DownloadQualitySheet';
import type { AggregatedSearchResult } from '../core/search';
import { Quality } from '../core/types';

/** 热歌榜聚合排序权重：支持的源越多越靠前；同源数按 qi→kw→mg→wy→qq→kg */
const HOT_CHART_SOURCE_PRIORITY: Record<string, number> = {
  qishui: 0,
  kuwo: 1,
  migu: 2,
  netease: 3,
  qq: 4,
  kugou: 5,
};

function getHotChartSourcePriority(sourceId: string): number {
  return HOT_CHART_SOURCE_PRIORITY[sourceId] ?? 99;
}

function sortHotChartResults(results: AggregatedSearchResult[]): AggregatedSearchResult[] {
  return [...results].sort((a, b) => {
    const aSources = a.sources.length;
    const bSources = b.sources.length;
    if (bSources !== aSources) return bSources - aSources;
    // 同源数时，按最佳源的展示优先级排序
    const aBest = a.sources[0] ? getHotChartSourcePriority(a.sources[0].sourceId) : 99;
    const bBest = b.sources[0] ? getHotChartSourcePriority(b.sources[0].sourceId) : 99;
    if (aBest !== bBest) return aBest - bBest;
    return (b.bitrate || 0) - (a.bitrate || 0);
  });
}

export default function HomePage() {
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState('');
  const [hotResults, setHotResults] = useState<AggregatedSearchResult[]>([]);
  const [isLoadingHot, setIsLoadingHot] = useState(false);
  const { selectedQuality, setQuality } = useSearchStore();
  const { records: historyRecords } = usePlayHistoryStore();
  const { favorites } = usePlaylistStore();

  // 下载音质弹窗状态
  const [downloadSheetOpen, setDownloadSheetOpen] = useState(false);
  const [downloadSheetSong, setDownloadSheetSong] = useState<AggregatedSearchResult | null>(null);

  // 加载热歌榜
  const loadHotChart = useCallback(async () => {
    setIsLoadingHot(true);
    try {
      // v17: 热歌榜聚合 — 搜索一个宽泛热词，按多源覆盖度排序
      const { results } = await searchEngine.search(
        { keyword: '热门', page: 0, pageSize: 30 },
        { timeout: 12000 }
      );
      const sorted = sortHotChartResults(results);
      setHotResults(sorted.slice(0, 50));
    } catch (err) {
      console.error('Hot chart load failed:', err);
    } finally {
      setIsLoadingHot(false);
    }
  }, []);

  useEffect(() => {
    loadHotChart();
  }, [loadHotChart]);

  const handleSearch = () => {
    if (!searchInput.trim()) return;
    navigate(`/search?q=${encodeURIComponent(searchInput.trim())}`);
  };

  const handlePlay = async (result: AggregatedSearchResult) => {
    if (!result.sources || result.sources.length === 0) {
      toast.error('暂无可用音源', '该歌曲在所有平台均无播放链接');
      return;
    }
    try {
      await playerEngine.playTrack({
        id: result.id,
        title: result.title,
        artist: result.artist,
        album: result.album,
        coverUrl: result.coverUrl,
        duration: result.duration,
        sourceId: result.sourceId,
        sourceSongId: result.sourceSongId,
        uri: `stream://${result.sourceId}/${result.sourceSongId}`,
        availableSources: result.sources.map((s) => ({
          sourceId: s.sourceId,
          sourceSongId: s.sourceSongId,
        })),
      }, selectedQuality);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '播放失败';
      toast.error('播放失败', msg);
    }
  };

  const handleMore = (result: AggregatedSearchResult) => {
    setDownloadSheetSong(result);
    setDownloadSheetOpen(true);
  };

  // 为下载弹窗生成模拟音质选项（真实实现需各源返回可下载音质列表）
  const qualityOptions = useMemo<Parameters<typeof DownloadQualitySheet>[0]['options']>(() => {
    if (!downloadSheetSong) return [];
    const opts: Parameters<typeof DownloadQualitySheet>[0]['options'] = [];
    for (const src of downloadSheetSong.sources) {
      const qualities = ['128K', '192K', '320K', '无损', 'Hi-Res'];
      for (const q of qualities) {
        opts.push({
          sourceId: src.sourceId,
          sourceName: src.sourceName,
          quality: q,
          bitrateLabel: q,
          fileSize: `${(3 + Math.random() * 48).toFixed(1)}MB`,
        });
      }
    }
    return opts;
  }, [downloadSheetSong]);

  const handleDownloadSelected = async (selectedOpts: typeof qualityOptions) => {
    if (!downloadSheetSong) return;
    for (const opt of selectedOpts) {
      try {
        const task = await downloadEngine.createTask({
          songId: downloadSheetSong.sourceSongId,
          sourceId: opt.sourceId,
          quality: selectedQuality,
          title: downloadSheetSong.title,
          artist: downloadSheetSong.artist,
          availableSources: downloadSheetSong.sources.map((s) => ({
            sourceId: s.sourceId,
            sourceSongId: s.sourceSongId,
          })),
        });
        downloadEngine.startDownload(task.id);
      } catch (err) {
        console.error('Download failed:', err);
      }
    }
    toast.success('已加入下载队列', `选中 ${selectedOpts.length} 个音质`);
    setDownloadSheetOpen(false);
  };

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6 hidden lg:block">首页</h1>

      {/* Search Box */}
      <div className="flex gap-2 mb-6">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-tertiary)]" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="搜索歌曲、歌手、专辑..."
            className="yinliu-input w-full pl-10"
          />
        </div>
        <button
          onClick={handleSearch}
          className="yinliu-btn flex items-center gap-2"
        >
          <Search className="w-4 h-4" />
          搜索
        </button>
      </div>

      {/* 音质偏好快速切换 */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {([
          { value: Quality.STANDARD, label: '标准' },
          { value: Quality.HIGH, label: '高品' },
          { value: Quality.LOSSLESS, label: '无损' },
          { value: Quality.HIRES, label: 'Hi-Res' },
        ] as const).map((q) => (
          <button
            key={q.value}
            onClick={() => setQuality(q.value)}
            className={`px-3 py-1.5 rounded-full text-sm transition-all ${
              selectedQuality === q.value
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)]'
            }`}
          >
            {q.label}
          </button>
        ))}
      </div>

      {/* 热歌榜 */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Flame className="w-5 h-5 text-orange-500" />
            多源聚合热歌榜
          </h2>
          <button
            onClick={loadHotChart}
            disabled={isLoadingHot}
            className="text-xs text-[var(--text-tertiary)] hover:text-[var(--accent)] flex items-center gap-1 transition-colors"
          >
            {isLoadingHot && <Loader2 className="w-3 h-3 animate-spin" />}
            刷新
          </button>
        </div>

        {isLoadingHot && hotResults.length === 0 && (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-[var(--bg-secondary)]">
                <div className="w-8 h-8 skeleton-shimmer rounded-lg" />
                <div className="w-12 h-12 skeleton-shimmer rounded-xl" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-1/3 skeleton-shimmer rounded" />
                  <div className="h-3 w-1/2 skeleton-shimmer rounded" />
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2">
          {hotResults.map((result, idx) => (
            <SongListItem
              key={result.id}
              result={result}
              index={idx + 1}
              showIndex={true}
              onPlay={handlePlay}
              onMore={handleMore}
            />
          ))}
        </div>

        {!isLoadingHot && hotResults.length === 0 && (
          <div className="text-center py-12 text-[var(--text-tertiary)]">
            <Music className="w-12 h-12 mx-auto mb-3 opacity-40" />
            <p>暂无热歌数据</p>
          </div>
        )}
      </section>

      {/* 下载音质弹窗 */}
      {downloadSheetOpen && downloadSheetSong && (
        <DownloadQualitySheet
          songTitle={downloadSheetSong.title}
          songArtist={downloadSheetSong.artist}
          options={qualityOptions}
          onClose={() => setDownloadSheetOpen(false)}
          onDownload={handleDownloadSelected}
          onPlay={() => {
            setDownloadSheetOpen(false);
            handlePlay(downloadSheetSong);
          }}
        />
      )}
    </div>
  );
}
