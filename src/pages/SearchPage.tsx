import { useState, useCallback } from 'react';
import { Search, Loader2, Music, Filter } from 'lucide-react';
import { useSearchStore } from '../shared/store/searchStore';
import { searchEngine } from '../core/search';
import { playerEngine } from '../core/player';
import { downloadEngine } from '../core/download';
import type { AggregatedSearchResult } from '../core/search';
import { Quality } from '../core/types';

export default function SearchPage() {
  const {
    keyword, results, isSearching, sourceStats, selectedSources, selectedQuality, searchHistory,
    setKeyword, setResults, setSearching, setSourceStats, addToHistory, setQuality,
  } = useSearchStore();

  const [inputValue, setInputValue] = useState(keyword);
  const [showFilters, setShowFilters] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!inputValue.trim()) return;
    
    setKeyword(inputValue);
    setSearching(true);
    addToHistory(inputValue);

    try {
      const { results, sourceStats } = await searchEngine.search(
        { keyword: inputValue, page: 0, pageSize: 30 },
        { sources: selectedSources, timeout: 10000 }
      );
      setResults(results);
      setSourceStats(sourceStats);
    } catch (err) {
      console.error('Search failed:', err);
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

  const handleDownload = async (result: AggregatedSearchResult) => {
    const bestSource = result.sources[0];
    if (!bestSource) return;

    const task = await downloadEngine.createTask({
      songId: result.sourceSongId,
      sourceId: bestSource.sourceId,
      quality: selectedQuality,
      title: result.title,
      artist: result.artist,
    });

    // 自动开始下载
    downloadEngine.startDownload(task.id);
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
          className={`yinliu-btn-secondary ${showFilters ? 'text-[var(--accent)]' : ''}`}
        >
          <Filter className="w-4 h-4" />
        </button>
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="yinliu-card mb-4 space-y-3">
          <div>
            <label className="text-sm font-medium text-[var(--text-secondary)]">音质偏好</label>
            <div className="flex gap-2 mt-1 flex-wrap">
              {([Quality.STANDARD, Quality.HIGH, Quality.LOSSLESS, Quality.HIRES] as Quality[]).map((q) => (
                <button
                  key={q}
                  onClick={() => setQuality(q)}
                  className={`px-3 py-1 rounded-full text-sm ${
                    selectedQuality === q
                      ? 'bg-[var(--accent)] text-white'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
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
        <div className="flex gap-3 mb-4 flex-wrap">
          {Object.entries(sourceStats).map(([id, stat]) => (
            <div key={id} className="text-xs px-2 py-1 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
              {id}: {stat.total}条 {stat.latency}ms {stat.error && <span className="text-red-500">(错误)</span>}
            </div>
          ))}
        </div>
      )}

      {/* Search History */}
      {searchHistory.length > 0 && results.length === 0 && !isSearching && (
        <div className="mb-4">
          <div className="text-sm text-[var(--text-secondary)] mb-2">搜索历史</div>
          <div className="flex gap-2 flex-wrap">
            {searchHistory.map((h) => (
              <button
                key={h}
                onClick={() => { setInputValue(h); }}
                className="px-3 py-1 rounded-full text-sm bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)]"
              >
                {h}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Results */}
      <div className="space-y-2">
        {results.map((result) => (
          <div
            key={result.id}
            className="flex items-center gap-3 p-3 rounded-lg bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors group"
          >
            <div className="w-12 h-12 rounded-lg bg-[var(--bg-tertiary)] flex-shrink-0 overflow-hidden">
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
                    className={`text-[10px] px-1.5 py-0.5 rounded text-white ${sourceColors[s.sourceId] || 'bg-gray-500'}`}
                  >
                    {s.sourceName}
                  </span>
                ))}
              </div>
            </div>

            <div className="text-xs text-[var(--text-tertiary)] hidden sm:block">
              {result.bitrate && `${result.bitrate}kbps`}
            </div>

            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => handlePlay(result)}
                className="p-2 rounded-full bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]"
                title="播放"
              >
                <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </button>
              <button
                onClick={() => handleDownload(result)}
                className="p-2 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)]"
                title="下载"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Empty state */}
      {!isSearching && results.length === 0 && keyword && (
        <div className="text-center py-12 text-[var(--text-tertiary)]">
          未找到相关结果，请尝试其他关键词
        </div>
      )}
    </div>
  );
}
