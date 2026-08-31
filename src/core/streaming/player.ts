/**
 * 流式音频播放器
 * v14.4: 边下边播核心实现
 *
 * 支持两种播放模式（按可用性自动选择）：
 * A. MSE 模式（优先）：MediaSource + SourceBuffer 真流式
 * B. Blob 刷新模式（回退）：累积 chunks → 定期刷新 blob URL
 *
 * 特性：
 * - 首块 256KB 到手即出声（目标 ≤2 秒）
 * - 播放中后台持续拉取
 * - 支持 seek（未缓存区域触发新 Range 请求）
 * - 播放后半段预取下一首首块
 */

import { StreamFetcher, type ChunkInfo, type FetcherCallbacks } from './fetcher';
import { streamCacheEngine, type CacheEntry } from './cache';
import { detectMSECapability, isMSEAvailable } from './mseDetector';
import { debugLogger } from '@shared/utils/debugLogger';

export type StreamingState =
  | 'idle'
  | 'loading' // 正在下载首块
  | 'ready' // 首块就绪，可以播放
  | 'playing'
  | 'paused'
  | 'buffering' // 播放中等待数据
  | 'seeking'
  | 'completed'
  | 'error';

export interface StreamingCallbacks {
  onStateChange?: (state: StreamingState) => void;
  onProgress?: (currentTime: number, duration: number) => void;
  onError?: (message: string) => void;
  onEnded?: () => void;
  onCanPlay?: () => void;
}

interface StreamingOptions {
  url: string;
  headers?: Record<string, string>;
  cacheKey: string;
  format?: string;
}

const PRELOAD_THRESHOLD = 0.5; // 播放进度超过 50% 时预取下一首
const BUFFER_THRESHOLD = 0.85; // 当播放进度达到已缓存数据的 85% 时刷新缓冲区
const MIN_CHUNKS_BEFORE_REFRESH = 2; // 至少下载 N 个 chunks 后才刷新 blob URL

class StreamingAudioPlayer {
  private audio: HTMLAudioElement | null = null;
  private fetcher = new StreamFetcher();
  private state: StreamingState = 'idle';
  private callbacks: StreamingCallbacks = {};

  // 数据缓冲
  private chunks: Array<{ data: Uint8Array; start: number; end: number }> = [];
  private totalDownloaded = 0;
  private totalSize = 0;
  private mimeType = 'audio/mpeg';

  // 播放控制
  private pendingSeekTime = -1;
  private lastReportedTime = 0;
  private progressTimer: number | null = null;
  private blobUrl: string | null = null;

  // MSE 相关
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private useMSE = false;
  private mseQueue: Uint8Array[] = [];
  private mseUpdating = false;

  // 缓存
  private cacheKey = '';
  private cacheEntry: CacheEntry | null = null;

  // 预取下一首
  private prefetchFetcher: StreamFetcher | null = null;
  private prefetchCallbacks?: StreamingCallbacks;

  // === 公共接口 ===

  setCallbacks(callbacks: StreamingCallbacks): void {
    this.callbacks = callbacks;
  }

  getState(): StreamingState {
    return this.state;
  }

  getCurrentTime(): number {
    return this.audio?.currentTime ?? 0;
  }

  getDuration(): number {
    return this.audio?.duration ?? 0;
  }

  /**
   * 加载并开始流式播放
   */
  async load(options: StreamingOptions): Promise<void> {
    await this.reset();

    this.cacheKey = options.cacheKey;
    this.mimeType = this.inferMimeType(options.format);

    // 检测 MSE 可用性
    const mseCap = detectMSECapability();
    this.useMSE = mseCap.isUsable && mseCap.preferredMimeType === this.mimeType;

    debugLogger.info('streaming', 'StreamingAudioPlayer.load', {
      cacheKey: options.cacheKey,
      useMSE: this.useMSE,
      mimeType: this.mimeType,
    });

    // 初始化缓存
    await streamCacheEngine.init();
    this.cacheEntry = await streamCacheEngine.getOrCreateEntry(
      options.cacheKey,
      options.format || 'mp3'
    );

    // 如果缓存中已有完整文件，直接播放本地缓存
    if (this.cacheEntry.totalSize > 0 && this.isCacheComplete()) {
      debugLogger.info('streaming', 'Playing from complete cache');
      await this.playFromCache();
      return;
    }

    // 设置 fetcher 回调
    this.fetcher.setCallbacks(this.buildFetcherCallbacks());

    // 开始下载（从缓存已下载的最远位置开始）
    const resumeOffset = this.getResumeOffset();
    this.setState('loading');
    await this.fetcher.start(options.url, options.headers, resumeOffset);
  }

