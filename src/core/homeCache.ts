/**
 * 首页列表本地缓存（多源聚合热歌榜）——基于统一缓存层 cacheStore。
 *
 * 缓存口径（v20）：
 * - 缓存对象：首页「多源聚合热歌榜」的聚合结果整体（AggregatedSearchResult[]）；
 *   聚合排序已完成，命中缓存直接渲染、不发任何网络请求。
 * - 有效期：24 小时，从「成功聚合完成」的时刻起算。
 * - 过期策略：stale-while-revalidate——命中过期缓存先立即渲染，同时后台静默拉新，
 *   成功后无感刷新列表与缓存时间戳；失败保持旧数据不变。
 * - 启动预热：prewarmHomeCache 在 App 启动时后台检查缓存是否过期，过期提前拉取。
 * - 版本号：HOME_CACHE_SCHEMA_VERSION 携带在缓存条目上，数据结构升级时 +1，
 *   旧结构缓存由缓存层直接作废重拉。
 * - 兜底：网络拉取失败时保留旧缓存不动，避免首页空白；断网时直接用缓存展示。
 */
import type { AggregatedSearchResult } from './search';
import { getAggregatedHotSongs } from './charts';
import { cacheGet, cacheSet, cacheDelete } from './cacheStore';

/** 缓存命名空间与键（统一缓存层内） */
const NS = 'home:hot';
const KEY = 'aggregated';
/** v19.1 旧版单键缓存，读取后迁移到统一缓存层 */
const LEGACY_KEY = 'yinliu:home:hot-cache:v1';

/**
 * 首页缓存数据结构版本号。
 * AggregatedSearchResult 结构变更时 +1：旧缓存读取即作废、直接重拉，避免读到旧结构。
 */
export const HOME_CACHE_SCHEMA_VERSION = 1;

export const HOME_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

export interface HomeHotCachePayload {
  savedAt: number;
  songs: AggregatedSearchResult[];
}

function sanitizeSongs(songs: unknown): AggregatedSearchResult[] | null {
  if (!Array.isArray(songs)) return null;
  const ok = songs.every(
    (s) =>
      s &&
      typeof s === 'object' &&
      typeof (s as AggregatedSearchResult).id === 'string' &&
      typeof (s as AggregatedSearchResult).title === 'string' &&
      Array.isArray((s as AggregatedSearchResult).sources)
  );
  return ok ? (songs as AggregatedSearchResult[]) : null;
}

/** 读取缓存；无缓存 / 数据损坏 / 版本不匹配返回 null（是否过期用 isHomeCacheFresh 判断） */
export function loadHomeHotCache(): HomeHotCachePayload | null {
  const hit = cacheGet<AggregatedSearchResult[]>(NS, KEY, HOME_CACHE_SCHEMA_VERSION);
  if (hit) {
    const songs = sanitizeSongs(hit.data);
    if (songs && songs.length > 0) return { savedAt: hit.savedAt, songs };
    // 结构非法：作废重拉
    cacheDelete(NS, KEY);
    return null;
  }
  return migrateLegacyCache();
}

/** v19.1 旧单键缓存迁移：结构合法则写入统一缓存层（保留原时间戳）并删除旧键 */
function migrateLegacyCache(): HomeHotCachePayload | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const p = parsed as Partial<HomeHotCachePayload> | null;
    const savedAt = p && typeof p.savedAt === 'number' && p.savedAt > 0 ? p.savedAt : 0;
    const songs = savedAt > 0 ? sanitizeSongs(p!.songs) : null;
    if (!songs || songs.length === 0) {
      try {
        localStorage.removeItem(LEGACY_KEY);
      } catch {
        /* ignore */
      }
      return null;
    }
    cacheSet(NS, KEY, HOME_CACHE_SCHEMA_VERSION, songs, { savedAt });
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      /* ignore */
    }
    return { savedAt, songs };
  } catch {
    return null;
  }
}

/** 缓存是否在 24 小时有效期内 */
export function isHomeCacheFresh(cache: HomeHotCachePayload | null): boolean {
  if (!cache) return false;
  return Date.now() - cache.savedAt < HOME_CACHE_TTL_MS;
}

/** 写入缓存（成功聚合、下拉刷新或后台静默更新成功后调用；失败静默，不影响主流程） */
export function saveHomeHotCache(songs: AggregatedSearchResult[]): void {
  try {
    cacheSet(NS, KEY, HOME_CACHE_SCHEMA_VERSION, songs);
  } catch (err) {
    console.warn('首页缓存写入失败:', err);
  }
}

/** 清空缓存（预留调试用） */
export function clearHomeHotCache(): void {
  try {
    cacheDelete(NS, KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
}

/** 并发去重：预热与页面进入同时触发时，同一时刻只发一次网络聚合 */
let inflightRevalidate: Promise<HomeHotCachePayload> | null = null;

/**
 * 后台静默拉新（stale-while-revalidate / 预热共用）：
 * 强制绕过缓存拉取聚合结果；结果为空视为失败（不覆盖旧缓存）；
 * 成功写入缓存并返回新数据，失败抛错由调用方决定保留旧数据。
 */
export function revalidateHomeCache(): Promise<HomeHotCachePayload> {
  if (inflightRevalidate) return inflightRevalidate;
  inflightRevalidate = (async () => {
    const list = await getAggregatedHotSongs();
    if (list.length === 0) {
      // 六源全部失败：不算成功，不覆盖缓存、不刷新时间戳
      throw new Error('聚合结果为空（各音源均不可用）');
    }
    saveHomeHotCache(list);
    return { savedAt: Date.now(), songs: list };
  })().finally(() => {
    inflightRevalidate = null;
  });
  return inflightRevalidate;
}

/**
 * 启动预热：App 启动即后台检查首页缓存是否过期，过期（或无缓存）则提前拉取，
 * 用户进首页时大概率直接可用。fire-and-forget，任何失败静默。
 */
export function prewarmHomeCache(): void {
  try {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return; // 离线不预热
    const cache = loadHomeHotCache();
    if (cache && isHomeCacheFresh(cache)) return;
    void revalidateHomeCache().catch((err) => {
      console.warn('首页缓存预热失败（忽略）:', err);
    });
  } catch {
    /* ignore */
  }
}
