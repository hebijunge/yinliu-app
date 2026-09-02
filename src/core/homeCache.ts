/**
 * 首页列表本地缓存（多源聚合热歌榜）。
 *
 * 缓存口径（v19.1）：
 * - 缓存对象：首页「多源聚合热歌榜」的聚合结果整体（AggregatedSearchResult[]）；
 *   聚合排序已完成，命中缓存直接渲染、不发任何网络请求。
 * - 有效期：24 小时，从「成功聚合完成」的时刻起算；过期或首次使用才重新拉网络。
 * - 写入时机：网络聚合成功后写入（覆盖旧缓存并刷新时间戳）；手动下拉刷新成功后同样刷新时间戳。
 * - 兜底：网络拉取失败时，若存在旧缓存（即使已过期）则回退展示旧数据，避免首页空白。
 */
import type { AggregatedSearchResult } from './search';

const CACHE_KEY = 'yinliu:home:hot-cache:v1';
export const HOME_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

export interface HomeHotCachePayload {
  savedAt: number;
  songs: AggregatedSearchResult[];
}

function isValidPayload(data: unknown): data is HomeHotCachePayload {
  if (!data || typeof data !== 'object') return false;
  const p = data as Partial<HomeHotCachePayload>;
  return (
    typeof p.savedAt === 'number' &&
    p.savedAt > 0 &&
    Array.isArray(p.songs) &&
    p.songs.every(
      (s) =>
        s &&
        typeof s === 'object' &&
        typeof (s as AggregatedSearchResult).id === 'string' &&
        typeof (s as AggregatedSearchResult).title === 'string' &&
        Array.isArray((s as AggregatedSearchResult).sources)
    )
  );
}

/** 读取缓存；无缓存或数据损坏返回 null（是否过期用 isHomeCacheFresh 判断） */
export function loadHomeHotCache(): HomeHotCachePayload | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidPayload(parsed) ? parsed : null;
  } catch (err) {
    console.warn('首页缓存读取失败，视为无缓存:', err);
    return null;
  }
}

/** 缓存是否在 24 小时有效期内 */
export function isHomeCacheFresh(cache: HomeHotCachePayload | null): boolean {
  if (!cache) return false;
  return Date.now() - cache.savedAt < HOME_CACHE_TTL_MS;
}

/** 写入缓存（成功聚合或下拉刷新成功后调用；失败静默，不影响主流程） */
export function saveHomeHotCache(songs: AggregatedSearchResult[]): void {
  try {
    const payload: HomeHotCachePayload = { savedAt: Date.now(), songs };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('首页缓存写入失败:', err);
  }
}

/** 清空缓存（预留调试用） */
export function clearHomeHotCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}
