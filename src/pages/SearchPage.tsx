import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Search, Loader2, Music, Filter, Heart, Clock, ListMusic, Plus, Compass, Play, MoreVertical, Download } from 'lucide-react';
import { toast } from '../shared/components/Toast';
import { useSearchStore } from '../shared/store/searchStore';
import { searchEngine } from '../core/search';
import { playerEngine } from '../core/player';
import { downloadEngine } from '../core/download';
import { usePlaylistStore } from '../shared/store/playlistStore';
import { usePlayHistoryStore } from '../shared/store/playHistoryStore';
import type { AggregatedSearchResult } from '../core/search';
import { Quality } from '../core/types';

const SOURCE_COLORS: Record<string, string> = {
  netease: 'bg-red-500',
  qq: 'bg-green-500',
  kuwo: 'bg-blue-500',
  kugou: 'bg-cyan-500',
  migu: 'bg-orange-500',
};

/** v16 封面加载失败兜底：死链/防盗链图片自动回退占位图标，避免空白块 */
function CoverImg({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !src) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <Music className="w-5 h-5 text-[var(--text-tertiary)]" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      className="w-full h-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function SearchPage() {
  const {
    keyword, results, isSearching, sourceStats, selectedSources, selectedQuality, searchHistory,
    setKeyword, setResults, setSearching, setSourceStats, addToHistory, setQuality,
  } = useSearchStore();

  const { playlists, addPlaylist, favorites } = usePlaylistStore();
  const { records: historyRecords } = usePlayHistoryStore();

  const [inputValue, setInputValue] = useState(keyword);
  const [showFilters, setShowFilters] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  // 当前打开「更多」菜单的行 id（v13.1：去掉行内下载/播放按钮，下载入口改由更多菜单承载）
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // v16: 搜索结果分页加载
  const PAGE_SIZE = 15;
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // 搜索后自动滚动到结果
  const resultSectionRef = useRef<HTMLDivElement>(null);

  // 点击「更多」菜单以外的区域时，关闭当前打开的菜单
  useEffect(() => {
    if (!activeMenuId) return;
    const handleClickOutside = () => setActiveMenuId(null);
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [activeMenuId]);

  // v16: 搜索结果变化时重置分页
  useEffect(() => {
    setDisplayCount(PAGE_SIZE);
  }, [keyword, results.length]);

  // v16: Intersection Observer 滚动加载更多
  useEffect(() => {
    if (!loadMoreRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && displayCount < results.length) {
          setDisplayCount((prev) => Math.min(prev + PAGE_SIZE, results.length));
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [displayCount, results.length]);

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
      // 滚动到结果区域
      setTimeout(() => {
        resultSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setSearching(false);
    }
  }, [inputValue, selectedSources, setKeyword, setSearching, addToHistory, setResults, setSourceStats]);

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

  const handleDownload = async (result: AggregatedSearchResult) => {
    if (!result.sources || result.sources.length === 0) {
      toast.error('暂无可用音源', '该歌曲在所有平台均无下载链接');
      return;
    }
    try {
      // v13: 与播放一致，下载也走优先级最高平台，失败后按 availableSources 降级
      const task = await downloadEngine.createTask({
        songId: result.sourceSongId,
        sourceId: result.sourceId,
        quality: selectedQuality,
        title: result.title,
        artist: result.artist,
        availableSources: result.sources.map((s) => ({
          sourceId: s.sourceId,
          sourceSongId: s.sourceSongId,
        })),
      });
      downloadEngine.startDownload(task.id);
      toast.success('已加入下载队列', `${result.title}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '下载失败';
      toast.error('下载失败', msg);
    }
  };

  const handlePlayHistory = useCallback(
    async (record: typeof historyRecords[number]) => {
      const track = {
        id: record.songId,
        title: record.title,
        artist: record.artist,
        sourceId: record.source || 'netease',
        sourceSongId: record.songId,
        uri: `stream://${record.source || 'netease'}/${record.songId}`,
        duration: record.duration,
      };
      try {
        await playerEngine.playTrack(track, selectedQuality);
      } catch (err) {
        console.error('Failed to play:', err);
      }
    },
    [selectedQuality]
  );

  const handleCreatePlaylist = useCallback(async () => {
    if (!newName.trim()) return;
    try {
      await addPlaylist(newName.trim());
      setNewName('');
      setShowCreate(false);
    } catch (err) {
      console.error('Failed to create playlist:', err);
    }
  }, [newName, addPlaylist]);

  // 收藏歌单
  const favoritesPlaylist = playlists.find((p) => p.id === 'favorites');
  // 自建歌单（排除 favorites）
  const userPlaylists = playlists.filter((p) => p.id !== 'favorites');

  const isFirstVisit = playlists.length === 0 && historyRecords.length === 0;

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6 hidden lg:block">发现</h1>

      {/* Search Box */}
      <div className="flex gap-2 mb-4">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-tertiary)]" />
          <input
            ref={searchInputRef}
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
          title="筛选"
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

      {/* Empty first-visit state */}
      {isFirstVisit && (
        <div className="yinliu-card text-center py-12 mb-6">
          <div className="w-16 h-16 mx-auto mb-4 rounded-3xl bg-[var(--accent-soft)] flex items-center justify-center">
            <Compass className="w-7 h-7 text-[var(--accent)]" />
          </div>
          <h3 className="text-lg font-medium text-[var(--text-primary)] mb-2">欢迎使用音流</h3>
          <p className="text-sm text-[var(--text-tertiary)] mb-5 max-w-md mx-auto">
            搜索你喜欢的歌曲开始播放，播放历史和收藏的歌单都会自动保存。
          </p>
          <button
            onClick={() => searchInputRef.current?.focus()}
            className="yinliu-btn inline-flex items-center gap-2"
          >
            <Search className="w-4 h-4" />
            开始搜索
          </button>
        </div>
      )}

      {/* Recent plays horizontal scroll */}
      {historyRecords.length > 0 && (
        <section className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <Clock className="w-4 h-4 text-[var(--text-tertiary)]" />
              最近播放
            </h2>
            <span className="text-xs text-[var(--text-tertiary)]">{historyRecords.length} 首</span>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-hide">
            {historyRecords.slice(0, 20).map((record) => (
              <button
                key={record.id}
                onClick={() => handlePlayHistory(record)}
                className="flex-shrink-0 w-32 text-left group focus-ring rounded-2xl"
                title={`${record.title} - ${record.artist || ''}`}
              >
                <div className="aspect-square w-32 rounded-2xl bg-[var(--bg-tertiary)] flex items-center justify-center mb-2 overflow-hidden border border-[var(--border-subtle)] group-hover:border-[var(--accent)] transition-colors relative">
                  {favorites.has(record.songId) && (
                    <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-black/40 flex items-center justify-center">
                      <Heart className="w-3 h-3 text-red-500 fill-current" />
                    </div>
                  )}
                  <Music className="w-8 h-8 text-[var(--text-tertiary)]" />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                    <Play className="w-8 h-8 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </div>
                <div className="text-xs font-medium truncate text-[var(--text-primary)]">{record.title}</div>
                <div className="text-[10px] text-[var(--text-tertiary)] truncate mt-0.5">
                  {record.artist || '未知歌手'}
                </div>
                <div className="text-[10px] text-[var(--text-tertiary)] mt-0.5">{formatRelativeTime(record.playedAt)}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Favorites shortcut */}
      {favoritesPlaylist && (
        <section className="mb-6">
          <h2 className="text-base font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
            <Heart className="w-4 h-4 text-red-500" />
            我喜欢的音乐
          </h2>
          <a
            href={`/playlists?id=favorites`}
            onClick={(e) => {
              e.preventDefault();
              window.location.hash = `#/playlists?id=favorites`;
            }}
            className="yinliu-card-hover flex items-center gap-4 group"
          >
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-red-500/20 to-pink-500/20 flex items-center justify-center flex-shrink-0 border border-red-500/20">
              <Heart className="w-7 h-7 text-red-500 fill-current" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-[var(--text-primary)]">我喜欢的音乐</div>
              <div className="text-xs text-[var(--text-tertiary)] mt-1">
                {favorites.size > 0 ? `${favorites.size} 首收藏` : '点击查看收藏'}
              </div>
            </div>
            <div className="text-xs text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity">
              →
            </div>
          </a>
        </section>
      )}

      {/* User playlists */}
      {userPlaylists.length > 0 && (
        <section className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <ListMusic className="w-4 h-4 text-[var(--text-tertiary)]" />
              自建歌单
            </h2>
            <button
              onClick={() => setShowCreate(true)}
              className="text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] flex items-center gap-1 focus-ring rounded-lg px-2 py-1"
            >
              <Plus className="w-3 h-3" />
              新建
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {userPlaylists.map((pl) => (
              <a
                key={pl.id}
                href={`/playlists?id=${pl.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  window.location.hash = `#/playlists?id=${pl.id}`;
                }}
                className="yinliu-card-hover text-left group"
              >
                <div className="aspect-square w-full rounded-xl bg-[var(--bg-tertiary)] flex items-center justify-center mb-2 overflow-hidden">
                  <ListMusic className="w-8 h-8 text-[var(--text-tertiary)] group-hover:text-[var(--accent)] transition-colors" />
                </div>
                <div className="text-sm font-medium truncate text-[var(--text-primary)]">{pl.name}</div>
                <div className="text-xs text-[var(--text-tertiary)] mt-0.5">{pl.songCount} 首</div>
              </a>
            ))}
          </div>
        </section>
      )}

      {/* Empty playlists hint */}
      {playlists.length <= 1 && !showCreate && !isFirstVisit && (
        <section className="mb-6">
          <button
            onClick={() => setShowCreate(true)}
            className="w-full yinliu-card-hover border-dashed flex items-center justify-center gap-2 py-6 text-sm text-[var(--text-tertiary)] hover:text-[var(--accent)]"
          >
            <Plus className="w-4 h-4" />
            创建第一个歌单
          </button>
        </section>
      )}

      {/* Create playlist inline form */}
      {showCreate && (
        <section className="mb-6">
          <div className="yinliu-card">
            <h3 className="font-semibold mb-3 text-[var(--text-primary)]">新建歌单</h3>
            <div className="flex gap-2">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreatePlaylist()}
                placeholder="歌单名称"
                className="yinliu-input flex-1"
                autoFocus
              />
              <button
                onClick={handleCreatePlaylist}
                disabled={!newName.trim()}
                className="yinliu-btn disabled:opacity-50"
              >
                创建
              </button>
              <button
                onClick={() => {
                  setShowCreate(false);
                  setNewName('');
                }}
                className="yinliu-btn-secondary"
              >
                取消
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Search history */}
      {searchHistory.length > 0 && results.length === 0 && !isSearching && !keyword && (
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

      {/* Search results — v16: 分页渲染 */}
      <div ref={resultSectionRef} className="space-y-2">
        {results.length > 0 && (
          <h2 className="text-base font-semibold text-[var(--text-primary)] mb-3">
            搜索结果 ({results.length})
            {displayCount < results.length && (
              <span className="text-xs text-[var(--text-tertiary)] ml-2">
                已加载 {displayCount} 首
              </span>
            )}
          </h2>
        )}
        {results.slice(0, displayCount).map((result) => (
          <div
            key={result.id}
            role="button"
            tabIndex={0}
            onClick={() => handlePlay(result)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handlePlay(result);
              }
            }}
            className="relative flex items-center gap-3 p-3 rounded-lg bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer active:scale-[0.99]"
          >
            <div className="w-12 h-12 rounded-lg bg-[var(--bg-tertiary)] flex-shrink-0 overflow-hidden">
              <CoverImg src={result.coverUrl || ''} />
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
                    className={`text-[10px] px-1.5 py-0.5 rounded text-white ${SOURCE_COLORS[s.sourceId] || 'bg-gray-500'}`}
                  >
                    {s.sourceName}
                  </span>
                ))}
              </div>
            </div>

            <div className="text-xs text-[var(--text-tertiary)] hidden sm:block">
              {result.bitrate && `${result.bitrate}kbps`}
            </div>

            {/* 「更多」菜单：下载等次级操作入口（v13.1：整行点击播放，次级操作由更多菜单承载） */}
            <div className="relative flex-shrink-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveMenuId(activeMenuId === result.id ? null : result.id);
                }}
                className="p-2 rounded-full text-[var(--text-tertiary)] hover:bg-[var(--border)] hover:text-[var(--text-primary)]"
                title="更多"
                aria-label="更多操作"
              >
                <MoreVertical className="w-4 h-4" />
              </button>
              {activeMenuId === result.id && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute right-0 top-full mt-1 z-20 min-w-[140px] rounded-xl border border-[var(--border)] bg-[var(--bg-elevated,var(--bg-secondary))] shadow-lg overflow-hidden"
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveMenuId(null);
                      handleDownload(result);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                  >
                    <Download className="w-4 h-4" />
                    下载歌曲
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}

        {/* v16: 滚动加载更多触发器 */}
        {results.length > 0 && (
          <div ref={loadMoreRef} className="py-4 text-center">
            {displayCount < results.length ? (
              <div className="flex items-center justify-center gap-2 text-xs text-[var(--text-tertiary)]">
                <Loader2 className="w-4 h-4 animate-spin" />
                滚动加载更多...
              </div>
            ) : (
              <span className="text-xs text-[var(--text-tertiary)]">已显示全部 {results.length} 首</span>
            )}
          </div>
        )}
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
