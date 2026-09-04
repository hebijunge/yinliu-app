/**
 * 流式播放缓存引擎
 * v14.4: 管理在线播放的边下边缓存，支持 LRU 清理和分块区间追踪
 * v22-lru-fix: LRU 清理落地——cleanupLRU 接入调用点（写入防抖触发 / init 启动清理 / 定期清理），
 *   新增文件数量上限与活跃条目保护（正在播放/下载中的缓存不被误删），并清理磁盘孤儿文件
 *
 * 缓存策略：
 * - 目录: yinliu/stream_cache/
 * - 命名: {sourceId}_{songId}_{quality}.{format}
 * - 上限: 500MB 且不超过 300 个文件 (LRU)
 * - 元数据: 记录已下载区间，支持 seek 断点判断
 */

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';
import { debugLogger } from '@shared/utils/debugLogger';

export interface CacheEntry {
  key: string;
  filePath: string;
  format: string;
  totalSize: number;
  /** 预期的完整文件大小（来自 HTTP Content-Length，用于校验缓存是否真正完整） */
  expectedTotalSize?: number;
  /** 已下载的区间列表（有序、不重叠） */
  downloadedRanges: Array<{ start: number; end: number }>;
  createdAt: number;
  lastAccessedAt: number;
}

const CACHE_DIR = 'yinliu/stream_cache';
const MAX_CACHE_SIZE = 500 * 1024 * 1024; // 500MB
/** v22-lru-fix: 缓存文件数量上限（防止海量小文件累积） */
const MAX_CACHE_FILES = 300;
/** v22-lru-fix: 写入后防抖清理延迟（写入触发清理合并为一次） */
const CLEANUP_DEBOUNCE_MS = 5_000;
/** v22-lru-fix: 定期清理间隔 */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const META_FILE = 'cache_meta.json';
/**
 * v22-append-fix: Web 端内存缓冲刷盘阈值
 * Web 实现（IndexedDB）没有原生追加，攒够该阈值才做一次全量读-并-写，
 * 把 I/O 频率从"每 chunk 一次"降到"每 FLUSH_THRESHOLD_BYTES 一次"
 */
const FLUSH_THRESHOLD_BYTES = 2 * 1024 * 1024; // 2MB
/** v22-mem-fix: 缓存格式 → MIME 类型映射（Blob 兜底路径使用） */
const MIME_BY_FORMAT: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
};

export class StreamCacheEngine {
  private entries = new Map<string, CacheEntry>();
  private initialized = false;
  /** v22-lru-fix: 活跃条目（正在播放/下载中），LRU 清理时跳过，防止误删使用中的文件 */
  private activeKeys = new Set<string>();
  /** v22-lru-fix: 防抖清理定时器（写入触发） */
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  /** v22-lru-fix: 定期清理定时器 */
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  /** v22-append-fix: 原生平台（Android/iOS）可用 Filesystem.appendFile 做真正的追加写入 */
  private readonly isNative = Capacitor.isNativePlatform();
  /** v22-append-fix: Web 端按 key 缓冲的待刷盘数据块（顺序追加） */
  private pendingChunks = new Map<string, Uint8Array[]>();
  /** 缓冲区起始文件偏移 */
  private pendingStart = new Map<string, number>();
  /** 缓冲区累计字节数 */
  private pendingBytes = new Map<string, number>();
  /** v22-append-fix: 各缓存文件当前在磁盘上的字节数（会话内缓存，免去每次 append 的 stat） */
  private diskSizes = new Map<string, number>();

  /**
   * v22-lru-fix: 上限参数可注入（默认 500MB / 300 个文件 / 5s 防抖 / 10min 定期），
   * 便于单元测试用小上限验证 LRU 行为
   */
  constructor(
    private readonly limits: {
      maxSize?: number;
      maxFiles?: number;
      cleanupDebounceMs?: number;
      cleanupIntervalMs?: number;
    } = {}
  ) {}

