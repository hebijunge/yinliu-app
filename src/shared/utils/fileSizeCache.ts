/**
 * 音质文件大小全局缓存
 * v20.1-fix: 下载弹窗异步加载 + 二次打开直接命中
 * Key: `${sourceId}_${songId}_${quality}`
 * TTL: 10 分钟（文件大小相对稳定，短 TTL 保证时效性）
 */

export interface FileSizeCacheEntry {
  size: number;
  /**  human-readable, e.g. '12.3MB'  */
  label: string;
  /**  epoch ms  */
  cachedAt: number;
  /**  是否来自真实接口（false = 占位/降级）  */
  fromApi: boolean;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 分钟

class FileSizeCache {
  private map = new Map<string, FileSizeCacheEntry>();

  get(key: string): FileSizeCacheEntry | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > DEFAULT_TTL_MS) {
      this.map.delete(key);
      return null;
    }
    return entry;
  }

  set(key: string, size: number, fromApi = true): void {
    this.map.set(key, {
      size,
      label: formatBytes(size),
      cachedAt: Date.now(),
      fromApi,
    });
  }

  setError(key: string): void {
    this.map.set(key, {
      size: 0,
      label: '获取失败',
      cachedAt: Date.now(),
      fromApi: false,
    });
  }

  clear(): void {
    this.map.clear();
  }

  keys(): string[] {
    return Array.from(this.map.keys());
  }
}

export const fileSizeCache = new FileSizeCache();

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + sizes[i];
}
