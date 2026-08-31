import { useState, useCallback } from 'react';
import { Search, Loader2, Music, Filter, AlertCircle, WifiOff, ShieldAlert, Play, Plus } from 'lucide-react';
import { useSearchStore } from '../shared/store/searchStore';
import { searchEngine } from '../core/search';
import { playerEngine } from '../core/player';
import { usePlayerStore } from '../shared/store/playerStore';
import { SkeletonSearchResult } from '../components/ui/Skeleton';
import type { AggregatedSearchResult } from '../core/search';
import type { PlayerTrack } from '../core/player';
import { Quality } from '../core/types';
import { useSettingsStore, isSourceEnabled } from '../shared/store/settingsStore';

function resultToTrack(result: AggregatedSearchResult): PlayerTrack {
  const bestSource = result.sources[0];
  return {
    id: result.id,
    title: result.title,
    artist: result.artist,
    album: result.album,
    coverUrl: result.coverUrl,
    duration: result.duration,
    sourceId: bestSource?.sourceId ?? 'kuwo',
    sourceSongId: result.sourceSongId,
    uri: `stream://${bestSource?.sourceId ?? 'kuwo'}/${result.sourceSongId}`,
  };
}

export default function SearchPage() {
  const {
    keyword, results, isSearching, sourceStats, selectedSources, selectedQuality, searchHistory,
    setKeyword, setResults, setSearching, setSourceStats, addToHistory, setQuality,
  } = useSearchStore();

  const [inputValue, setInputValue] = useState(keyword);
  const [showFilters, setShowFilters] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const handleSearch = useCallback(async () => {
    if (!inputValue.trim()) return;

    setKeyword(inputValue);
    setSearching(true);
    setSearchError(null);
    addToHistory(inputValue);

    try {
      // 只请求启用的音源（设置页音源开关真实生效）
      const enabledSources = selectedSources.filter((id) => isSourceEnabled(useSettingsStore.getState().enabledSources, id));
      const { results, sourceStats } = await searchEngine.search(
        { keyword: inputValue, page: 0, pageSize: 30 },
        { sources: enabledSources, timeout: 10000 }
      );
      setResults(results);
      setSourceStats(sourceStats);

      const allFailed = Object.values(sourceStats).every(s => s.error);
      if (allFailed && Object.keys(sourceStats).length > 0) {
        const errors = Object.entries(sourceStats)
          .map(([id, s]) => `${id}: ${s.error}`)
          .join('; ');
        setSearchError(`所有音源请求失败 — ${errors}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '搜索异常';
      console.error('Search failed:', err);
      setSearchError(msg);
    } finally {
      setSearching(false);
    }
  }, [inputValue, selectedSources]);

  const handlePlayNow = async (result: AggregatedSearchResult) => {
    const track = resultToTrack(result);
    const store = usePlayerStore.getState();
    const existingIndex = store.queue.findIndex((t) => t.id === track.id);

    const quality = store.currentQuality;
    if (existingIndex !== -1) {
      // Already in queue — play from that position
      store.playTrackAtIndex(existingIndex);
      await playerEngine.playTrack(track, quality).catch(() => {});
    } else {
      // Insert after current index and play
      const insertIndex = store.currentIndex >= 0 ? store.currentIndex + 1 : 0;
      const newQueue = [...store.queue];
      newQueue.splice(insertIndex, 0, track);
      store.setQueue(newQueue, insertIndex);
      await playerEngine.playTrack(track, quality).catch(() => {});
    }
  };

  const handleAddToQueue = (result: AggregatedSearchResult) => {
    const track = resultToTrack(result);
    usePlayerStore.getState().addToQueue(track);
  };

  const handlePlay = async (result: AggregatedSearchResult) => {
    await handlePlayNow(result);
  };

  // 音质偏好与设置页共用同一持久化
  const handleSetQuality = (q: Quality) => {
    setQuality(q);
    useSettingsStore.getState().setPreferredQuality(q);
  };

  const sourceColors: Record<string, string> = {
    netease: 'bg-red-500',
    qq: 'bg-green-500',
    kuwo: 'bg-blue-500',
    kugou: 'bg-cyan-500',
    migu: 'bg-orange-500',
  };

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-light mb-8 hidden lg:block text-[var(--text-primary)]">聚合搜索</h1>

      {/* Search Box */}
      <div className="flex gap-3 mb-6">
        <div className="flex-1 relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-tertiary)]" />
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="搜索歌曲、歌手、专辑..."
            className="yinliu-input w-full pl-12 text-base"
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={isSearching}
          className="yinliu-btn flex items-center gap-2"
        >
          {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          搜索
        </button>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`yinliu-btn-secondary ${showFilters ? 'text-[var(--accent)] border-[var(--accent)]/30' : ''}`}
        >
          <Filter className="w-4 h-4" />
        </button>
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="yinliu-card mb-6 space-y-4">
          <div>
            <label className="text-sm font-medium text-[var(--text-secondary)]">音质偏好</label>
            <div className="flex gap-2 mt-3 flex-wrap">
              {([Quality.STANDARD, Quality.HIGH, Quality.LOSSLESS, Quality.HIRES] as Quality[]).map((q) => (
                <button
                  key={q}
                  onClick={() => handleSetQuality(q)}
                  className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                    selectedQuality === q
                      ? 'bg-[var(--accent)] text-white'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)]'
                  }`}
                >
                  {q === Quality.STANDARD && '标准'}
                  {q === Quality.HIGH && '高品'}
                  {q === Quality.LOSSLESS && '无损'}
                  {q === Quality.HIRES && 'Hi-Res'}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Source Stats */}
      {Object.keys(sourceStats).length > 0 && (
        <div className="flex gap-2 mb-6 flex-wrap">
          {Object.entries(sourceStats).map(([id, stat]) => {
            const hasError = !!stat.error;
            const errorIcon = stat.errorType === 'network' ? <WifiOff className="w-3 h-3" />
              : stat.errorType === 'http' ? <ShieldAlert className="w-3 h-3" />
              : hasError ? <AlertCircle className="w-3 h-3" />
              : null;
            return (
              <div key={id} className={`text-xs px-3 py-1.5 rounded-full border flex items-center gap-1.5 ${hasError ? 'bg-red-500/5 text-red-400 border-red-500/15' : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] border-[var(--border-subtle)]'}`}>
                <span className="font-medium">{id}</span>
                <span>{stat.total}条</span>
                <span className="text-[var(--text-tertiary)]">{stat.latency}ms</span>
                {hasError && (
                  <span className="flex items-center gap-1" title={stat.error}>
                    {errorIcon}
                    <span className="max-w-[200px] truncate">{stat.error}</span>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Search History */}
      {searchHistory.length > 0 && results.length === 0 && !isSearching && (
        <div className="mb-6">
          <div className="text-sm font-medium text-[var(--text-secondary)] mb-3">搜索历史</div>
          <div className="flex gap-2 flex-wrap">
            {searchHistory.map((h) => (
              <button
                key={h}
                onClick={() => { setInputValue(h); }}
                className="px-4 py-2 rounded-full text-sm bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--accent)] transition-colors border border-[var(--border-subtle)]"
              >
                {h}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Skeleton Loading */}
      {isSearching && (
        <SkeletonSearchResult count={6} />
      )}

      {/* Results */}
      {!isSearching && (
        <div className="space-y-3">
          {results.map((result) => (
            <div
              key={result.id}
              className="flex items-center gap-4 p-4 rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] hover:border-[var(--accent)]/30 transition-all duration-200 group"
            >
              <div className="w-14 h-14 rounded-2xl bg-[var(--bg-tertiary)] flex-shrink-0 overflow-hidden border border-[var(--border-subtle)]">
                {result.coverUrl ? (
                  <img src={result.coverUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Music className="w-5 h-5 text-[var(--text-tertiary)]" />
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="font-medium truncate text-[var(--text-primary)]">{result.title}</div>
                <div className="text-sm text-[var(--text-secondary)] truncate">
                  {result.artist} {result.album && `· ${result.album}`}
                </div>
                <div className="flex gap-1.5 mt-1.5">
                  {result.sources.map((s) => (
                    <span
                      key={s.sourceId}
                      className={`text-[10px] px-2 py-0.5 rounded-md text-white font-medium ${sourceColors[s.sourceId] || 'bg-gray-500'}`}
                    >
                      {s.sourceName}
                    </span>
                  ))}
                </div>
              </div>

              <div className="text-xs text-[var(--text-tertiary)] hidden sm:block tabular-nums">
                {result.bitrate && `${result.bitrate}kbps`}
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => handleAddToQueue(result)}
                  className="p-2.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)] opacity-0 group-hover:opacity-100 transition-all hover:bg-[var(--border)] hover:text-[var(--text-primary)] active:scale-95 focus-ring"
                  title="加入队列"
                >
                  <Plus className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handlePlay(result)}
                  className="p-3 rounded-full bg-[var(--accent)] text-white opacity-0 group-hover:opacity-100 transition-all hover:bg-[var(--accent-hover)] active:scale-95 focus-ring"
                  title="立即播放"
                >
                  <Play className="w-4 h-4 ml-0.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Error Banner */}
      {searchError && (
        <div className="mb-4 p-4 rounded-2xl bg-red-500/5 border border-red-500/15 text-red-400 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div className="text-sm break-all">
            <div className="font-medium mb-1">搜索出错</div>
            <div className="opacity-90">{searchError}</div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!isSearching && results.length === 0 && keyword && !searchError && (
        <div className="text-center py-20">
          <div className="w-16 h-16 mx-auto mb-5 rounded-3xl bg-[var(--bg-tertiary)] flex items-center justify-center">
            <Search className="w-8 h-8 text-[var(--text-tertiary)]" />
          </div>
          <p className="text-[var(--text-tertiary)]">未找到相关结果，请尝试其他关键词</p>
        </div>
      )}
    </div>
  );
}