  private get maxSize(): number {
    return this.limits.maxSize ?? MAX_CACHE_SIZE;
  }
  private get maxFiles(): number {
    return Math.max(1, this.limits.maxFiles ?? MAX_CACHE_FILES);
  }
  private get cleanupDebounceMs(): number {
    return this.limits.cleanupDebounceMs ?? CLEANUP_DEBOUNCE_MS;
  }
  private get cleanupIntervalMs(): number {
    return this.limits.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS;
  }

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

      // v22-lru-fix: 启动时执行一次 LRU 清理（App 启动触发点），并启动定期清理
      await this.cleanupLRU();
      this.startPeriodicCleanup();

      debugLogger.info('streaming', 'StreamCacheEngine initialized', {
        entryCount: this.entries.size,
        maxSize: this.maxSize,
        maxFiles: this.maxFiles,
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
   * v22-lru-fix: 标记缓存条目为活跃（正在播放或下载中）
   * 活跃条目在 LRU 清理中被跳过，防止删除使用中的文件
   */
  markActive(key: string): void {
    if (key) this.activeKeys.add(key);
  }

  /**
   * v22-lru-fix: 取消活跃标记（播放/下载结束）
   */
  markInactive(key: string): void {
    if (key) this.activeKeys.delete(key);
  }

  /**
   * v22-lru-fix: 查询条目是否活跃
   */
  isEntryActive(key: string): boolean {
    return this.activeKeys.has(key);
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
   * 设置预期的完整文件大小（来自 HTTP Content-Length）
   * 用于校验缓存是否真正完整，防止中断下载后被误判为已缓存
   */
  async setExpectedTotalSize(key: string, size: number): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (size > 0 && entry.expectedTotalSize !== size) {
      entry.expectedTotalSize = size;
      await this.saveMeta();
    }
  }

  /**
   * 追加数据到缓存文件
   * @param key 缓存键
   * @param data 二进制数据
   * @param offset 文件偏移位置
   *
   * v22-append-fix 性能说明（走查严重项：大文件流式播放 O(n²) 卡顿）：
   *  - 旧实现每个 chunk 都要 stat + 全量读回 + 合并 + 全量写回（含全量 base64 编解码），
   *    复杂度 O(n²)，50MB 文件播放卡顿严重
   *  - 新实现：
   *    1) 原生平台顺序追加 → Filesystem.appendFile，只写本 chunk，O(chunk)，无全量读写
   *    2) Web 平台顺序追加 → 内存缓冲批量刷盘（每 FLUSH_THRESHOLD_BYTES 一次读-并-写），
   *       I/O 频率降为 1/N；内存峰值可控（单 key 缓冲上限 2MB）
   *    3) 非顺序写入（seek/预取回填，低频）→ 保留读-合并-写路径
   *  - 磁盘尺寸缓存（diskSizes）免去每次 append 的 stat 调用
   */
  async appendData(key: string, data: Uint8Array, offset: number): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`Cache entry not found: ${key}`);

    try {
      const diskSize = await this.getDiskSize(key);

      if (diskSize === 0 && offset === 0) {
        // 新建文件：整体写入
        await this.writeFile(entry.filePath, data);
        this.diskSizes.set(key, data.length);
      } else if (this.isNative && diskSize === offset) {
        // v22-append-fix: 原生顺序追加——真正的 append，只写本 chunk，O(chunk)
        await Filesystem.appendFile({
          path: entry.filePath,
          data: arrayBufferToBase64(data),
          directory: Directory.Data,
        });
        this.diskSizes.set(key, diskSize + data.length);
      } else if (this.isNative) {
        // 原生非顺序写入（seek/预取回填，低频）：读-合并-写
        await this.mergeWrite(key, entry.filePath, data, offset);
      } else {
        // v22-append-fix: Web 顺序追加 → 内存缓冲批量刷盘
        await this.bufferAppend(key, data, offset);
      }

      // 更新已下载区间
      this.mergeDownloadedRange(entry, offset, offset + data.length - 1);

      // 更新总大小
      const endPos = offset + data.length;
      if (endPos > entry.totalSize) {
        entry.totalSize = endPos;
      }

      entry.lastAccessedAt = Date.now();

      // v22-lru-fix: 缓存写入后触发（防抖）清理，防止无限累积
      this.scheduleCleanup();
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
   * v22-append-fix: 将指定 key 的内存缓冲刷入磁盘
   * 在读取文件播放（readAsBlobUrl/readAsFileUrl）和持久化元数据（saveMeta）前调用
   */
  async flush(key: string): Promise<void> {
    await this.flushPending(key);
  }

  /**
   * v22-append-fix: 刷出所有未落盘的内存缓冲
   */
  async flushAll(): Promise<void> {
    for (const key of Array.from(this.pendingChunks.keys())) {
      await this.flushPending(key);
    }
  }

  /**
   * 将数据写入新文件（覆盖）
   */
  async writeData(key: string, data: Uint8Array): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`Cache entry not found: ${key}`);

    await this.writeFile(entry.filePath, data);
    this.discardPending(key);
    this.diskSizes.set(key, data.length);
    entry.totalSize = data.length;
    entry.downloadedRanges = [{ start: 0, end: data.length - 1 }];
    entry.lastAccessedAt = Date.now();

    // v22-lru-fix: 缓存写入后触发（防抖）清理，防止无限累积
    this.scheduleCleanup();
  }

