import { useState, useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, Loader2, Music, Filter, Heart, Clock, ListMusic, Plus, Compass, Play, User, Disc, Video, X, SearchX } from 'lucide-react';
import { toast } from '../shared/components/Toast';
import { useSearchStore } from '../shared/store/searchStore';
import { searchEngine } from '../core/search';
import { playerEngine } from '../core/player';
import { downloadEngine } from '../core/download';
import { usePlaylistStore } from '../shared/store/playlistStore';
import { usePlayHistoryStore } from '../shared/store/playHistoryStore';
import type { AggregatedSearchResult } from '../core/search';
import { Quality, type SearchType } from '../core/types';
import { useMvPlayerStore } from '../shared/store/mvPlayerStore';
import { sourceRegistry } from '@providers/music/registry';
import MvPlayerPage from './MvPlayerPage';
import SongRow from '../components/song/SongRow';
import QualitySizeSheet from '../components/song/QualitySizeSheet';
import EmptyState from '../components/common/EmptyState';
import { useNetworkStatus } from '../shared/hooks/useNetworkStatus';
import OfflineEmptyState from '../shared/components/OfflineEmptyState';
import { SkeletonSearchResult } from '../components/ui/Skeleton';
import { toUserMessage } from '../shared/utils/errorCopy';
import { useInfiniteList } from '../shared/hooks/useInfiniteList';
import SmartCover from '../components/ui/SmartCover';

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
    setKeyword, setResults, setSearching, setSourceStats, addToHistory, removeHistory, clearHistory, setQuality, searchType, setSearchType,
  } = useSearchStore();

  const { playlists, addPlaylist, isFavorite, favorites, refreshPlaylistCovers } = usePlaylistStore();
  const { records: historyRecords } = usePlayHistoryStore();

  const [inputValue, setInputValue] = useState(keyword);
  // E1: 网络状态（断网展示统一离线空态）
  const online = useNetworkStatus();
  const [showFilters, setShowFilters] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  // v18：音质弹窗当前歌曲
  const [qualitySheetSong, setQualitySheetSong] = useState<AggregatedSearchResult | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 歌单封面懒补齐（取第一首歌封面），让自建/收藏歌单卡有封面可显示
  useEffect(() => {
    void refreshPlaylistCovers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v16/P12: 搜索结果分页加载——收编为 useInfiniteList（页面级 window 滚动触底分帧挂载）
  const PAGE_SIZE = 15;
  const { visibleCount: displayCount } = useInfiniteList(results.length, null, { step: PAGE_SIZE });

  // 搜索后自动滚动到结果
  const resultSectionRef = useRef<HTMLDivElement>(null);

  // 竞态保护：请求序号，仅最新一次搜索允许写入结果
  const searchSeqRef = useRef(0);
  // 最近一次成功发起搜索的词（重试按钮用）
  const lastTermRef = useRef('');
  // 搜索失败状态（错误提示 + 重试）
  const [searchError, setSearchError] = useState<string | null>(null);

  const handleSearch = useCallback(async (termOverride?: string) => {
    const term = (termOverride ?? inputValue).trim();
    if (!term) return;
    // 新搜索发起时递增序号，旧请求的回包（含分源回调）一律丢弃
    const seq = ++searchSeqRef.current;
    const isLatest = () => searchSeqRef.current === seq;
    lastTermRef.current = term;
    setSearchError(null);
    setKeyword(term);
    setSearching(true);
    setResults([]);
    setSourceStats({});
    addToHistory(term);
    try {
      // 从 store 直接取最新值，避免 Tab 切换后 setTimeout 触发的搜索用到旧闭包里的类型/音源
      const latest = useSearchStore.getState();
      const { results, sourceStats } = await searchEngine.search(
        { keyword: term, page: 0, pageSize: 30, type: latest.searchType },
        {
          sources: latest.selectedSources,
          timeout: 10000,
          // 分源到达分源展示：谁先回来先合并展示谁，不等最慢的源
          onPartial: (snapshot) => {
            if (!isLatest()) return;
            setResults(snapshot.results);
            setSourceStats(snapshot.sourceStats);
          },
        }
      );
      if (!isLatest()) return;
      setResults(results);
      setSourceStats(sourceStats);
      // 全部音源都失败时按错误处理，给错误态而非空态
      const allFailed =
        Object.keys(sourceStats).length > 0 &&
        Object.values(sourceStats).every((st) => st.error) &&
        results.length === 0;
      if (allFailed) {
        setSearchError('所有音源均搜索失败，请检查网络后重试');
        setResults([]);
        setSourceStats({});
      } else {
        // 滚动到结果区域
        setTimeout(() => {
          resultSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
      }
    } catch (err) {
      console.error('Search failed:', err);
      if (isLatest()) {
        setSearchError(toUserMessage(err, '搜索失败，请稍后重试'));
        setResults([]);
        setSourceStats({});
      }
    } finally {
      if (isLatest()) {
        setSearching(false);
      }
    }
  }, [inputValue, selectedSources, searchType, setKeyword, setSearching, addToHistory, setResults, setSourceStats]);

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

  // 点击歌手 → 用歌手名搜索歌曲
  const handleArtistClick = useCallback((result: AggregatedSearchResult) => {
    if (result.title) {
      setInputValue(result.title);
      setSearchType('song');
      setTimeout(() => handleSearch(), 0);
    }
  }, [setSearchType, handleSearch]);

  // 点击专辑 → 用专辑名搜索歌曲
  const handleAlbumClick = useCallback((result: AggregatedSearchResult) => {
    if (result.title) {
      setInputValue(result.title);
      setSearchType('song');
      setTimeout(() => handleSearch(), 0);
    }
  }, [setSearchType, handleSearch]);

  // v19.2: 点击MV → 应用内播放器打开，支持多源聚合与切源
  const handleMvClick = useCallback((result: AggregatedSearchResult) => {
    useMvPlayerStore.getState().openMv(result);
  }, []);

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
      const msg = toUserMessage(err, '播放失败');
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
      const msg = toUserMessage(err, '下载失败');
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

      {/* 搜索类型 Tabs */}
      <div className="flex gap-1 mb-4 p-1 rounded-xl bg-[var(--bg-tertiary)]">
        {([
          { key: 'song' as SearchType, label: '歌曲', icon: Music },
          { key: 'artist' as SearchType, label: '歌手', icon: User },
          { key: 'album' as SearchType, label: '专辑', icon: Disc },
          { key: 'mv' as SearchType, label: 'MV', icon: Video },
        ]).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => {
              setSearchType(key);
              if (inputValue.trim()) {
                setTimeout(() => handleSearch(), 0);
              }
            }}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm rounded-lg transition-colors ${
              searchType === key
                ? 'bg-[var(--accent)] text-white font-medium'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
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

      {/* Source Stats：只展示源名称与结果数，不透出原始 id / 延迟毫秒 */}
      {Object.keys(sourceStats).length > 0 && (
        <div className="flex gap-3 mb-4 flex-wrap">
          {Object.entries(sourceStats).map(([id, stat]) => (
            <div key={id} className="text-xs px-2 py-1 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
              {sourceRegistry.get(id)?.name || id}: {stat.total} 条{stat.error && <span className="text-red-500">（失败）</span>}
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
                  {isFavorite({ title: record.title, artist: record.artist }) && (
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
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-red-500/20 to-pink-500/20 flex items-center justify-center flex-shrink-0 border border-red-500/20 overflow-hidden">
              {favoritesPlaylist?.coverUrl ? (
                <SmartCover src={favoritesPlaylist.coverUrl} alt="我喜欢的音乐" className="w-full h-full" />
              ) : (
                <Heart className="w-7 h-7 text-red-500 fill-current" />
              )}
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
                  {pl.coverUrl ? (
                    <SmartCover src={pl.coverUrl} alt={pl.name} className="w-full h-full" />
                  ) : (
                    <ListMusic className="w-8 h-8 text-[var(--text-tertiary)] group-hover:text-[var(--accent)] transition-colors" />
                  )}
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

      {/* Search history：点击直接搜索；支持逐条删除与一键清空（已持久化到 localStorage） */}
      {searchHistory.length > 0 && results.length === 0 && !isSearching && !keyword && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm text-[var(--text-secondary)]">搜索历史</div>
            <button
              onClick={() => clearHistory()}
              className="text-xs text-[var(--text-tertiary)] hover:text-red-500 transition-colors"
            >
              清空
            </button>
          </div>
          <div className="flex gap-2 flex-wrap">
            {searchHistory.map((h) => (
              <div
                key={h}
                className="flex items-center gap-1 pl-3 pr-1.5 py-1 rounded-full text-sm bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)]"
              >
                <button
                  onClick={() => { setInputValue(h); handleSearch(h); }}
                  className="hover:text-[var(--text-primary)]"
                >
                  {h}
                </button>
                <button
                  onClick={() => removeHistory(h)}
                  className="p-0.5 rounded-full text-[var(--text-tertiary)] hover:text-red-500 transition-colors"
                  aria-label={`删除历史「${h}」`}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search results — v16: 分页渲染；P12: min-h 占位防止骨架→结果切换时布局跳动 */}
      <div ref={resultSectionRef} className="space-y-2 min-h-[420px]">
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
        {/* 歌曲结果：列表 */}
        {searchType === 'song' && (
          <div className="space-y-2">
            {results.slice(0, displayCount).map((result) => (
              <SongRow
                key={result.id}
                song={result}
                onPlay={() => handlePlay(result)}
                onMore={() => setQualitySheetSong(result)}
              />
            ))}
          </div>
        )}

        {/* 歌手结果：网格卡片 */}
        {searchType === 'artist' && (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-4">
            {results.slice(0, displayCount).map((result) => (
              <button
                key={result.id}
                onClick={() => handleArtistClick(result)}
                className="text-left group focus-ring rounded-2xl"
              >
                <div className="aspect-square w-full rounded-2xl bg-[var(--bg-tertiary)] flex items-center justify-center mb-2 overflow-hidden border border-[var(--border-subtle)] group-hover:border-[var(--accent)] transition-colors">
                  {result.coverUrl ? (
                    <SmartCover src={result.coverUrl} alt={result.title} className="w-full h-full" />
                  ) : (
                    <User className="w-10 h-10 text-[var(--text-tertiary)]" />
                  )}
                </div>
                <div className="text-sm font-medium truncate text-[var(--text-primary)]">{result.title}</div>
                {result.subtitle && (
                  <div className="text-xs text-[var(--text-tertiary)] truncate">{result.subtitle}</div>
                )}
              </button>
            ))}
          </div>
        )}

        {/* 专辑结果：网格卡片 */}
        {searchType === 'album' && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {results.slice(0, displayCount).map((result) => (
              <button
                key={result.id}
                onClick={() => handleAlbumClick(result)}
                className="text-left group focus-ring rounded-2xl"
              >
                <div className="aspect-square w-full rounded-2xl bg-[var(--bg-tertiary)] flex items-center justify-center mb-2 overflow-hidden border border-[var(--border-subtle)] group-hover:border-[var(--accent)] transition-colors">
                  {result.coverUrl ? (
                    <SmartCover src={result.coverUrl} alt={result.title} className="w-full h-full" />
                  ) : (
                    <Disc className="w-10 h-10 text-[var(--text-tertiary)]" />
                  )}
                </div>
                <div className="text-sm font-medium truncate text-[var(--text-primary)]">{result.title}</div>
                <div className="text-xs text-[var(--text-tertiary)] truncate">{result.artist || result.subtitle || ''}</div>
              </button>
            ))}
          </div>
        )}

        {/* MV结果：网格卡片 */}
        {searchType === 'mv' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {results.slice(0, displayCount).map((result) => (
              <button
                key={result.id}
                onClick={() => handleMvClick(result)}
                className="text-left group focus-ring rounded-2xl"
              >
                <div className="aspect-video w-full rounded-2xl bg-[var(--bg-tertiary)] flex items-center justify-center mb-2 overflow-hidden border border-[var(--border-subtle)] group-hover:border-[var(--accent)] transition-colors relative">
                  {result.coverUrl ? (
                    <SmartCover src={result.coverUrl} alt={result.title} className="w-full h-full" />
                  ) : (
                    <Video className="w-10 h-10 text-[var(--text-tertiary)]" />
                  )}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                    <Play className="w-10 h-10 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                  {result.duration && result.duration > 0 && (
                    <div className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px]">
                      {Math.floor(result.duration / 60)}:{String(result.duration % 60).padStart(2, '0')}
                    </div>
                  )}
                  {result.mvSources && result.mvSources.length > 1 && (
                    <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px]">
                      {result.mvSources.length} 源
                    </div>
                  )}
                </div>
                <div className="text-sm font-medium truncate text-[var(--text-primary)]">{result.title}</div>
                <div className="text-xs text-[var(--text-tertiary)] truncate">{result.artist || result.subtitle || ''}</div>
              </button>
            ))}
          </div>
        )}

        {/* v16/P12: 滚动加载更多状态指示 */}
        {results.length > 0 && (
          <div className="py-4 text-center">
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

      {/* 骨架屏：搜索进行中且尚无结果时展示 */}
      {isSearching && results.length === 0 && (
        <SkeletonSearchResult count={6} />
      )}

      {/* 搜索失败：错误提示 + 重试按钮 */}
      {searchError && !isSearching && (
        <EmptyState
          icon={SearchX}
          title="搜索失败"
          description={searchError}
          onRetry={() => handleSearch(lastTermRef.current || undefined)}
        />
      )}

      {/* E1: 断网空态 —— 有结果仍展示结果（本地已到数据），无结果给统一离线出口 */}
      {!isSearching && !searchError && results.length === 0 && keyword && !online && (
        <OfflineEmptyState
          description="当前无网络连接，无法搜索。恢复网络后点击重新搜索"
          onRetry={() => handleSearch(keyword)}
        />
      )}

      {/* Empty state：图标 + 文案 + 重试按钮 */}
      {!isSearching && !searchError && results.length === 0 && keyword && online && (
        <EmptyState
          icon={SearchX}
          title="未找到相关结果"
          description="请尝试其他关键词，或检查搜索类型是否正确"
          onRetry={() => handleSearch(keyword)}
        />
      )}

      {/* 音质/大小下载弹窗（⋮ 按钮） */}
      {qualitySheetSong && (
        <QualitySizeSheet
          song={qualitySheetSong}
          open
          onClose={() => setQualitySheetSong(null)}
        />
      )}

      {/* v19.2: MV 播放器 */}
      <MvPlayerPage />
    </div>
  );
}
