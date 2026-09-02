import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search as SearchIcon, Loader2, Flame, ArrowDown } from 'lucide-react';
import type { AggregatedSearchResult } from '../core/search';
import {
  loadHomeHotCache,
  isHomeCacheFresh,
  revalidateHomeCache,
  HOME_CACHE_TTL_MS,
  type HomeHotCachePayload,
} from '../core/homeCache';
import SongRow from '../components/song/SongRow';
import QualitySizeSheet from '../components/song/QualitySizeSheet';
import { playerEngine } from '../core/player';
import { useSearchStore } from '../shared/store/searchStore';
import { toast } from '../shared/components/Toast';

/** 下拉刷新触发阈值（px） */
const PULL_THRESHOLD = 72;
/** 下拉位移阻尼：拉出距离按比例衰减，模拟橡皮筋手感 */
const PULL_DAMPING = 0.45;

function formatCacheAge(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60 * 60 * 1000) {
    const m = Math.max(1, Math.round(diff / 60000));
    return `${m} 分钟前更新`;
  }
  const h = Math.floor(diff / (60 * 60 * 1000));
  return `${h} 小时前更新`;
}

/** 离线标注用的短格式时间差：「3 分钟前」「2 小时前」「1 天前」 */
function formatAgeShort(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60 * 60 * 1000) {
    const m = Math.max(1, Math.round(diff / 60000));
    return `${m} 分钟前`;
  }
  const h = Math.floor(diff / (60 * 60 * 1000));
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/**
 * 首页：搜索入口 + 多源聚合热歌榜
 * 聚合排序：权重1=支持的源越多越靠前；权重2=展示优先级（汽水>酷我>咪咕>网易云>QQ>酷狗）
 * 取链播放按播放优先级（酷我>咪咕>网易云>QQ>酷狗>汽水），与展示序并存
 *
 * 缓存策略（v20，基于统一缓存层 cacheStore）：
 * - 有缓存立即渲染（无论新鲜与否，绝不先转圈）；
 * - 24h 内新鲜缓存完全复用不请求网络；
 * - 过期缓存走 stale-while-revalidate：后台静默拉新，成功无感刷新列表与时间戳，失败保留旧数据；
 * - 启动预热由 main.tsx 调 prewarmHomeCache 完成，进首页前数据大概率已就绪；
 * - 断网时直接用缓存展示，顶部标注「当前离线，展示 X 前的数据」；
 * - 下拉刷新强制绕过缓存并刷新时间戳；网络失败回退保留当前列表。
 */
