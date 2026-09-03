import { useState, useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, Loader2, Music, Filter, Heart, Clock, ListMusic, Plus, Compass, Play } from 'lucide-react';
import { toast } from '../shared/components/Toast';
import { useSearchStore } from '../shared/store/searchStore';
import { searchEngine } from '../core/search';
import { playerEngine } from '../core/player';
import { downloadEngine } from '../core/download';
import { usePlaylistStore } from '../shared/store/playlistStore';
import { usePlayHistoryStore } from '../shared/store/playHistoryStore';
import type { AggregatedSearchResult } from '../core/search';
import { Quality } from '../core/types';
import SongRow from '../components/song/SongRow';
import QualitySizeSheet from '../components/song/QualitySizeSheet';

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
  // v18：音质弹窗当前歌曲
  const [qualitySheetSong, setQualitySheetSong] = useState<AggregatedSearchResult | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // v16: 搜索结果分页加载
  const PAGE_SIZE = 15;
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // 搜索后自动滚动到结果
  const resultSectionRef = useRef<HTMLDivElement>(null);

  // v18: 搜索结果变化时重置分页
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

  const handleSearch = useCallback(async (termOverride?: string) => {
    const term = (termOverride ?? inputValue).trim();
    if (!term) return;
    setKeyword(term);
    setSearching(true);
    addToHistory(term);
    try {
      const { results, sourceStats } = await searchEngine.search(
        { keyword: term, page: 0, pageSize: 30 },
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

  // 支持从首页带词跳转（/search?q=xxx）：进入页面自动搜索一次
  const [searchParams] = useSearchParams();
  const lastAutoQRef = useRef<string>('');
  const qParam = searchParams.get('q') ?? '';
  useEffect(() => {
    const q = qParam.trim();
    if (q && q !== lastAutoQRef.current) {
      lastAutoQRef.current = q;
      setInputValue(q);
      void handleSearch(q);
    }
  }, [qParam, handleSearch]);

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
          onClick={() => handleSearch()}
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
          <SongRow
            key={result.id}
            song={result}
            onPlay={() => handlePlay(result)}
            onMore={() => setQualitySheetSong(result)}
          />
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

      {/* 音质/大小下载弹窗（⋮ 按钮） */}
      {qualitySheetSong && (
        <QualitySizeSheet
          song={qualitySheetSong}
          open
          onClose={() => setQualitySheetSong(null)}
        />
      )}
    </div>
  );
}
