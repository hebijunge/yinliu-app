import { Filesystem, Directory } from '@capacitor/filesystem';
import { platformFetch } from '@shared/utils/platformFetch';
import { debugLogger } from '@shared/utils/debugLogger';

const CACHE_DIR = 'yinliu/cache';
const MAX_CACHE_SIZE_MB = 500;
const MAX_CACHE_SIZE_BYTES = MAX_CACHE_SIZE_MB * 1024 * 1024;

interface CacheEntry {
  filePath: string;
  size: number;
  lastAccessed: number;
  sourceId: string;
  songId: string;
  quality: string;
}

/**
 * 在线播放流式缓存管理器
 * - 使用 platformFetch（Capacitor 原生 HTTP）绕过 WebView 防盗链限制
 * - 缓存文件按 sourceId+songId+quality 命名
 * - 500MB LRU 淘汰
 */
export class StreamCacheManager {
  private entries = new Map<string, CacheEntry>();
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.ensureCacheDir();
    await this.scanCacheDir();
    this.initialized = true;
  }

  private async ensureCacheDir(): Promise<void> {
    try {
      await Filesystem.mkdir({ path: CACHE_DIR, directory: Directory.Data, recursive: true });
    } catch {
      // 目录可能已存在
    }
  }

  private async scanCacheDir(): Promise<void> {
    try {
      const result = await Filesystem.readdir({ path: CACHE_DIR, directory: Directory.Data });
      for (const file of result.files) {
        // 文件名格式: {sourceId}_{songId}_{quality}.{ext}
        const match = file.name.match(/^(.+)_(.+)_(.+)\.(.+)$/);
        if (!match) continue;
        const [, sourceId, songId, quality] = match;
        const filePath = `${CACHE_DIR}/${file.name}`;
        try {
          const stat = await Filesystem.stat({ path: filePath, directory: Directory.Data });
          const key = this.getCacheKey(sourceId, songId, quality);
          this.entries.set(key, {
            filePath,
            size: stat.size || 0,
            lastAccessed: stat.mtime || Date.now(),
            sourceId,
            songId,
            quality,
          });
        } catch {
          // stat 失败则跳过
        }
      }
    } catch {
      // 缓存目录为空或不存在
    }
  }

  private getCacheKey(sourceId: string, songId: string, quality: string): string {
    return `${sourceId}_${songId}_${quality}`;
  }

  private getCacheFileName(sourceId: string, songId: string, quality: string, format: string): string {
    return `${sourceId}_${songId}_${quality}.${format || 'mp3'}`;
  }

  /** 检查指定曲目是否在缓存中 */
  async hasCache(sourceId: string, songId: string, quality: string): Promise<boolean> {
    await this.init();
    const key = this.getCacheKey(sourceId, songId, quality);
    const entry = this.entries.get(key);
    if (!entry) return false;
    try {
      await Filesystem.stat({ path: entry.filePath, directory: Directory.Data });
      return true;
    } catch {
      this.entries.delete(key);
      return false;
    }
  }

  /** 从缓存读取为可播放的 Blob URL */
  async getCacheAsUrl(sourceId: string, songId: string, quality: string): Promise<string | null> {
    await this.init();
    const key = this.getCacheKey(sourceId, songId, quality);
    const entry = this.entries.get(key);
    if (!entry) return null;
    try {
      await Filesystem.stat({ path: entry.filePath, directory: Directory.Data });
      entry.lastAccessed = Date.now();
      return await this.readFileAsUrl(entry.filePath);
    } catch {
      this.entries.delete(key);
      return null;
    }
  }

  /**
   * 下载音频并写入缓存，返回可播放的 Blob URL
   * 使用 platformFetch（Capacitor 原生 HTTP）绕过 WebView 限制
   */
  async fetchAndCache(
    url: string,
    sourceId: string,
    songId: string,
    quality: string,
    format: string,
    headers?: Record<string, string>
  ): Promise<string> {
    await this.init();
    const key = this.getCacheKey(sourceId, songId, quality);

    // 双重检查缓存（防止并发重复下载）
    const existing = this.entries.get(key);
    if (existing) {
      try {
        await Filesystem.stat({ path: existing.filePath, directory: Directory.Data });
        existing.lastAccessed = Date.now();
        return await this.readFileAsUrl(existing.filePath);
      } catch {
        this.entries.delete(key);
      }
    }

    debugLogger.info('player', `streamCache 开始下载缓存: ${key}`, {
      url: url.slice(0, 120),
    });

    // 使用 platformFetch 走原生 HTTP 下载
    const response = await platformFetch(url, {
      method: 'GET',
      headers: headers || {},
      responseType: 'arraybuffer',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    // 写入缓存文件
    const fileName = this.getCacheFileName(sourceId, songId, quality, format);
    const filePath = `${CACHE_DIR}/${fileName}`;

    const base64 = this.arrayBufferToBase64(uint8Array);
    await Filesystem.writeFile({
      path: filePath,
      data: base64,
      directory: Directory.Data,
      recursive: true,
    });

    let size = uint8Array.length;
    try {
      const stat = await Filesystem.stat({ path: filePath, directory: Directory.Data });
      size = stat.size || size;
    } catch {
      // 使用下载大小作为 fallback
    }

    this.entries.set(key, {
      filePath,
      size,
      lastAccessed: Date.now(),
      sourceId,
      songId,
      quality,
    });

    // LRU 淘汰
    await this.evictIfNeeded();

    debugLogger.info('player', `streamCache 缓存完成: ${key}`, {
      size,
      filePath,
    });

    return await this.readFileAsUrl(filePath);
  }

  private arrayBufferToBase64(buffer: Uint8Array): string {
    const chunkSize = 32768;
    let binary = '';
    for (let i = 0; i < buffer.length; i += chunkSize) {
      const chunk = buffer.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  private async readFileAsUrl(filePath: string): Promise<string> {
    const result = await Filesystem.readFile({
      path: filePath,
      directory: Directory.Data,
    });
    const base64 = typeof result.data === 'string' ? result.data : '';
    const ext = filePath.split('.').pop()?.toLowerCase() || 'mp3';
    const mimeMap: Record<string, string> = {
      mp3: 'audio/mpeg',
      flac: 'audio/flac',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      ogg: 'audio/ogg',
      aac: 'audio/aac',
    };
    const mime = mimeMap[ext] || 'audio/mpeg';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mime });
    return URL.createObjectURL(blob);
  }

  private async evictIfNeeded(): Promise<void> {
    let totalSize = 0;
    for (const entry of this.entries.values()) {
      totalSize += entry.size;
    }

    if (totalSize <= MAX_CACHE_SIZE_BYTES) return;

    // 按最后访问时间升序排列（最旧优先淘汰）
    const sorted = Array.from(this.entries.values()).sort(
      (a, b) => a.lastAccessed - b.lastAccessed
    );

    for (const entry of sorted) {
      if (totalSize <= MAX_CACHE_SIZE_BYTES) break;
      try {
        await Filesystem.deleteFile({
          path: entry.filePath,
          directory: Directory.Data,
        });
      } catch {
        // 文件可能不存在
      }
      this.entries.delete(this.getCacheKey(entry.sourceId, entry.songId, entry.quality));
      totalSize -= entry.size;
      debugLogger.info('player', `streamCache LRU 淘汰: ${entry.filePath}`, {
        size: entry.size,
        lastAccessed: new Date(entry.lastAccessed).toISOString(),
      });
    }
  }

  /** 清空缓存 */
  async clearCache(): Promise<void> {
    await this.init();
    for (const entry of this.entries.values()) {
      try {
        await Filesystem.deleteFile({
          path: entry.filePath,
          directory: Directory.Data,
        });
      } catch {
        // ignore
      }
    }
    this.entries.clear();
    debugLogger.info('player', 'streamCache 缓存已清空');
  }

  /** 获取缓存统计信息 */
  getCacheInfo(): { totalSize: number; fileCount: number; maxSize: number } {
    let totalSize = 0;
    for (const entry of this.entries.values()) {
      totalSize += entry.size;
    }
    return {
      totalSize,
      fileCount: this.entries.size,
      maxSize: MAX_CACHE_SIZE_BYTES,
    };
  }
}

export const streamCache = new StreamCacheManager();
