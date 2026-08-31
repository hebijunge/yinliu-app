/**
 * 流式播放缓存引擎
 * v14.4: 管理在线播放的边下边缓存，支持 LRU 清理和分块区间追踪
 *
 * 缓存策略：
 * - 目录: yinliu/stream_cache/
 * - 命名: {sourceId}_{songId}_{quality}.{format}
 * - 上限: 500MB (LRU)
 * - 元数据: 记录已下载区间，支持 seek 断点判断
 */

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { debugLogger } from '@shared/utils/debugLogger';

export interface CacheEntry {
  key: string;
  filePath: string;
  format: string;
  totalSize: number;
  /** 已下载的区间列表（有序、不重叠） */
  downloadedRanges: Array<{ start: number; end: number }>;
  createdAt: number;
  lastAccessedAt: number;
}

const CACHE_DIR = 'yinliu/stream_cache';
const MAX_CACHE_SIZE = 500 * 1024 * 1024; // 500MB
const META_FILE = 'cache_meta.json';

class StreamCacheEngine {
  private entries = new Map<string, CacheEntry>();
  private initialized = false;

  /**
   * 初始化缓存引擎：加载元数据、清理过期文件
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // 确保缓存目录存在
      try {
        await Filesystem.mkdir({
          path: CACHE_DIR,
          directory: Directory.Data,
          recursive: true,
        });
      } catch {
        // 目录可能已存在
      }

      // 加载元数据
      await this.loadMeta();

      // 扫描目录，同步文件系统状态
      await this.syncWithFilesystem();

      this.initialized = true;
      debugLogger.info('streaming', 'StreamCacheEngine initialized', {
        entryCount: this.entries.size,
      });
    } catch (err) {
      debugLogger.error('streaming', 'StreamCacheEngine init failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      // 初始化失败不影响播放，回退到纯内存模式
      this.initialized = true;
    }
  }

  /**
   * 获取或创建缓存条目
   */
  async getOrCreateEntry(key: string, format: string): Promise<CacheEntry> {
    await this.init();

    const existing = this.entries.get(key);
    if (existing) {
      existing.lastAccessedAt = Date.now();
      return existing;
    }

    const ext = format || 'mp3';
    const filePath = `${CACHE_DIR}/${key}.${ext}`;
    const entry: CacheEntry = {
      key,
      filePath,
      format: ext,
      totalSize: 0,
      downloadedRanges: [],
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    };

    this.entries.set(key, entry);
    return entry;
  }

  /**
   * 获取缓存条目（不存在返回 null）
   */
  getEntry(key: string): CacheEntry | null {
    const entry = this.entries.get(key) || null;
    if (entry) {
      entry.lastAccessedAt = Date.now();
    }
    return entry;
  }