export default function HomePage() {
  const navigate = useNavigate();
  const { selectedQuality } = useSearchStore();
  const [kw, setKw] = useState('');
  const [songs, setSongs] = useState<AggregatedSearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [cacheInfo, setCacheInfo] = useState<string>('');
  const [offline, setOffline] = useState(false);
  const [qualitySheetSong, setQualitySheetSong] = useState<AggregatedSearchResult | null>(null);
  // 当前展示数据的时间戳（用于断网恢复后判断是否需要补拉）
  const shownSavedAtRef = useRef<number | null>(null);

  // —— 下拉刷新状态 ——
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollElRef = useRef<HTMLElement | null>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pullDistRef = useRef(0);
  const refreshingRef = useRef(false);
  const touchState = useRef<{ startY: number; pulling: boolean }>({ startY: 0, pulling: false });

  /** 无感刷新列表（后台静默更新 / 断网恢复补拉成功后调用） */
  const applyFreshList = useCallback((fresh: HomeHotCachePayload) => {
    shownSavedAtRef.current = fresh.savedAt;
    setSongs(fresh.songs);
    setCacheInfo('');
    setOffline(false);
  }, []);

  /**
   * 首次进入 / 回到首页：
   * - 有缓存（无论新鲜与否）→ 立即渲染，绝不先转圈；
   * - 缓存新鲜 → 完全复用，不发请求；
   * - 缓存过期且在线 → stale-while-revalidate：后台静默拉新，成功无感刷新，失败保留旧数据；
   * - 无缓存且在线 → 拉网络；无缓存且离线 → 空态提示。
   */
  useEffect(() => {
    let alive = true;
    const cache = loadHomeHotCache();
    const online = typeof navigator !== 'undefined' ? navigator.onLine : true;

    if (cache && cache.songs.length > 0) {
      shownSavedAtRef.current = cache.savedAt;
      setSongs(cache.songs);
      setCacheInfo(formatCacheAge(cache.savedAt));
      setOffline(!online);
      setLoading(false);
      if (isHomeCacheFresh(cache) || !online) return; // 新鲜缓存或离线：不发起网络
      revalidateHomeCache()
        .then((fresh) => {
          if (alive) applyFreshList(fresh);
        })
        .catch(() => {
          /* 失败保持旧数据与旧标注 */
        });
      return;
    }

    if (!online) {
      setOffline(true);
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const fresh = await revalidateHomeCache();
        if (!alive) return;
        applyFreshList(fresh);
      } catch (err) {
        console.error('热歌榜拉取失败:', err);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [applyFreshList]);

  /** 断网 / 恢复联网：更新离线标注；恢复联网时若展示的是过期缓存则补拉一次 */
  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline = () => {
      setOffline(false);
      const shownAt = shownSavedAtRef.current;
      if (shownAt !== null && Date.now() - shownAt >= HOME_CACHE_TTL_MS) {
        revalidateHomeCache()
          .then(applyFreshList)
          .catch(() => {
            /* 失败保持旧数据 */
          });
      }
    };
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, [applyFreshList]);

  /** 手动下拉刷新：强制绕过缓存，成功后更新缓存时间戳；离线时直接提示不空转 */
  const triggerRefresh = useCallback(async () => {
    if (refreshingRef.current) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      toast.error('当前离线', '无网络连接，已保留当前列表');
      return;
    }
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const fresh = await revalidateHomeCache();
      applyFreshList(fresh);
      toast.success('已更新', '热歌榜已刷新，缓存时间已重置');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '网络异常';
      toast.error('刷新失败', `已保留当前列表：${msg}`);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [applyFreshList]);

  // 定位 Layout 的滚动容器（<main class="overflow-y-auto">），下拉刷新只在滚动到顶部时生效
  useEffect(() => {
    const el = contentRef.current;
    scrollElRef.current = (el?.closest('main') as HTMLElement | null) ?? null;
  }, []);

  // 触摸事件需 preventDefault 阻止 webview 原生滚动回弹，须以非 passive 方式挂载
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const onTouchStart = (e: TouchEvent) => {
      const main = scrollElRef.current;
      const atTop = !main || main.scrollTop <= 0;
      touchState.current = { startY: e.touches[0].clientY, pulling: atTop && !refreshingRef.current };
    };
    const onTouchMove = (e: TouchEvent) => {
      const st = touchState.current;
      if (!st.pulling || refreshingRef.current) return;
      const dy = e.touches[0].clientY - st.startY;
      const main = scrollElRef.current;
      // 手指上滑或已滚离顶部 → 取消下拉
      if (dy <= 0 || (main && main.scrollTop > 0)) {
        st.pulling = false;
        pullDistRef.current = 0;
        setPullDistance(0);
        return;
      }
      if (e.cancelable) e.preventDefault();
      const d = Math.round(dy * PULL_DAMPING);
      pullDistRef.current = d;
      setPullDistance(d);
    };
    const onTouchEnd = () => {
      const st = touchState.current;
      if (!st.pulling || refreshingRef.current) return;
      touchState.current = { startY: 0, pulling: false };
      if (pullDistRef.current >= PULL_THRESHOLD) void triggerRefresh();
      pullDistRef.current = 0;
      setPullDistance(0);
    };
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [triggerRefresh]);

  const handlePlay = async (result: AggregatedSearchResult) => {
    if (!result.sources || result.sources.length === 0) {
      toast.error('暂无可用音源', '该歌曲在所有平台均无播放链接');
      return;
    }
    try {
      await playerEngine.playTrack(
        {
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
        },
        selectedQuality
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : '播放失败';
      toast.error('播放失败', msg);
    }
  };

  const pullProgress = Math.min(1, pullDistance / PULL_THRESHOLD);

  return (
    <div className="max-w-4xl mx-auto" ref={contentRef}>
      <h1 className="text-2xl font-bold mb-4">首页</h1>

      {/* 搜索入口 */}
      <form
        className="mb-6"
        onSubmit={(e) => {
          e.preventDefault();
          navigate('/search');
        }}
      >
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-tertiary)]" />
          <input
            type="text"
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            onFocus={() => navigate('/search')}
            placeholder="搜索歌曲、歌手"
            className="w-full pl-10 pr-4 py-2.5 rounded-full bg-[var(--bg-secondary)] border border-[var(--border)] text-sm outline-none focus:border-[var(--accent)]"
          />
        </div>
      </form>

      {/* 多源聚合热歌榜 */}
      <div className="flex items-center gap-2 mb-3">
        <Flame className="w-5 h-5 text-red-500" />
        <h2 className="text-lg font-bold">热歌榜</h2>
        <span className="text-xs text-[var(--text-tertiary)]">多源聚合</span>
        {offline && cacheInfo ? (
          <span className="text-xs text-amber-500 ml-auto">
            当前离线，展示{formatAgeShort(shownSavedAtRef.current ?? Date.now())}的数据
          </span>
        ) : cacheInfo ? (
          <span className="text-xs text-[var(--text-tertiary)] ml-auto">
            缓存 · {cacheInfo}
          </span>
        ) : null}
      </div>

      {/* 下拉刷新指示器：触摸下拉时出现，越过阈值松手触发刷新 */}
      {(pullDistance > 0 || refreshing) && (
        <div
          className="flex items-center justify-center gap-2 text-xs text-[var(--text-tertiary)] overflow-hidden transition-[height]"
          style={{ height: refreshing ? 40 : pullDistance }}
        >
          {refreshing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>正在刷新…</span>
            </>
          ) : (
            <>
              <ArrowDown
                className="w-4 h-4 transition-transform"
                style={{ transform: pullProgress >= 1 ? 'rotate(180deg)' : 'none' }}
              />
              <span>{pullProgress >= 1 ? '松开刷新' : '下拉刷新'}</span>
            </>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-[var(--text-tertiary)]">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : songs.length === 0 ? (
        <div className="text-center py-12 text-[var(--text-tertiary)]">
          {offline ? '当前离线，且暂无缓存数据，联网后自动加载' : '热歌榜暂无数据，下拉可重试'}
        </div>
      ) : (
        songs.slice(0, 100).map((result) => (
          <SongRow
            key={result.id}
            song={result}
            onPlay={() => handlePlay(result)}
            onMore={() => setQualitySheetSong(result)}
          />
        ))
      )}

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
