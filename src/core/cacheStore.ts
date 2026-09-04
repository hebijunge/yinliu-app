/**
 * 统一本地缓存层（v20 引入）。
 *
 * 设计目标（多页共用：首页热歌榜 / 曲库榜单 / 歌单 / 专区……）：
 * - 命名空间多键存储：每条缓存 = `yinliu:cc:<ns>:<key>`，互不干扰；
 * - 版本号：每条目携带数据结构版本号 schemaVersion，业务侧结构升级后把版本号 +1，
 *   旧结构缓存读取时直接作废（删除后返回 null，触发重拉），避免读到旧结构数据；
 * - 容量上限 + LRU：全部条目共用总量上限（默认约 20MB），按「最久未使用」淘汰，
 *   多页缓存后不会无限膨胀；写入时若超出上限自动淘汰最久未用条目；
 * - 平台配额兜底：localStorage 实际配额不足（QuotaExceeded）时同样走 LRU 淘汰后重试；
 * - 全部操作静默容错：缓存层任何失败都不影响主流程。
 *
 * 索引：`yinliu:cc:index:v1` 记录每条的 { bytes, lastUsedAt }，用于容量统计与 LRU。
 */

const PREFIX = 'yinliu:cc:';
const INDEX_KEY = 'yinliu:cc:index:v1';

/** 默认总量上限：约 20MB */
export const DEFAULT_CACHE_TOTAL_LIMIT_BYTES = 20 * 1024 * 1024;

interface CacheIndexEntry {
  bytes: number;
  lastUsedAt: number;
}

type CacheIndex = Record<string, CacheIndexEntry>;

/** 内部条目信封：v = 数据结构版本号，savedAt = 写入时间，data = 业务数据 */
interface CacheEnvelope<T> {
  v: number;
  savedAt: number;
  data: T;
}

let totalLimitBytes = DEFAULT_CACHE_TOTAL_LIMIT_BYTES;
const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** 调整总量上限（测试用；业务代码保持默认 20MB） */
export function setCacheTotalLimit(bytes: number): void {
  if (Number.isFinite(bytes) && bytes > 0) totalLimitBytes = bytes;
}

export function getCacheTotalLimitBytes(): number {
  return totalLimitBytes;
}

function byteLen(s: string): number {
  if (encoder) return encoder.encode(s).length;
  return s.length; // 兜底：非 UTF-16 代理对场景误差可忽略
}

function entryStorageKey(ns: string, key: string): string {
  return `${PREFIX}${ns}:${key}`;
}

function readIndex(): CacheIndex {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: CacheIndex = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v && typeof v === 'object') {
        const e = v as Partial<CacheIndexEntry>;
        if (typeof e.bytes === 'number' && typeof e.lastUsedAt === 'number') {
          out[k] = { bytes: e.bytes, lastUsedAt: e.lastUsedAt };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeIndex(index: CacheIndex): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    /* 索引写入失败不影响主流程；下次写入会重建 */
  }
}

function removeEntryRaw(storageKey: string, index: CacheIndex): void {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    /* ignore */
  }
  delete index[storageKey];
}

/** D9 孤儿自愈：数据已被外部清除/淘汰失败但索引仍记账的幻影条目，读取时同步摘除记账 */
function healOrphanIndex(index: CacheIndex): void {
  if (typeof localStorage === 'undefined') return;
  for (const k of Object.keys(index)) {
    try {
      if (localStorage.getItem(k) === null) delete index[k];
    } catch {
      /* 存储不可用时跳过自愈 */
    }
  }
}

/** 按 LRU（lastUsedAt 最旧优先）淘汰，直到总字节数 ≤ 上限；excludeKey 的条目不淘汰 */
function evictToLimit(index: CacheIndex, excludeKey?: string): void {
  healOrphanIndex(index);
  const entries = Object.entries(index)
    .filter(([k]) => k !== excludeKey)
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  let total = Object.values(index).reduce((sum, e) => sum + e.bytes, 0);
  for (const [k, e] of entries) {
    if (total <= totalLimitBytes) break;
    removeEntryRaw(k, index);
    total -= e.bytes;
  }
  writeIndex(index);
}

/** 找出最久未使用的条目（excludeKey 除外）；没有可淘汰项返回 null */
function oldestEntryKey(index: CacheIndex, excludeKey?: string): string | null {
  let best: string | null = null;
  let bestAt = Infinity;
  for (const [k, e] of Object.entries(index)) {
    if (k === excludeKey) continue;
    if (e.lastUsedAt < bestAt) {
      bestAt = e.lastUsedAt;
      best = k;
    }
  }
  return best;
}