  /**
   * 获取缓存文件的可播放 URL（用于 <audio> 播放）
   *
   * v22-mem-fix（走查严重项：大文件缓存播放内存不随文件大小线性增长）：
   *  - 原生平台（Android/iOS）：不再把整个文件读进 JS Heap 构造 Blob。
   *    经 Filesystem.getUri 取原生路径，再由 Capacitor.convertFileSrc 映射为
   *    WebView 本地服务 URL（https://localhost/_capacitor_file_/...，与 App 同源，
   *    不受 Android WebView 禁止 <audio> 加载 file:// 的限制），
   *    <audio> 直接从磁盘流式读取，播放内存占用 O(1)，与文件大小无关。
   *    注意：返回的不是 blob: URL，调用方 URL.revokeObjectURL 对其是安全的 no-op。
   *  - Web 平台：Capacitor Filesystem 二进制读取直接返回 Blob（浏览器托管，
   *    桌面端通常由可落盘的 Blob 存储管理），避免旧实现
   *    「base64 字符串 + atob + Uint8Array + Blob」的多份峰值拷贝。
   *  - 兜底：原生平台 getUri 失败时退回二进制读取路径（旧版行为）。
   *  - 文件缺失/为空时抛错，不再静默返回空 Blob URL。
   */
  async readAsBlobUrl(key: string): Promise<string> {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`Cache entry not found: ${key}`);

    // v22-append-fix: 先把内存缓冲刷入磁盘，保证读到的内容完整
    await this.flushPending(key);

    entry.lastAccessedAt = Date.now();

