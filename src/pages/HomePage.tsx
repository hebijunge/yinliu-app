import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search as SearchIcon, Loader2, Flame, ArrowDown, WifiOff } from 'lucide-react';
import { getAggregatedHotSongs } from '../core/charts';
import type { AggregatedSearchResult } from '../core/search';
import {
  loadHomeHotCache,
  isHomeCacheFresh,
  saveHomeHotCache,
} from '../core/homeCache';
import SongRow from '../components/song/SongRow';
import QualitySizeSheet from '../components/song/QualitySizeSheet';
import { playerEngine } from '../core/player';
import { useSearchStore } from '../shared/store/searchStore';
import { toast } from '../shared/components/Toast';
import { useGuardedAction } from '../shared/hooks/useGuardedAction';
import { useNetworkStatus } from '../shared/hooks/useNetworkStatus';
import { allowPlayWhenOffline } from '../shared/utils/playGuard';
import EmptyState from '../components/common/EmptyState';
import { SkeletonSearchResult } from '../components/ui/Skeleton';

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

/**
 * 首页：搜索入口 + 多源聚合热歌榜
 * 聚合排序：权重1=支持的源越多越靠前；权重2=展示优先级（汽水>酷我>咪咕>网易云>QQ>酷狗）
 * 取链播放按播放优先级（酷我>咪咕>网易云>QQ>酷狗>汽水），与展示序并存
 *
 * 缓存策略（v19.1）：聚合结果落本地缓存，24 小时内复用不请求网络；
 * 过期或首次使用才拉网络；下拉刷新强制绕过缓存并刷新时间戳；网络失败回退旧缓存。
 */
export default function HomePage() {
  const navigate = useNavigate();
  const { selectedQuality } = useSearchStore();
  const { isOnline } = useNetworkStatus();
  const [kw, setKw] = useState('');
  const [songs, setSongs] = useState<AggregatedSearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [cacheInfo, setCacheInfo] = useState<string>('');
  const [qualitySheetSong, setQualitySheetSong] = useState<AggregatedSearchResult | null>(null);

  // —— 下拉刷新状态 ——
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollElRef = useRef<HTMLElement | null>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pullDistRef = useRef(0);
  const refreshingRef = useRef(false);
  const touchState = useRef<{ startY: number; pulling: boolean }>({ startY: 0, pulling: false });

  /** 强制绕过缓存拉网络；成功则写缓存并刷新时间戳，失败抛错由调用方兜底 */
  const fetchAndCache = useCallback(async (): Promise<void> => {
    const list = await getAggregatedHotSongs();
    if (list.length === 0) {
      // 六源全部失败：不算成功，不覆盖缓存、不刷新时间戳
      throw new Error('聚合结果为空（各音源均不可用）');
    }
    setSongs(list);
    saveHomeHotCache(list);
    setCacheInfo('');
  }, []);

  /** 首次进入：24h 内新鲜缓存直接用；过期/无缓存才拉网络；网络失败回退旧缓存 */
  useEffect(() => {
    let alive = true;
    (async () => {
      const cache = loadHomeHotCache();
      if (isHomeCacheFresh(cache)) {
        if (!alive) return;
        setSongs(cache!.songs);
        setCacheInfo(formatCacheAge(cache!.savedAt));
        setLoading(false);
        return;
      }
      try {
        await fetchAndCache();
      } catch (err) {
        console.error('热歌榜拉取失败:', err);
        // 兜底：有过期旧缓存就先展示，避免空白页
        if (alive && cache && cache.songs.length > 0) {
          setSongs(cache.songs);
          setCacheInfo(`${formatCacheAge(cache.savedAt)}（已过期，数据可能不是最新）`);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [fetchAndCache]);

  /** 手动下拉刷新：强制绕过缓存，成功后更新缓存时间戳 */
  const triggerRefresh = useCallback(async () => {
    if (refreshingRef.current) return;
    if (!isOnline) {
      toast.error('当前无网络连接', '恢复网络后再刷新');
      return;
    }
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await fetchAndCache();
      toast.success('已更新', '热歌榜已刷新，缓存时间已重置');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '网络异常';
      toast.error('刷新失败', `已保留当前列表：${msg}`);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [fetchAndCache, isOnline]);

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

  // E4：播放入口守卫（进行中禁用 + 300ms 防抖）——狂点不触发并发取链链路
  const doPlay = async (result: AggregatedSearchResult, preferredSourceId?: string) => {
    if (!result.sources || result.sources.length === 0) {
      toast.error('暂无可用音源', '该歌曲在所有平台均无播放链接');
      return;
    }
    // 若指定了优先源，从该源播放
    const targetSource = preferredSourceId
      ? result.sources.find((s) => s.sourceId === preferredSourceId)
      : undefined;
    const sourceId = targetSource?.sourceId ?? result.sourceId;
    const sourceSongId = targetSource?.sourceSongId ?? result.sourceSongId;
    // E1：断网时在线曲目直接拦截并提示（本地/已下载歌曲放行）
    if (!allowPlayWhenOffline({ sourceId, sourceSongId })) return;
    try {
      await playerEngine.playTrack({
        id: result.id,
        title: result.title,
        artist: result.artist,
        album: result.album,
        coverUrl: result.coverUrl,
        duration: result.duration,
        sourceId,
        sourceSongId,
        uri: `stream://${sourceId}/${sourceSongId}`,
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
  const { run: handlePlay } = useGuardedAction(doPlay);

  const pullProgress = Math.min(1, pullDistance / PULL_THRESHOLD);

  return (
    <div className="max-w-4xl mx-auto" ref={contentRef}>
      <h1 className="text-2xl font-bold mb-4">首页</h1>

      {/* 搜索入口：点击输入框只聚焦弹键盘，回车/搜索键才带词进入搜索页 */}
      <form
        className="mb-6"
        onSubmit={(e) => {
          e.preventDefault();
          const term = kw.trim();
          if (term) {
            navigate(`/search?q=${encodeURIComponent(term)}`);
          } else {
            navigate('/search');
          }
        }}
      >
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-tertiary)]" />
          <input
            type="text"
            value={kw}
            onChange={(e) => setKw(e.target.value)}
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
        {!isOnline && songs.length > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 ml-auto">
            离线内容
          </span>
        )}
        {cacheInfo && (
          <span className={`text-xs text-[var(--text-tertiary)] ${!isOnline && songs.length > 0 ? '' : 'ml-auto'}`}>
            缓存 · {cacheInfo}
          </span>
        )}
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
        <SkeletonSearchResult count={8} />
      ) : songs.length === 0 ? (
        !isOnline ? (
          <EmptyState
            icon={WifiOff}
            title="当前无网络连接"
            description="联网后将自动加载热歌榜；已缓存的离线内容会在有缓存时展示"
            onRetry={() => void triggerRefresh()}
          />
        ) : (
          <EmptyState
            title="热歌榜暂无数据"
            description="可能是网络异常或各音源暂不可用，点击重试或下拉刷新"
            onRetry={() => void triggerRefresh()}
          />
        )
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