  /**
   * 追加数据到缓存文件
   * @param key 缓存键
   * @param data 二进制数据
   * @param offset 文件偏移位置
   */
  async appendData(key: string, data: Uint8Array, offset: number): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`Cache entry not found: ${key}`);

    try {
      // 检查文件是否存在
      let fileExists = false;
      try {
        await Filesystem.stat({
          path: entry.filePath,
          directory: Directory.Data,
        });
        fileExists = true;
      } catch {
        fileExists = false;
      }

      if (!fileExists && offset === 0) {
        // 新建文件：base64 写入
        await this.writeFile(entry.filePath, data);
      } else if (fileExists) {
        // 追加模式：读取现有内容 → 合并 → 写回
        // Capacitor Filesystem 不支持真正的追加写入，需要 read+merge+write
        const existing = await this.readFileBytes(entry.filePath);
        const newSize = Math.max(existing.length, offset + data.length);
        const merged = new Uint8Array(newSize);
        merged.set(existing, 0);
        merged.set(data, offset);
        await this.writeFile(entry.filePath, merged);
      } else {
        throw new Error(`Cannot append to non-existent file at offset ${offset}`);
      }

      // 更新已下载区间
      this.mergeDownloadedRange(entry, offset, offset + data.length - 1);

      // 更新总大小
      const endPos = offset + data.length;
      if (endPos > entry.totalSize) {
        entry.totalSize = endPos;
      }

      entry.lastAccessedAt = Date.now();
    } catch (err) {
      debugLogger.error('streaming', `Cache append failed: ${key}`, {
        offset,
        length: data.length,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * 将数据写入新文件（覆盖）
   */
  async writeData(key: string, data: Uint8Array): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`Cache entry not found: ${key}`);

    await this.writeFile(entry.filePath, data);
    entry.totalSize = data.length;
    entry.downloadedRanges = [{ start: 0, end: data.length - 1 }];
    entry.lastAccessedAt = Date.now();
  }

  /**
   * 读取缓存文件为 Blob URL（用于播放）
   */
  async readAsBlobUrl(key: string): Promise<string> {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`Cache entry not found: ${key}`);

    const bytes = await this.readFileBytes(entry.filePath);
    const mimeMap: Record<string, string> = {
      mp3: 'audio/mpeg',
      flac: 'audio/flac',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      ogg: 'audio/ogg',
      aac: 'audio/aac',
    };
    const mime = mimeMap[entry.format] || 'audio/mpeg';
    const blob = new Blob([bytes as unknown as BlobPart], { type: mime });

    entry.lastAccessedAt = Date.now();
    return URL.createObjectURL(blob);
  }

  /**
   * 检查指定字节区间是否已完全下载
   */
  isRangeDownloaded(key: string, start: number, end: number): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;

    for (const range of entry.downloadedRanges) {
      if (range.start <= start && range.end >= end) {
        return true;
      }
    }
    return false;
  }

  /**
   * 获取已下载的总字节数
   */
  getDownloadedBytes(key: string): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    return entry.downloadedRanges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
  }

  /**
   * 获取最接近已下载区间的起始位置（用于 seek 后确定从哪下载）
   * 返回小于等于 target 的最大已下载字节位置，如果未下载则返回 -1
   */
  getNearestDownloadedPosition(key: string, target: number): number {
    const entry = this.entries.get(key);
    if (!entry) return -1;

    let nearest = -1;
    for (const range of entry.downloadedRanges) {
      if (range.start <= target && range.end >= target) {
        // target 在已下载区间内
        return target;
      }
      if (range.end < target && range.end > nearest) {
        nearest = range.end;
      }
    }
    return nearest;
  }

  /**
   * 删除缓存条目
   */
  async deleteEntry(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;

    try {
      await Filesystem.deleteFile({
        path: entry.filePath,
        directory: Directory.Data,
      });
    } catch {
      // 文件可能不存在
    }

    this.entries.delete(key);
    await this.saveMeta();
  }

  /**
   * LRU 清理：删除最久未访问的条目，直到总大小低于上限
   */
  async cleanupLRU(): Promise<void> {
    const allEntries = Array.from(this.entries.values()).sort(
      (a, b) => a.lastAccessedAt - b.lastAccessedAt
    );

    let totalSize = allEntries.reduce((sum, e) => sum + e.totalSize, 0);

    while (totalSize > MAX_CACHE_SIZE && allEntries.length > 0) {
      const oldest = allEntries.shift()!;
      try {
        await Filesystem.deleteFile({
          path: oldest.filePath,
          directory: Directory.Data,
        });
      } catch {
        // 忽略删除错误
      }
      this.entries.delete(oldest.key);
      totalSize -= oldest.totalSize;

      debugLogger.info('streaming', `LRU evicted: ${oldest.key}`, {
        size: oldest.totalSize,
      });
    }

    await this.saveMeta();
  }

  /**
   * 清空所有缓存
   */
  async clear(): Promise<void> {
    for (const key of this.entries.keys()) {
      await this.deleteEntry(key);
    }
    this.entries.clear();
    await this.saveMeta();
  }

  // === 内部方法 ===

  /**
   * 合并已下载区间（保持有序、不重叠）
   */
  private mergeDownloadedRange(entry: CacheEntry, start: number, end: number): void {
    const ranges = [...entry.downloadedRanges, { start, end }];
    // 按 start 排序
    ranges.sort((a, b) => a.start - b.start);
    // 合并重叠区间
    const merged: Array<{ start: number; end: number }> = [];
    for (const range of ranges) {
      if (merged.length === 0) {
        merged.push(range);
      } else {
        const last = merged[merged.length - 1];
        if (range.start <= last.end + 1) {
          // 重叠或相邻，合并
          last.end = Math.max(last.end, range.end);
        } else {
          merged.push(range);
        }
      }
    }
    entry.downloadedRanges = merged;
  }

  /**
   * 写文件到 Capacitor Filesystem
   */
  private async writeFile(filePath: string, data: Uint8Array): Promise<void> {
    const base64 = arrayBufferToBase64(data);
    await Filesystem.writeFile({
      path: filePath,
      data: base64,
      directory: Directory.Data,
      recursive: true,
    });
  }

  /**
   * 读取文件为 Uint8Array
   */
  private async readFileBytes(filePath: string): Promise<Uint8Array> {
    try {
      const result = await Filesystem.readFile({
        path: filePath,
        directory: Directory.Data,
      });
      const base64 = typeof result.data === 'string' ? result.data : '';
      return base64ToArrayBuffer(base64);
    } catch {
      return new Uint8Array(0);
    }
  }

  /**
   * 加载元数据
   */
  private async loadMeta(): Promise<void> {
    try {
      const result = await Filesystem.readFile({
        path: `${CACHE_DIR}/${META_FILE}`,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
      const text = typeof result.data === 'string' ? result.data : '';
      const parsed = JSON.parse(text) as Record<string, CacheEntry>;
      for (const [key, entry] of Object.entries(parsed)) {
        this.entries.set(key, entry);
      }
    } catch {
      // 元数据文件可能不存在
    }
  }

  /**
   * 保存元数据
   */
  private async saveMeta(): Promise<void> {
    try {
      const obj = Object.fromEntries(this.entries);
      await Filesystem.writeFile({
        path: `${CACHE_DIR}/${META_FILE}`,
        data: JSON.stringify(obj),
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
    } catch (err) {
      debugLogger.warn('streaming', 'Failed to save cache meta', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 同步文件系统状态（删除条目表中不存在但文件系统中也不存在的 orphaned entries）
   */
  private async syncWithFilesystem(): Promise<void> {
    try {
      const result = await Filesystem.readdir({
        path: CACHE_DIR,
        directory: Directory.Data,
      });
      const existingFiles = new Set(result.files.map((f) => f.name));
      // 清理不存在的条目
      for (const [key, entry] of this.entries) {
        const fileName = entry.filePath.split('/').pop();
        if (fileName && !existingFiles.has(fileName)) {
          this.entries.delete(key);
        }
      }
    } catch {
      // 目录可能不存在
    }
  }
}

/**
 * Uint8Array → base64
 */
function arrayBufferToBase64(buffer: Uint8Array): string {
  const chunkSize = 32768;
  let binary = '';
  for (let i = 0; i < buffer.length; i += chunkSize) {
    const chunk = buffer.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * base64 → Uint8Array
 */
function base64ToArrayBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export const streamCacheEngine = new StreamCacheEngine();
