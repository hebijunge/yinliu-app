import { useState, useCallback } from 'react';
import { Search, Loader2, Music, Filter, AlertCircle, WifiOff, ShieldAlert, Clock } from 'lucide-react';
import { useSearchStore } from '../shared/store/searchStore';
import { searchEngine } from '../core/search';
import { playerEngine } from '../core/player';
import { SkeletonSearchResult } from '../components/ui/Skeleton';
import type { AggregatedSearchResult } from '../core/search';
import { Quality } from '../core/types';

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
      const { results, sourceStats } = await searchEngine.search(
        { keyword: inputValue, page: 0, pageSize: 30 },
        { sources: selectedSources, timeout: 10000 }
      );
      setResults(results);
      setSourceStats(sourceStats);

      // 如果所有源都报错，显示聚合错误提示
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

  const handlePlay = async (result: AggregatedSearchResult) => {
    const bestSource = result.sources[0];
    if (!bestSource) return;

    await playerEngine.playTrack({
      id: result.id,
      title: result.title,
      artist: result.artist,
      album: result.album,
      coverUrl: result.coverUrl,
      duration: result.duration,
      sourceId: bestSource.sourceId,
      sourceSongId: result.sourceSongId,
      uri: `stream://${bestSource.sourceId}/${result.sourceSongId}`,
    }, selectedQuality);
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
      <h1 className="text-2xl font-bold mb-6 hidden lg:block">聚合搜索</h1>

      {/* Search Box */}
      <div className="flex gap-2 mb-4">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-tertiary)]" />
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="搜索歌曲、歌手、专辑..."
            className="yinliu-input w-full pl-10"
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
          className={`yinliu-btn-secondary ${showFilters ? 'text-[var(--accent)] ring-1 ring-[var(--accent)]/30' : ''}`}
        >
          <Filter className="w-4 h-4" />
        </button>
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="yinliu-card mb-4 space-y-3">
          <div>
            <label className="text-sm font-medium text-[var(--text-secondary)]">音质偏好</label>
            <div className="flex gap-2 mt-2 flex-wrap">
              {([Quality.STANDARD, Quality.HIGH, Quality.LOSSLESS, Quality.HIRES] as Quality[]).map((q) => (
                <button
                  key={q}
                  onClick={() => setQuality(q)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                    selectedQuality === q
                      ? 'bg-[var(--accent)] text-white shadow-sm'
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
        <div className="flex gap-2 mb-4 flex-wrap">
          {Object.entries(sourceStats).map(([id, stat]) => {
            const hasError = !!stat.error;
            const errorIcon = stat.errorType === 'network' ? <WifiOff className="w-3 h-3" />
              : stat.errorType === 'http' ? <ShieldAlert className="w-3 h-3" />
              : hasError ? <AlertCircle className="w-3 h-3" />
              : null;
            return (
              <div key={id} className={`text-xs px-3 py-1.5 rounded-full border flex items-center gap-1.5 ${hasError ? 'bg-red-500/10 text-red-400 border-red-500/20' : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border-subtle)]'}`}>
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
        <div className="mb-4">
          <div className="text-sm font-medium text-[var(--text-secondary)] mb-2">搜索历史</div>
          <div className="flex gap-2 flex-wrap">
            {searchHistory.map((h) => (
              <button
                key={h}
                onClick={() => { setInputValue(h); }}
                className="px-3 py-1.5 rounded-full text-sm bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)] hover:text-[var(--text-primary)] transition-colors border border-[var(--border-subtle)]"
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
        <div className="space-y-2">
          {results.map((result) => (
            <div
              key={result.id}
              className="flex items-center gap-3 p-3 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] hover:border-[var(--accent)]/30 hover:shadow-md transition-all duration-200 group"
            >
              <div className="w-12 h-12 rounded-xl bg-[var(--bg-tertiary)] flex-shrink-0 overflow-hidden shadow-sm ring-1 ring-[var(--border-subtle)]">
                {result.coverUrl ? (
                  <img src={result.coverUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Music className="w-5 h-5 text-[var(--text-tertiary)]" />
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{result.title}</div>
                <div className="text-sm text-[var(--text-secondary)] truncate">
                  {result.artist} {result.album && `· ${result.album}`}
                </div>
                <div className="flex gap-1 mt-1">
                  {result.sources.map((s) => (
                    <span
                      key={s.sourceId}
                      className={`text-[10px] px-1.5 py-0.5 rounded-md text-white font-medium ${sourceColors[s.sourceId] || 'bg-gray-500'}`}
                    >
                      {s.sourceName}
                    </span>
                  ))}
                </div>
              </div>

              <div className="text-xs text-[var(--text-tertiary)] hidden sm:block tabular-nums">
                {result.bitrate && `${result.bitrate}kbps`}
              </div>

              <button
                onClick={() => handlePlay(result)}
                className="p-2.5 rounded-full bg-[var(--accent)] text-white opacity-0 group-hover:opacity-100 transition-all hover:bg-[var(--accent-hover)] active:scale-95 shadow-sm focus-ring"
                title="播放"
              >
                <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Error Banner */}
      {searchError && (
        <div className="mb-4 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div className="text-sm break-all">
            <div className="font-medium mb-1">搜索出错</div>
            <div className="opacity-90">{searchError}</div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!isSearching && results.length === 0 && keyword && !searchError && (
        <div className="text-center py-16">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-[var(--bg-tertiary)] flex items-center justify-center">
            <Search className="w-8 h-8 text-[var(--text-tertiary)]" />
          </div>
          <p className="text-[var(--text-tertiary)]">未找到相关结果，请尝试其他关键词</p>
        </div>
      )}
    </div>
  );
}