  /**
   * 播放（在 load 后调用，或从暂停恢复）
   */
  async play(): Promise<void> {
    if (!this.audio) return;

    try {
      await this.audio.play();
      this.setState('playing');
      this.startProgressTracking();
    } catch (err) {
      this.setState('paused');
      this.callbacks.onError?.('播放被阻止，请点击播放按钮');
    }
  }

  /**
   * 暂停
   */
  pause(): void {
    this.audio?.pause();
    this.setState('paused');
    this.stopProgressTracking();
  }

  /**
   * Seek 到指定时间（秒）
   */
  async seek(time: number): Promise<void> {
    if (!this.audio || this.totalSize === 0) return;

    const duration = this.audio.duration || 1;
    const clampedTime = Math.max(0, Math.min(time, duration));
    const bytePosition = Math.floor((clampedTime / duration) * this.totalSize);

    debugLogger.info('streaming', 'Seek requested', {
      time: clampedTime,
      bytePosition,
      totalSize: this.totalSize,
    });

    // 检查目标位置是否已缓存
    if (streamCacheEngine.isRangeDownloaded(this.cacheKey, bytePosition, bytePosition + 1)) {
      // 已缓存，直接 seek
      this.audio.currentTime = clampedTime;
      return;
    }

    // 未缓存，需要重新从目标位置下载
    this.setState('seeking');
    this.pendingSeekTime = clampedTime;

    // 停止当前下载
    await this.fetcher.stop();

    // 清理当前缓冲（保留已下载的数据）
    // 不清理 chunks，因为它们可能包含 seek 目标附近的数据

    // 从 seek 位置重新开始下载
    const url = this.fetcher['url']; // 从 fetcher 获取 URL
    const headers = this.fetcher['headers'];
    await this.fetcher.start(url, headers, bytePosition);
  }

  /**
   * 设置音量
   */
  setVolume(volume: number): void {
    if (this.audio) {
      this.audio.volume = Math.max(0, Math.min(1, volume));
    }
  }

  /**
   * 预取下一首的首块数据
   */
  async prefetchNext(options: StreamingOptions): Promise<void> {
    // 如果正在预取，先停止
    if (this.prefetchFetcher) {
      await this.prefetchFetcher.stop();
    }

    this.prefetchFetcher = new StreamFetcher();

    // 只预取首块（256KB）
    let chunkReceived = false;
    this.prefetchFetcher.setCallbacks({
      onChunkComplete: async (chunk: ChunkInfo, data: Uint8Array) => {
        if (chunk.index === 0 && !chunkReceived) {
          chunkReceived = true;
          // 写入缓存
          await streamCacheEngine.appendData(options.cacheKey, data, chunk.start);
          debugLogger.info('streaming', 'Prefetched next track first chunk', {
            cacheKey: options.cacheKey,
            size: data.length,
          });
          // 预取完成，停止
          await this.prefetchFetcher?.stop();
        }
      },
    });

    await this.prefetchFetcher.start(options.url, options.headers, 0);
  }

  /**
   * 停止并清理所有资源
   */
  async reset(): Promise<void> {
    this.stopProgressTracking();

    // 停止 fetcher
    await this.fetcher.stop();
    if (this.prefetchFetcher) {
      await this.prefetchFetcher.stop();
      this.prefetchFetcher = null;
    }

    // 清理 audio
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.audio = null;
    }

    // 清理 MSE
    if (this.mediaSource) {
      try {
        if (this.mediaSource.readyState === 'open') {
          this.mediaSource.endOfStream();
        }
      } catch {
        // 忽略
      }
      this.mediaSource = null;
      this.sourceBuffer = null;
    }

