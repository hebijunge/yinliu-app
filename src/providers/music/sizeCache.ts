/**
 * v20.2 共享音质大小缓存
 * 用于预检结果在播放/下载阶段的 Content-Length 比对校验。
 */
export interface SizeCacheEntry {
  size: number;
  url?: string;
  timestamp: number;
}

const cache = new Map<string, SizeCacheEntry>();
const TTL = 5 * 60 * 1000; // 5 分钟有效期

function makeKey(sourceId: string, songId: string, quality: string): string {
  return `${sourceId}:${songId}:${quality}`;
}

export const sizeCache = {
  set(sourceId: string, songId: string, quality: string, entry: Omit<SizeCacheEntry, 'timestamp'>): void {
    cache.set(makeKey(sourceId, songId, quality), { ...entry, timestamp: Date.now() });
  },

  get(sourceId: string, songId: string, quality: string): SizeCacheEntry | undefined {
    const key = makeKey(sourceId, songId, quality);
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > TTL) {
      cache.delete(key);
      return undefined;
    }
    return entry;
  },

  clear(): void {
    cache.clear();
  },

  /** 判断实际大小是否与缓存大小一致（允许 ±5% 或 ±100KB 容差） */
  validate(sourceId: string, songId: string, quality: string, actualSize: number): {
    ok: boolean;
    expected?: number;
    diff?: number;
  } {
    const entry = this.get(sourceId, songId, quality);
    if (!entry || entry.size <= 0) return { ok: true };
    const tolerance = Math.max(entry.size * 0.05, 100 * 1024); // 5% 或 100KB
    const diff = Math.abs(actualSize - entry.size);
    return { ok: diff <= tolerance, expected: entry.size, diff };
  },
};