/**
 * 读取缓存。
 * - 无缓存 / 数据损坏 / **版本号不匹配**（结构升级）→ 删除残留并返回 null；
 * - 命中会刷新 lastUsedAt（LRU 依据）。
 */
export function cacheGet<T>(
  ns: string,
  key: string,
  schemaVersion: number
): { data: T; savedAt: number } | null {
  const storageKey = entryStorageKey(ns, key);
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return null;
    let env: CacheEnvelope<T> | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && 'v' in parsed && 'savedAt' in parsed) {
        env = parsed as CacheEnvelope<T>;
      }
    } catch {
      env = null;
    }
    // 损坏或版本不匹配：一律作废删除（结构升级后旧缓存直接重拉）
    if (!env || typeof env.v !== 'number' || env.v !== schemaVersion || typeof env.savedAt !== 'number') {
      const index = readIndex();
      removeEntryRaw(storageKey, index);
      writeIndex(index);
      return null;
    }
    // 命中：touch LRU
    try {
      const index = readIndex();
      index[storageKey] = { bytes: byteLen(raw), lastUsedAt: Date.now() };
      writeIndex(index);
    } catch {
      /* ignore */
    }
    return { data: env.data, savedAt: env.savedAt };
  } catch (err) {
    console.warn('cacheGet 失败（视为无缓存）:', ns, key, err);
    return null;
  }
}

/**
 * 写入缓存（savedAt 默认取当前时间，可用 opts.savedAt 覆盖，供旧数据迁移保时间戳）。
 * - 先直接写；若平台配额不足则逐个淘汰最久未用条目并重试（直到成功或无可淘汰项）；
 * - 写入成功后按总量上限（默认 20MB）做一次 LRU 淘汰（刚写入的条目不淘汰）。
 * @returns 是否写入成功
 */
export function cacheSet<T>(
  ns: string,
  key: string,
  schemaVersion: number,
  data: T,
  opts?: { savedAt?: number }
): boolean {
  const storageKey = entryStorageKey(ns, key);
  const savedAt = opts?.savedAt ?? Date.now();
  const envelope: CacheEnvelope<T> = { v: schemaVersion, savedAt, data };
  let body: string;
  try {
    body = JSON.stringify(envelope);
  } catch (err) {
    console.warn('cacheSet 序列化失败:', ns, key, err);
    return false;
  }
  const bytes = byteLen(body);

  // 单条超过总量上限：直接放弃（避免反复淘汰也写不下）
  if (bytes > totalLimitBytes) {
    console.warn('cacheSet 单条超过缓存总量上限，放弃写入:', ns, key);
    return false;
  }

  const index = readIndex();
  let ok = false;
  // 配额不足时逐个淘汰最久未用条目重试（直到写入成功或没有任何可淘汰项）
  for (let attempt = 0; attempt < 64; attempt++) {
    try {
      localStorage.setItem(storageKey, body);
      ok = true;
      break;
    } catch {
      const victim = oldestEntryKey(index, storageKey);
      if (!victim) break; // 没得淘汰了
      removeEntryRaw(victim, index);
      writeIndex(index);
    }
  }
  if (!ok) {
    console.warn('cacheSet 写入失败（配额不足且无可淘汰项）:', ns, key);
    return false;
  }

  index[storageKey] = { bytes, lastUsedAt: Date.now() };
  evictToLimit(index, storageKey);
  return true;
}

/** 删除单条缓存 */
export function cacheDelete(ns: string, key: string): void {
  const storageKey = entryStorageKey(ns, key);
  try {
    const index = readIndex();
    removeEntryRaw(storageKey, index);
    writeIndex(index);
  } catch {
    /* ignore */
  }
}

/** 清空某个命名空间下的全部缓存 */
export function clearCacheNamespace(ns: string): void {
  try {
    const prefix = `${PREFIX}${ns}:`;
    const index = readIndex();
    const keys = Object.keys(index).filter((k) => k.startsWith(prefix));
    for (const k of keys) removeEntryRaw(k, index);
    writeIndex(index);
    // 索引缺失时的兜底清扫
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}

/** 缓存使用情况（调试用） */
export function cacheStats(): { entries: number; totalBytes: number; limitBytes: number } {
  const index = readIndex();
  const totalBytes = Object.values(index).reduce((sum, e) => sum + e.bytes, 0);
  return { entries: Object.keys(index).length, totalBytes, limitBytes: totalLimitBytes };
}