    // 释放 blob URL
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }

    // 重置状态
    this.chunks = [];
    this.totalDownloaded = 0;
    this.totalSize = 0;
    this.pendingSeekTime = -1;
    this.mseQueue = [];
    this.mseUpdating = false;
    this.cacheKey = '';
    this.cacheEntry = null;

    this.setState('idle');
  }

  // === 内部播放逻辑 ===

  /**
   * 从完整缓存直接播放
   */
  private async playFromCache(): Promise<void> {
    const blobUrl = await streamCacheEngine.readAsBlobUrl(this.cacheKey);
    this.blobUrl = blobUrl;
    this.setupAudio(blobUrl);
    this.setState('ready');
    await this.play();
  }

  /**
   * 首块下载完成，开始播放
   */
  private async onFirstChunkReady(): Promise<void> {
    if (this.useMSE) {
      await this.setupMSE();
    } else {
      await this.setupBlobPlayback();
    }

    this.setState('ready');
    this.callbacks.onCanPlay?.();
    await this.play();
  }

  /**
   * Blob 刷新模式：创建/刷新 audio.src
   */
  private async setupBlobPlayback(): Promise<void> {
    // 合并所有 chunks
    const allData = this.mergeChunks();
    if (allData.length === 0) return;

    // 写入缓存
    await streamCacheEngine.writeData(this.cacheKey, allData);

    // 创建 blob URL
    const blob = new Blob([allData as unknown as BlobPart], { type: this.mimeType });
    const newUrl = URL.createObjectURL(blob);

    // 记录当前播放时间
    const currentTime = this.audio?.currentTime ?? 0;

    // 释放旧 URL
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
    }
    this.blobUrl = newUrl;

    // 设置/刷新 audio
    if (!this.audio) {
      this.setupAudio(newUrl);
    } else {
      this.audio.src = newUrl;
      // 恢复播放位置
      if (currentTime > 0) {
        this.audio.currentTime = currentTime;
      }
      try {
        await this.audio.play();
      } catch {
        // 自动播放策略可能阻止
      }
    }
  }

  /**
   * MSE 模式：设置 MediaSource
   */
  private async setupMSE(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.mediaSource = new MediaSource();
        const url = URL.createObjectURL(this.mediaSource);
        this.blobUrl = url;

        this.mediaSource.addEventListener('sourceopen', () => {
          if (!this.mediaSource) return;

          try {
            this.sourceBuffer = this.mediaSource.addSourceBuffer(this.mimeType);
            this.sourceBuffer.mode = 'segments';

            this.sourceBuffer.addEventListener('updateend', () => {
              this.mseUpdating = false;
              this.flushMSEQueue();
            });

            this.sourceBuffer.addEventListener('error', (e) => {
              debugLogger.error('streaming', 'SourceBuffer error', { error: String(e) });
            });

            // 先追加已有的 chunks
            for (const chunk of this.chunks) {
              this.appendToMSE(chunk.data);
            }

            this.setupAudio(url);
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        this.mediaSource.addEventListener('error', (e) => {
          reject(new Error(`MediaSource error: ${String(e)}`));
        });

        // 设置超时
        setTimeout(() => {
          if (!this.sourceBuffer) {
            reject(new Error('MediaSource sourceopen timeout'));
          }
        }, 5000);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * 追加数据到 MSE SourceBuffer
   */
  private appendToMSE(data: Uint8Array): void {
    if (!this.sourceBuffer || !this.mediaSource) return;

    if (this.mseUpdating) {
      this.mseQueue.push(data);
      return;
    }

    try {
      this.mseUpdating = true;
      this.sourceBuffer.appendBuffer(data as unknown as BufferSource);
    } catch (err) {
      this.mseUpdating = false;
      debugLogger.error('streaming', 'appendBuffer failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private flushMSEQueue(): void {
    if (this.mseQueue.length > 0 && !this.mseUpdating) {
      const data = this.mseQueue.shift()!;
      this.appendToMSE(data);
    }
  }

  /**
   * 设置 HTMLAudioElement
   */
  private setupAudio(url: string): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
    }

    this.audio = new Audio(url);
    this.audio.crossOrigin = 'anonymous';

    this.audio.addEventListener('canplay', () => {
      if (this.state === 'loading' || this.state === 'buffering') {
        this.setState('playing');
      }
    });

    this.audio.addEventListener('ended', () => {
      this.setState('completed');
      this.callbacks.onEnded?.();
    });

    this.audio.addEventListener('error', () => {
      this.setState('error');
      this.callbacks.onError?.('音频播放失败');
    });

    this.audio.addEventListener('waiting', () => {
      if (this.state === 'playing') {
        this.setState('buffering');
      }
    });

    this.audio.addEventListener('playing', () => {
      if (this.state === 'buffering' || this.state === 'loading') {
        this.setState('playing');
      }
    });
  }

  // === Fetcher 回调构建 ===

  private buildFetcherCallbacks(): FetcherCallbacks {
    return {
      onChunkComplete: async (chunk, data) => {
        // 保存 chunk
        this.chunks.push({ data, start: chunk.start, end: chunk.end });
        this.totalDownloaded += data.length;

        // 更新总大小
        if (chunk.end + 1 > this.totalSize) {
          this.totalSize = chunk.end + 1;
        }

        // 写入缓存
        await streamCacheEngine.appendData(this.cacheKey, data, chunk.start);

        // 首块完成 → 开始播放
        if (chunk.index === 0 && this.state === 'loading') {
          debugLogger.info('streaming', 'First chunk ready, starting playback', {
            size: data.length,
          });
          await this.onFirstChunkReady();
          return;
        }

        // MSE 模式：直接追加到 SourceBuffer
        if (this.useMSE && this.sourceBuffer) {
          this.appendToMSE(data);
          return;
        }

        // Blob 模式：定期刷新
        if (!this.useMSE && chunk.index > 0 && chunk.index % MIN_CHUNKS_BEFORE_REFRESH === 0) {
          // 检查是否需要刷新（播放进度接近已缓存末尾）
          if (this.shouldRefreshBlob()) {
            await this.setupBlobPlayback();
          }
        }
      },

      onProgress: (progress) => {
        // 更新总大小（如果从响应中获取到）
        if (progress.overallTotalBytes > this.totalSize) {
          this.totalSize = progress.overallTotalBytes;
        }
      },

      onError: (error) => {
        this.setState('error');
        this.callbacks.onError?.(error.message);
      },

      onComplete: () => {
        debugLogger.info('streaming', 'All chunks downloaded');
        // MSE 模式下标记流结束
        if (this.useMSE && this.mediaSource?.readyState === 'open') {
          try {
            this.mediaSource.endOfStream();
          } catch {
            // 忽略
          }
        }
      },
    };
  }

  // === 辅助方法 ===

  /**
   * 判断是否需要刷新 blob URL（播放接近已缓存末尾）
   */
  private shouldRefreshBlob(): boolean {
    if (!this.audio || this.totalSize === 0) return false;

    const duration = this.audio.duration || 1;
    const currentTime = this.audio.currentTime;
    const progress = currentTime / duration;

    // 已缓存的比例
    const cachedRatio = this.totalDownloaded / this.totalSize;

    // 当播放进度超过已缓存数据的 85% 时刷新
    return progress > cachedRatio * BUFFER_THRESHOLD;
  }

  /**
   * 检查缓存是否完整
   */
  private isCacheComplete(): boolean {
    if (!this.cacheEntry || this.cacheEntry.totalSize === 0) return false;
    return streamCacheEngine.isRangeDownloaded(
      this.cacheKey,
      0,
      this.cacheEntry.totalSize - 1
    );
  }

  /**
   * 获取恢复下载的偏移量（从已下载的最远位置继续）
   */
  private getResumeOffset(): number {
    const entry = streamCacheEngine.getEntry(this.cacheKey);
    if (!entry || entry.downloadedRanges.length === 0) return 0;

    // 找到最远已下载位置
    let maxEnd = 0;
    for (const range of entry.downloadedRanges) {
      if (range.end > maxEnd) maxEnd = range.end;
    }
    return maxEnd + 1;
  }

  /**
   * 合并所有 chunks 为单个 Uint8Array
   */
  private mergeChunks(): Uint8Array {
    if (this.chunks.length === 0) return new Uint8Array(0);

    // 按 start 排序
    const sorted = [...this.chunks].sort((a, b) => a.start - b.start);

    // 计算总大小
    const last = sorted[sorted.length - 1];
    const totalSize = last.end + 1;

    const merged = new Uint8Array(totalSize);
    for (const chunk of sorted) {
      merged.set(chunk.data, chunk.start);
    }

    return merged;
  }

  /**
   * 推断 MIME 类型
   */
  private inferMimeType(format?: string): string {
    const map: Record<string, string> = {
      mp3: 'audio/mpeg',
      flac: 'audio/flac',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      ogg: 'audio/ogg',
      aac: 'audio/aac',
    };
    return map[format || ''] || 'audio/mpeg';
  }

  /**
   * 设置状态并触发回调
   */
  private setState(state: StreamingState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  /**
   * 启动进度追踪
   */
  private startProgressTracking(): void {
    this.stopProgressTracking();
    this.progressTimer = window.setInterval(() => {
      if (this.audio) {
        const currentTime = this.audio.currentTime;
        const duration = this.audio.duration || 1;
        this.lastReportedTime = currentTime;
        this.callbacks.onProgress?.(currentTime, duration);

        // 检查是否需要预取下一首
        if (duration > 0 && currentTime / duration > PRELOAD_THRESHOLD) {
          // 通过回调让上层决定预取哪首
          // 这里只记录状态，实际预取由 PlayerEngine 调用 prefetchNext 完成
        }
      }
    }, 250);
  }

  private stopProgressTracking(): void {
    if (this.progressTimer !== null) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }
}

export const streamingAudioPlayer = new StreamingAudioPlayer();