    if (Capacitor.isNativePlatform()) {
      try {
        const stat = await Filesystem.getUri({
          path: entry.filePath,
          directory: Directory.Data,
        });
        if (stat.uri) {
          const url = Capacitor.convertFileSrc(stat.uri);
          debugLogger.info('streaming', 'Playing from cache via zero-copy file URL', {
            key,
            fileSize: entry.totalSize,
          });
          return url;
        }
        debugLogger.warn('streaming', 'getUri returned empty uri, falling back to blob read', {
          key,
        });
      } catch (err) {
        debugLogger.warn('streaming', 'Zero-copy file URL unavailable, falling back to blob read', {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const blob = await this.readFileAsBlob(entry.filePath, MIME_BY_FORMAT[entry.format]);
    if (blob.size === 0) {
      throw new Error(`Cache file empty or unreadable: ${entry.filePath}`);
    }
    return URL.createObjectURL(blob);
  }

  /**
   * v22-mem-fix: 读取缓存文件为 Blob（Web / 兜底路径）
   * 优先直接使用 Filesystem 返回的 Blob（浏览器托管存储），
   * 仅当实现返回 base64 字符串时才解码一次，避免多余的全量拷贝
   */
  private async readFileAsBlob(filePath: string, mime: string): Promise<Blob> {
    try {
      const result = await Filesystem.readFile({
        path: filePath,
        directory: Directory.Data,
      });
      if (result.data instanceof Blob) {
        return result.data;
      }
      if (typeof result.data === 'string') {
        const bytes = base64ToArrayBuffer(result.data);
        return new Blob([bytes as unknown as BlobPart], { type: mime });
      }
      return new Blob([result.data as unknown as BlobPart], { type: mime });
    } catch {
      return new Blob([]);
    }
  }

  /**
   * 获取缓存文件的本地持久路径 URI（用于直接给 <audio> 播放）
   * 比 Blob URL 更稳定，绕过内存中的竞态问题
   */
  async readAsFileUrl(key: string): Promise<string> {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`Cache entry not found: ${key}`);

    // v22-append-fix: 先把内存缓冲刷入磁盘（原生路径一般无缓冲，防御性调用）
    await this.flushPending(key);

    const stat = await Filesystem.getUri({
      path: entry.filePath,
      directory: Directory.Data,
    });

    entry.lastAccessedAt = Date.now();
    return stat.uri;
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

    this.discardPending(key);
    this.diskSizes.delete(key);
    this.entries.delete(key);
    await this.saveMeta();
  }

  /**
   * LRU 清理：优先删除最久未访问的条目，直到总大小与文件数都低于上限
   * v22-lru-fix:
   *  - 新增文件数量上限（maxFiles）
   *  - 跳过活跃条目（正在播放/下载中），全部活跃时安全退出、不误删
   *  - 触发点：init（启动）、写入后防抖（scheduleCleanup）、定期（startPeriodicCleanup）
   */
  async cleanupLRU(): Promise<void> {
    const allEntries = Array.from(this.entries.values());

    const totalSize = allEntries.reduce((sum, e) => sum + e.totalSize, 0);
    const fileCount = allEntries.length;

    // 未超限：无需清理
    if (totalSize <= this.maxSize && fileCount <= this.maxFiles) return;

    // 候选驱逐集：非活跃条目，按最久未访问排序
    const candidates = allEntries
      .filter((e) => !this.activeKeys.has(e.key))
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

    let currentTotal = totalSize;
    let currentCount = fileCount;
    let evicted = 0;

    for (const victim of candidates) {
      if (currentTotal <= this.maxSize && currentCount <= this.maxFiles) break;

      try {
        await Filesystem.deleteFile({
          path: victim.filePath,
          directory: Directory.Data,
        });
      } catch {
        // 忽略删除错误（文件可能不存在）
      }
      // v22-append-fix: 被淘汰的条目若有未落盘缓冲，直接丢弃（文件已删除，刷盘无意义）
      this.discardPending(victim.key);
      this.diskSizes.delete(victim.key);
      this.entries.delete(victim.key);
      currentTotal -= victim.totalSize;
      currentCount -= 1;
      evicted += 1;

      debugLogger.info('streaming', `LRU evicted: ${victim.key}`, {
        size: victim.totalSize,
      });
    }

    if (evicted > 0) {
      debugLogger.info('streaming', 'LRU cleanup finished', {
        evicted,
        remainingSize: currentTotal,
        remainingFiles: currentCount,
      });
      await this.saveMeta();
    }
  }

  /**
   * 清空所有缓存
   */
  async clear(): Promise<void> {
    for (const key of this.entries.keys()) {
      await this.deleteEntry(key);
    }
    this.entries.clear();
    // v22-append-fix: 兜底丢弃所有残留内存缓冲
    this.discardAllPending();
    await this.saveMeta();
  }

  // === 内部方法 ===

  /**
   * v22-lru-fix: 写入后防抖触发清理——把连续 chunk 写入合并为一次 cleanupLRU
   */
  private scheduleCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = null;
      this.cleanupLRU().catch((err) => {
        debugLogger.warn('streaming', 'Scheduled LRU cleanup failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.cleanupDebounceMs);
    // node 环境下避免定时器阻塞进程退出（浏览器无此方法）
    const timer = this.cleanupTimer as unknown as { unref?: () => void };
    if (typeof timer?.unref === 'function') timer.unref();
  }

  /**
   * v22-lru-fix: 定期清理（init 时启动，默认每 10 分钟一次）
   */
  private startPeriodicCleanup(): void {
    if (this.periodicTimer) return;
    this.periodicTimer = setInterval(() => {
      this.cleanupLRU().catch((err) => {
        debugLogger.warn('streaming', 'Periodic LRU cleanup failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.cleanupIntervalMs);
    const timer = this.periodicTimer as unknown as { unref?: () => void };
    if (typeof timer?.unref === 'function') timer.unref();
  }

  /**
   * v22-append-fix: 获取文件当前在磁盘上的字节数（会话内缓存，只做一次 stat）
   * 文件不存在时返回 0
   */
  private async getDiskSize(key: string): Promise<number> {
    const cached = this.diskSizes.get(key);
    if (cached !== undefined) return cached;

    const entry = this.entries.get(key);
    if (!entry) return 0;

    try {
      const stat = await Filesystem.stat({
        path: entry.filePath,
        directory: Directory.Data,
      });
      this.diskSizes.set(key, stat.size);
      return stat.size;
    } catch {
      this.diskSizes.set(key, 0);
      return 0;
    }
  }

  /**
   * v22-append-fix: Web 端顺序追加缓冲
   * 顺序 chunk 依次入缓冲；遇到非顺序偏移先刷掉已有缓冲再重新起缓冲
   */
  private async bufferAppend(key: string, data: Uint8Array, offset: number): Promise<void> {
    let chunks = this.pendingChunks.get(key);
    if (chunks && chunks.length > 0) {
      const bufferEnd = (this.pendingStart.get(key) || 0) + (this.pendingBytes.get(key) || 0);
      if (bufferEnd !== offset) {
        // 非顺序：先刷已有缓冲，再为本 chunk 起新缓冲
        await this.flushPending(key);
        chunks = undefined;
      }
    }

    if (!chunks) {
      chunks = [];
      this.pendingChunks.set(key, chunks);
      this.pendingStart.set(key, offset);
      this.pendingBytes.set(key, 0);
    }

    chunks.push(data);
    this.pendingBytes.set(key, (this.pendingBytes.get(key) || 0) + data.length);

    if ((this.pendingBytes.get(key) || 0) >= FLUSH_THRESHOLD_BYTES) {
      await this.flushPending(key);
    }
  }

  /**
   * v22-append-fix: 把指定 key 的缓冲合并写回磁盘
   * 顺序场景只做一次「读现有文件 + 拼接缓冲 + 写回」，把 N 次 O(n) 读写摊薄为 1 次
   */
  private async flushPending(key: string): Promise<void> {
    const entry = this.entries.get(key);
    const chunks = this.pendingChunks.get(key);
    if (!entry || !chunks || chunks.length === 0) {
      this.discardPending(key);
      return;
    }

    const start = this.pendingStart.get(key) || 0;
    const totalBytes = this.pendingBytes.get(key) || 0;

    // 拼接缓冲（整个过程只这一次内存拷贝）
    const merged = new Uint8Array(totalBytes);
    let pos = 0;
    for (const chunk of chunks) {
      merged.set(chunk, pos);
      pos += chunk.length;
    }
    this.discardPending(key);

    try {
      if (start === 0) {
        const diskSize = await this.getDiskSize(key);
        if (diskSize === 0) {
          // 磁盘为空/不存在：直接整体写入
          await this.writeFile(entry.filePath, merged);
          this.diskSizes.set(key, merged.length);
          return;
        }
      }

      const diskSize = await this.getDiskSize(key);
      const existing = await this.readFileBytes(entry.filePath);

      if (start === existing.length) {
        // 追加语义：existing + merged
        const out = new Uint8Array(existing.length + merged.length);
        out.set(existing, 0);
        out.set(merged, existing.length);
        await this.writeFile(entry.filePath, out);
        this.diskSizes.set(key, out.length);
      } else {
        // 非顺序合并（罕见）：放置到指定偏移
        const newSize = Math.max(existing.length, start + merged.length);
        const out = new Uint8Array(newSize);
        out.set(existing, 0);
        out.set(merged, start);
        await this.writeFile(entry.filePath, out);
        this.diskSizes.set(key, newSize);
      }
    } catch (err) {
      // 刷盘失败：把数据放回缓冲，等待下次 flush 重试（内存区间元数据仍然准确）
      this.pendingChunks.set(key, [merged]);
      this.pendingStart.set(key, start);
      this.pendingBytes.set(key, merged.length);
      debugLogger.error('streaming', `Cache flush failed: ${key}`, {
        start,
        bytes: merged.length,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * v22-append-fix: 丢弃指定 key 的内存缓冲（不落盘）
   * 用于条目被删除/淘汰的场景
   */
  private discardPending(key: string): void {
    this.pendingChunks.delete(key);
    this.pendingStart.delete(key);
    this.pendingBytes.delete(key);
  }

  /**
   * v22-append-fix: 丢弃全部内存缓冲
   */
  private discardAllPending(): void {
    this.pendingChunks.clear();
    this.pendingStart.clear();
    this.pendingBytes.clear();
  }

  /**
   * v22-append-fix: 读-合并-写（非顺序写入路径）
   * 仅低频触发（seek 后的范围下载、预取回填）
   */
  private async mergeWrite(
    key: string,
    filePath: string,
    data: Uint8Array,
    offset: number
  ): Promise<void> {
    const existing = await this.readFileBytes(filePath);
    const newSize = Math.max(existing.length, offset + data.length);
    const merged = new Uint8Array(newSize);
    merged.set(existing, 0);
    merged.set(data, offset);
    await this.writeFile(filePath, merged);
    this.diskSizes.set(key, newSize);
  }

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
    } catch (err) {
      // 元数据文件可能不存在；其他异常记录便于排查
      debugLogger.warn('streaming', 'loadMeta failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 保存元数据
   */
  private async saveMeta(): Promise<void> {
    // v22-append-fix: 持久化元数据前先刷出所有内存缓冲，
    // 保证 downloadedRanges 不会"超前"于磁盘实际内容
    try {
      await this.flushAll();
    } catch {
      // 刷盘失败时不持久化元数据——元数据保持旧值是安全方向（最多重新下载），
      // 否则会把"缓冲中未落盘"的数据当成已下载
      debugLogger.warn('streaming', 'Skip saving cache meta due to pending flush failure');
      return;
    }

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
   * v22-lru-fix: 同时清理孤儿文件——磁盘上存在但元数据未跟踪的缓存文件
   * （meta 丢失/损坏后遗留的文件不再无限累积），META_FILE 自身除外
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

      // v22-lru-fix: 清理孤儿文件
      const trackedNames = new Set(
        Array.from(this.entries.values()).map((e) => e.filePath.split('/').pop())
      );
      for (const f of result.files) {
        if (f.name === META_FILE || trackedNames.has(f.name)) continue;
        try {
          await Filesystem.deleteFile({
            path: `${CACHE_DIR}/${f.name}`,
            directory: Directory.Data,
          });
          debugLogger.info('streaming', `Removed orphan cache file: ${f.name}`);
        } catch {
          // 忽略删除错误
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
