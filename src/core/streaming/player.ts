/**
 * 流式音频播放器
 * v14.5: 边下边播核心实现
 * 修复：首块播放竞态（文件完整性校验 + 本地文件URI优先 + audio就绪等待）
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
import { QishuiCencDecryptor } from '@providers/music/QishuiCencDecryptor';
import { fetchZ3dKey, createZ3dDecryptStream } from '@shared/audio/crypto';

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
  url?: string;
  headers?: Record<string, string>;
  cacheKey: string;
  format?: string;
  /** v21.3: CENC 加密流标记 */
  isEncrypted?: boolean;
  /** v21.3: CENC 解密密钥（isEncrypted=true 时必填） */
  decryptKey?: string;
  /**
   * v21.4: 咪咕 Z3D 解密信息（z3dUrl + p3dUrl，播放前通过 3D60 已知明文攻击提取密钥）
   */
  z3dDecryptInfo?: {
    z3dUrl: string;
    p3dUrl: string;
  };
}

const PRELOAD_THRESHOLD = 0.5; // 播放进度超过 50% 时预取下一首
const BUFFER_THRESHOLD = 0.85; // 当播放进度达到已缓存数据的 85% 时刷新缓冲区
const MIN_CHUNKS_BEFORE_REFRESH = 2; // 至少下载 N 个 chunks 后才刷新 blob URL
const BLOB_REFRESH_SIZE_THRESHOLD = 256 * 1024; // Blob 模式下每下载 256KB 触发一次刷新

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
  /** v23-fix: seek 前是否处于播放态（seek 数据到位后据此恢复播放/暂停） */
  private seekResumePlay = false;
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

  // Blob 刷新追踪
  private lastRefreshDownloaded = 0;

  // v18 EQ：audio 元素创建监听（均衡器挂接新元素用）
  private audioElementListener: ((el: HTMLAudioElement | null) => void) | null = null;

  // v21.3: 加密流状态
  private isEncryptedStream = false;
  private encryptedStreamAbortController: AbortController | null = null;

  // === 公共接口 ===

  setCallbacks(callbacks: StreamingCallbacks): void {
    this.callbacks = callbacks;
  }

  /** v18 EQ：监听 audio 元素创建/销毁（均衡器据此挂接） */
  setAudioElementListener(l: ((el: HTMLAudioElement | null) => void) | null): void {
    this.audioElementListener = l;
  }

  getAudioElement(): HTMLAudioElement | null {
    return this.audio;
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

    // v21.3: 加密流走独立路径（fetch + decryptStream + Blob 刷新）
    if (options.isEncrypted && options.decryptKey) {
      this.isEncryptedStream = true;
      this.useMSE = false;
      debugLogger.info('streaming', 'StreamingAudioPlayer.load (encrypted)', {
        cacheKey: options.cacheKey,
        mimeType: this.mimeType,
      });

      // 初始化缓存
      await streamCacheEngine.init();
      this.cacheEntry = await streamCacheEngine.getOrCreateEntry(
        options.cacheKey,
        options.format || 'mp4'
      );

      // 如果缓存中已有完整文件，直接播放本地缓存
      if (this.cacheEntry.totalSize > 0 && this.isCacheComplete()) {
        debugLogger.info('streaming', 'Playing encrypted stream from complete cache');
        await this.playFromCache();
        return;
      }

      await this.loadEncryptedStream(options);
      return;
    }

    // v21.4: 咪咕 Z3D 加密流式播放（fetch + Z3D decryptStream + Blob 刷新）
    if (options.z3dDecryptInfo) {
      this.isEncryptedStream = true;
      this.useMSE = false;
      debugLogger.info('streaming', 'StreamingAudioPlayer.load (Z3D)', {
        cacheKey: options.cacheKey,
        mimeType: this.mimeType,
      });

      // 初始化缓存
      await streamCacheEngine.init();
      this.cacheEntry = await streamCacheEngine.getOrCreateEntry(
        options.cacheKey,
        options.format || 'wav'
      );

      // 如果缓存中已有完整文件，直接播放本地缓存
      if (this.cacheEntry.totalSize > 0 && this.isCacheComplete()) {
        debugLogger.info('streaming', 'Playing Z3D stream from complete cache');
        await this.playFromCache();
        return;
      }

      await this.loadZ3dStream(options);
      return;
    }

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
    if (!options.url) {
      throw new Error('StreamingAudioPlayer.load: url is required for fetch-based playback');
    }
    await this.fetcher.start(options.url, options.headers, resumeOffset);
  }

  /**
   * 加载已解密的完整音频数据并直接播放（用于 CENC 解密后场景）。
   * 不经过 fetcher，直接将数据写入缓存后播放。
   */
  async loadDecryptedData(data: Uint8Array, options: StreamingOptions): Promise<void> {
    await this.reset();

    this.cacheKey = options.cacheKey;
    this.mimeType = this.inferMimeType(options.format);
    this.totalSize = data.length;
    this.totalDownloaded = data.length;

    // 初始化缓存
    await streamCacheEngine.init();
    this.cacheEntry = await streamCacheEngine.getOrCreateEntry(
      options.cacheKey,
      options.format || 'mp3'
    );

    // 写入完整数据到缓存
    await streamCacheEngine.writeData(options.cacheKey, data);
    this.cacheEntry = streamCacheEngine.getEntry(options.cacheKey);

    this.setState('loading');
    await this.playFromCache();
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
   * v21.3: 加载 CENC 加密流（fetch + decryptStream + Blob 刷新）
   */
  private async loadEncryptedStream(options: StreamingOptions): Promise<void> {
    if (!options.decryptKey) {
      throw new Error('decryptKey is required for encrypted stream');
    }

    this.encryptedStreamAbortController = new AbortController();

    const response = await fetch(options.url!, {
      method: 'GET',
      headers: options.headers,
      signal: this.encryptedStreamAbortController.signal,
    });

    if (!response.ok) {
      throw new Error(`Encrypted stream fetch failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Encrypted stream response has no body');
    }

    const decryptor = new QishuiCencDecryptor(options.decryptKey);
    const decryptedStream = await decryptor.decryptStream(response.body);
    const reader = decryptedStream.getReader();

    this.setState('loading');

    const MIN_START_SIZE = 256 * 1024;
    let totalReceived = 0;
    let chunkIndex = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const start = totalReceived;
        const end = start + value.length - 1;
        this.chunks.push({ data: value, start, end });
        totalReceived += value.length;
        this.totalDownloaded = totalReceived;

        // 写入缓存
        await streamCacheEngine.appendData(this.cacheKey, value, start);

        // 首次达到起播阈值时开始播放
        if (this.state === 'loading' && totalReceived >= MIN_START_SIZE) {
          debugLogger.info('streaming', 'Encrypted stream first chunk ready', {
            cacheKey: this.cacheKey,
            received: totalReceived,
          });
          await this.onFirstChunkReady();
        }

        // 后续 chunks：定期刷新 blob URL
        if (chunkIndex > 0 && !this.useMSE) {
          const shouldRefreshBySize =
            this.totalDownloaded - this.lastRefreshDownloaded >= BLOB_REFRESH_SIZE_THRESHOLD;
          if (shouldRefreshBySize) {
            await this.setupBlobPlayback();
            this.lastRefreshDownloaded = this.totalDownloaded;
          }
        }

        chunkIndex++;
      }

      // 流结束后的处理
      if (this.state === 'loading') {
        // 数据量不足 MIN_START_SIZE，但流已结束，直接播放
        await this.onFirstChunkReady();
      } else if (!this.useMSE && this.chunks.length > 0) {
        // 最终刷新 blob
        debugLogger.info('streaming', 'Encrypted stream completed, final blob refresh');
        await this.setupBlobPlayback();
      }

      this.totalSize = totalReceived;
      if (this.cacheKey && this.totalSize > 0) {
        await streamCacheEngine.setExpectedTotalSize(this.cacheKey, this.totalSize);
      }
    } catch (err) {
      if (this.encryptedStreamAbortController?.signal.aborted) {
        // 正常取消，不报错
        return;
      }
      this.setState('error');
      this.callbacks.onError?.(err instanceof Error ? err.message : 'Encrypted stream failed');
      throw err;
    } finally {
      reader.releaseLock();
      this.encryptedStreamAbortController = null;
    }
  }

  /**
   * v21.4: 加载咪咕 Z3D 加密流（fetch + Z3D decryptStream + Blob 刷新）
   * P2: 大文件内存控制——起播后定期清空内存 chunks，数据已落地缓存
   */
  private async loadZ3dStream(options: StreamingOptions): Promise<void> {
    if (!options.z3dDecryptInfo) {
      throw new Error('z3dDecryptInfo is required for Z3D stream');
    }

    this.encryptedStreamAbortController = new AbortController();

    // 1. 通过 3D60 已知明文攻击提取 Z3D 密钥
    debugLogger.info('streaming', 'Z3D: extracting key via known-plaintext attack');
    let key: Uint8Array;
    try {
      key = await fetchZ3dKey(
        options.z3dDecryptInfo.z3dUrl,
        options.z3dDecryptInfo.p3dUrl,
        options.headers
      );
      debugLogger.info('streaming', 'Z3D: key extracted successfully');
    } catch (keyErr) {
      this.setState('error');
      this.callbacks.onError?.(
        `Z3D 密钥提取失败: ${keyErr instanceof Error ? keyErr.message : String(keyErr)}`
      );
      throw keyErr;
    }

    // 2. 创建解密流并发起 Z3D 下载
    const decryptStream = createZ3dDecryptStream(key);
    const response = await fetch(options.z3dDecryptInfo.z3dUrl, {
      method: 'GET',
      headers: options.headers,
      signal: this.encryptedStreamAbortController.signal,
    });

    if (!response.ok) {
      throw new Error(`Z3D stream fetch failed: ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error('Z3D stream response has no body');
    }

    const decryptedStream = response.body.pipeThrough(decryptStream);
    const reader = decryptedStream.getReader();

    this.setState('loading');

    const MIN_START_SIZE = 256 * 1024;
    let totalReceived = 0;
    let chunkIndex = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const start = totalReceived;
        const end = start + value.length - 1;
        this.chunks.push({ data: value, start, end });
        totalReceived += value.length;
        this.totalDownloaded = totalReceived;

        // 写入缓存
        await streamCacheEngine.appendData(this.cacheKey, value, start);

        // 首次达到起播阈值时开始播放
        if (this.state === 'loading' && totalReceived >= MIN_START_SIZE) {
          debugLogger.info('streaming', 'Z3D stream first chunk ready', {
            cacheKey: this.cacheKey,
            received: totalReceived,
          });
          await this.onFirstChunkReady();
          // P2: Z3D 大文件内存控制——起播后清空内存 chunks，数据已落地缓存
          this.chunks = [];
          debugLogger.info('streaming', 'Z3D: cleared in-memory chunks after first playback', {
            cacheKey: this.cacheKey,
          });
        }

        // 后续 chunks：定期刷新 blob URL
        if (chunkIndex > 0 && !this.useMSE) {
          const shouldRefreshBySize =
            this.totalDownloaded - this.lastRefreshDownloaded >= BLOB_REFRESH_SIZE_THRESHOLD;
          if (shouldRefreshBySize) {
            await this.setupBlobPlayback();
            this.lastRefreshDownloaded = this.totalDownloaded;
            // P2: Z3D 大文件内存控制——刷新后清空内存 chunks，数据已落地缓存
            this.chunks = [];
            debugLogger.info('streaming', 'Z3D: cleared in-memory chunks after blob refresh', {
              cacheKey: this.cacheKey,
              totalDownloaded: this.totalDownloaded,
            });
          }
        }

        chunkIndex++;
      }

      // 流结束后的处理
      if (this.state === 'loading') {
        // 数据量不足 MIN_START_SIZE，但流已结束，直接播放
        await this.onFirstChunkReady();
        this.chunks = []; // P2
      } else if (!this.useMSE && this.chunks.length > 0) {
        // 最终刷新 blob
        debugLogger.info('streaming', 'Z3D stream completed, final blob refresh');
        await this.setupBlobPlayback();
        this.chunks = []; // P2
      }

      this.totalSize = totalReceived;
      if (this.cacheKey && this.totalSize > 0) {
        await streamCacheEngine.setExpectedTotalSize(this.cacheKey, this.totalSize);
      }
    } catch (err) {
      if (this.encryptedStreamAbortController?.signal.aborted) {
        // 正常取消，不报错
        return;
      }
      this.setState('error');
      this.callbacks.onError?.(err instanceof Error ? err.message : 'Z3D stream failed');
      throw err;
    } finally {
      reader.releaseLock();
      this.encryptedStreamAbortController = null;
    }
  }

  /**
   * Seek 到指定时间（秒）
   * v23-fix: 修复 seek 到未缓存位置不生效的回弹问题：
   * 1. 元数据缺失（totalSize/duration 未知）时直接交给浏览器 seek，不再静默 return
   * 2. 未缓存位置重启下载后，由 onChunkComplete 消费 pendingSeekTime 回填播放位置
   */
  async seek(time: number): Promise<void> {
    if (!this.audio) return;

    const duration = this.audio.duration || 0;
    const clampedTime = duration > 0 ? Math.max(0, Math.min(time, duration)) : Math.max(0, time);

    // v21.3: 加密流由浏览器自行处理 seek（blob URL 顺序增长）
    if (this.isEncryptedStream) {
      this.audio.currentTime = clampedTime;
      return;
    }

    // v23-fix: 元数据缺失时直接 seek（已加载 blob 范围内生效），避免进度条回弹
    if (this.totalSize === 0 || duration <= 0) {
      try {
        this.audio.currentTime = clampedTime;
      } catch {
        // ignore
      }
      return;
    }

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
    // v23-fix: 先记录 seek 前的播放态，供数据到位后恢复
    const wasPlaying = this.state === 'playing';
    this.setState('seeking');
    this.pendingSeekTime = clampedTime;
    this.seekResumePlay = wasPlaying;

    // 停止当前下载
    await this.fetcher.stop();

    // 清理当前缓冲（保留已下载的数据）
    // 不清理 chunks，因为它们可能包含 seek 目标附近的数据

    // 从 seek 位置重新开始下载（skipHead: totalSize 已知，省一次 HEAD 往返）
    const url = this.fetcher.getUrl();
    const headers = this.fetcher.getHeaders();
    await this.fetcher.start(url, headers, bytePosition, { skipHead: true });
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

    if (!options.url) {
      debugLogger.warn('streaming', 'prefetchNext: url is required');
      return;
    }
    await this.prefetchFetcher.start(options.url, options.headers, 0);
  }

  /**
   * 停止并清理所有资源
   */
  async reset(): Promise<void> {
    this.stopProgressTracking();

    // 停止 fetcher / 加密流
    await this.fetcher.stop();
    if (this.encryptedStreamAbortController) {
      this.encryptedStreamAbortController.abort();
      this.encryptedStreamAbortController = null;
    }
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
    this.audioElementListener?.(null);

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
    this.seekResumePlay = false;
    this.mseQueue = [];
    this.mseUpdating = false;
    this.cacheKey = '';
    this.cacheEntry = null;
    this.lastRefreshDownloaded = 0;
    this.isEncryptedStream = false;
    this.encryptedStreamAbortController = null;

    this.setState('idle');
  }

  // === 内部播放逻辑 ===

  /**
   * 从完整缓存直接播放
   * v21.2 修复：增加缓存完整性校验，防止播放不完整/损坏的缓存文件
   */
  private async playFromCache(): Promise<void> {
    let url: string;
    let blobSize = 0;

    // v18-fix: Android WebView 禁止 <audio> 加载 file:// 本地文件，默认优先 blob URL
    // EQ 挂接在 audio 元素创建时处理，不依赖 URL 类型
    try {
      url = await streamCacheEngine.readAsBlobUrl(this.cacheKey);
      // v21.2 校验：读取到的 blob 大小必须与预期一致
      const entry = streamCacheEngine.getEntry(this.cacheKey);
      if (entry?.expectedTotalSize && entry.expectedTotalSize > 0) {
        // 通过 fetch 验证 blob 的实际大小（readAsBlobUrl 已读取全部字节到内存，这里取 blob 长度）
        // 由于 readAsBlobUrl 内部已用 readFileBytes 读取，直接检查 entry.totalSize 更轻量
        blobSize = entry.totalSize;
        if (blobSize !== entry.expectedTotalSize) {
          throw new Error(
            `Cache size mismatch: actual=${blobSize}, expected=${entry.expectedTotalSize}`
          );
        }
      }
      debugLogger.info('streaming', 'Playing from complete cache (blob URL)', {
        cacheKey: this.cacheKey,
        blobSize,
        expectedSize: entry?.expectedTotalSize,
      });
    } catch (err) {
      // 如果 blob 读取或校验失败，尝试 file URL 回退
      debugLogger.warn('streaming', 'Blob URL cache failed, trying file URL fallback', {
        cacheKey: this.cacheKey,
        error: err instanceof Error ? err.message : String(err),
      });
      url = await streamCacheEngine.readAsFileUrl(this.cacheKey);
      debugLogger.info('streaming', 'Playing from complete cache (file URL fallback)', {
        cacheKey: this.cacheKey,
      });
    }

    this.blobUrl = url;
    await this.setupAudioWithReadyWait(url);

    // v21.2 修复：校验 audio 是否进入 error 状态（缓存损坏/不完整的常见表现）
    if (this.audio?.error) {
      const errCode = this.audio.error.code;
      const errMsg = this.audio.error.message || 'unknown';
      throw new Error(`Audio element entered error state during cache playback: code=${errCode}, msg=${errMsg}`);
    }

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
   * v14.5 修复：增加就绪等待 + 本地文件 URI 优先，解决首块竞态问题
   * v21.2 修复：size mismatch 时用实际 mergeChunks 数据建 blob，避免 totalSize 截断
   */
  private async setupBlobPlayback(): Promise<void> {
    // 合并所有 chunks
    const allData = this.mergeChunks();

    // v21.4 P2: Z3D 大文件内存控制——chunks 已清空时直接从缓存构造 blob
    if (allData.length === 0) {
      try {
        const newUrl = await streamCacheEngine.readAsBlobUrl(this.cacheKey);
        // v23-fix: seek 未回填时优先用 seek 目标位置恢复
        const currentTime = this.pendingSeekTime >= 0 ? this.pendingSeekTime : (this.audio?.currentTime ?? 0);
        if (this.pendingSeekTime >= 0) {
          this.pendingSeekTime = -1;
        }
        if (this.blobUrl) {
          URL.revokeObjectURL(this.blobUrl);
        }
        this.blobUrl = newUrl;
        if (!this.audio) {
          await this.setupAudioWithReadyWait(newUrl);
        } else {
          this.audio.src = newUrl;
          if (currentTime > 0) {
            this.audio.currentTime = currentTime;
          }
          try {
            await this.audio.play();
          } catch {
            // 自动播放策略可能阻止
          }
        }
        debugLogger.info('streaming', 'Blob refresh from cache (chunks cleared)', {
          cacheKey: this.cacheKey,
        });
        return;
      } catch (cacheErr) {
        debugLogger.warn('streaming', 'setupBlobPlayback: chunks empty and cache read failed', {
          error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
        });
        return;
      }
    }

    // 文件完整性校验
    const hasSizeMismatch = this.totalSize > 0 && allData.length !== this.totalSize;
    if (hasSizeMismatch) {
      debugLogger.warn('streaming', 'setupBlobPlayback: size mismatch', {
        mergedSize: allData.length,
        expectedSize: this.totalSize,
      });
    }

    // 写入缓存
    await streamCacheEngine.writeData(this.cacheKey, allData);

    // 验证缓存写入成功
    const entry = streamCacheEngine.getEntry(this.cacheKey);
    if (!entry || entry.totalSize !== allData.length) {
      debugLogger.error('streaming', 'setupBlobPlayback: cache write verification failed', {
        cacheTotalSize: entry?.totalSize,
        mergedSize: allData.length,
      });
    }

    // 获取播放URL：默认优先 blob URL（不受 WebView file:// 安全策略限制）
    // v18-fix: Android WebView 禁止 <audio> 加载 file:// 本地文件
    // v21.2-fix: size mismatch 时直接用内存数据构造 Blob，避免缓存按 totalSize 截断
    let newUrl: string;
    if (hasSizeMismatch) {
      const blob = new Blob([allData as unknown as BlobPart], { type: this.mimeType });
      newUrl = URL.createObjectURL(blob);
      debugLogger.info('streaming', 'Using memory blob (size mismatch)', {
        cacheKey: this.cacheKey,
        mergedSize: allData.length,
        expectedSize: this.totalSize,
      });
    } else {
      try {
        newUrl = await streamCacheEngine.readAsBlobUrl(this.cacheKey);
        debugLogger.info('streaming', 'Using blob URL for playback', {
          cacheKey: this.cacheKey,
        });
      } catch {
        try {
          // 回退到 file URL（仅当 blob 不可用）
          newUrl = await streamCacheEngine.readAsFileUrl(this.cacheKey);
          debugLogger.info('streaming', 'Using file URL for playback (blob fallback)', {
            cacheKey: this.cacheKey,
          });
        } catch {
          // 最终回退：用内存数据构造 Blob URL
          const blob = new Blob([allData as unknown as BlobPart], { type: this.mimeType });
          newUrl = URL.createObjectURL(blob);
          debugLogger.info('streaming', 'Using blob URL for playback (cache read unavailable)', {
            cacheKey: this.cacheKey,
          });
        }
      }
    }

    // 记录当前播放时间
    // v23-fix: seek 未回填时优先用 seek 目标位置恢复（否则刷新后回到旧位置 → 回弹）
    const currentTime = this.pendingSeekTime >= 0 ? this.pendingSeekTime : (this.audio?.currentTime ?? 0);
    const hadPendingSeek = this.pendingSeekTime >= 0;
    if (hadPendingSeek) {
      this.pendingSeekTime = -1;
    }

    // 释放旧 URL
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
    }
    this.blobUrl = newUrl;

    // 设置/刷新 audio
    if (!this.audio) {
      // 首块播放：等待audio就绪，避免竞态
      debugLogger.info('streaming', 'First chunk: waiting for audio ready');
      await this.setupAudioWithReadyWait(newUrl);
      debugLogger.info('streaming', 'First chunk: audio ready');
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
   * 设置 HTMLAudioElement（带就绪等待）
   * v14.5 修复：首块播放时等待 canplay/loadedmetadata 事件，避免 Blob/文件竞态
   */
  private setupAudioWithReadyWait(url: string): Promise<void> {
    return new Promise((resolve) => {
      if (this.audio) {
        this.audio.pause();
        this.audio.src = '';
      }

      this.audio = new Audio(url);
      this.audio.crossOrigin = 'anonymous';
      this.audioElementListener?.(this.audio);

      let resolved = false;
      const doResolve = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      // 就绪等待：canplay 或 loadedmetadata 触发即认为audio已准备好
      const onReady = () => {
        debugLogger.info('streaming', 'Audio ready event fired', {
          event: 'canplay/loadedmetadata',
          src: url.slice(0, 80),
        });
        doResolve();
      };
      this.audio.addEventListener('canplay', onReady, { once: true });
      this.audio.addEventListener('loadedmetadata', onReady, { once: true });

      // 超时兜底（3秒），避免无限卡住
      setTimeout(() => {
        if (!resolved) {
          debugLogger.warn('streaming', 'Audio ready wait timeout (3s), proceeding anyway', {
            src: url.slice(0, 80),
          });
          doResolve();
        }
      }, 3000);

      // 持久状态监听器
      this.audio.addEventListener('canplay', () => {
        if (this.state === 'loading' || this.state === 'buffering') {
          this.setState('playing');
        }
      });

      this.audio.addEventListener('ended', () => {
        this.setState('completed');
        this.callbacks.onEnded?.();
      });

      this.audio.addEventListener('error', (e) => {
        const errCode = this.audio?.error?.code;
        const errMsg = this.audio?.error?.message || String(e);
        debugLogger.error('streaming', 'Audio element error', {
          code: errCode,
          message: errMsg,
          src: url.slice(0, 80),
          state: this.state,
        });
        this.setState('error');
        this.callbacks.onError?.('音频播放失败');
        doResolve(); // 错误时也resolve，避免卡住
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

      this.audio.addEventListener('pause', () => {
        if (this.state === 'playing') {
          this.setState('paused');
        }
      });
    });
  }

  /**
   * 设置 HTMLAudioElement（不带就绪等待，用于刷新src时）
   */
  private setupAudio(url: string): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
    }

    this.audio = new Audio(url);
    this.audio.crossOrigin = 'anonymous';
    this.audioElementListener?.(this.audio);

    this.audio.addEventListener('canplay', () => {
      if (this.state === 'loading' || this.state === 'buffering') {
        this.setState('playing');
      }
    });

    this.audio.addEventListener('ended', () => {
      this.setState('completed');
      this.callbacks.onEnded?.();
    });

    this.audio.addEventListener('error', (e) => {
      const errCode = this.audio?.error?.code;
      const errMsg = this.audio?.error?.message || String(e);
      debugLogger.error('streaming', 'Audio element error (refresh path)', {
        code: errCode,
        message: errMsg,
        src: url.slice(0, 80),
      });
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

    this.audio.addEventListener('pause', () => {
      if (this.state === 'playing') {
        this.setState('paused');
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

        // v23-fix: seek 后首块数据到位 → 立即刷新 blob 并把播放位置回填到 seek 目标
        // （此前 pendingSeekTime 只记录不消费，导致 seek 不生效、进度条回弹）
        if (this.state === 'seeking' && this.pendingSeekTime >= 0) {
          debugLogger.info('streaming', 'Seek target data ready, applying pending seek', {
            pendingSeekTime: this.pendingSeekTime,
            chunkStart: chunk.start,
          });
          await this.setupBlobPlayback();
          if (this.pendingSeekTime >= 0) {
            // setupBlobPlayback 未消费时（缓存分支）兜底回填
            try {
              this.audio!.currentTime = this.pendingSeekTime;
            } catch {
              // ignore
            }
            this.pendingSeekTime = -1;
          }
          // 按 seek 前的播放态恢复
          if (this.seekResumePlay) {
            this.setState('playing');
            void this.audio?.play().catch(() => {
              // 自动播放策略可能阻止
            });
          } else {
            this.setState('paused');
          }
          return;
        }

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
        // v21.2 修复：增加按累计下载量触发刷新，不依赖播放进度条件
        if (!this.useMSE && chunk.index > 0) {
          const shouldRefreshByProgress =
            chunk.index % MIN_CHUNKS_BEFORE_REFRESH === 0 && this.shouldRefreshBlob();
          const shouldRefreshBySize =
            this.totalDownloaded - this.lastRefreshDownloaded >= BLOB_REFRESH_SIZE_THRESHOLD;

          if (shouldRefreshByProgress || shouldRefreshBySize) {
            await this.setupBlobPlayback();
            this.lastRefreshDownloaded = this.totalDownloaded;
          }
        }
      },

      onProgress: (progress) => {
        // 更新总大小（如果从响应中获取到）
        if (progress.overallTotalBytes > this.totalSize) {
          this.totalSize = progress.overallTotalBytes;
          // v21.2 修复：将预期总大小写入缓存元数据，供后续 isCacheComplete/playFromCache 校验
          if (this.cacheKey && this.totalSize > 0) {
            streamCacheEngine.setExpectedTotalSize(this.cacheKey, this.totalSize).catch(() => {
              // 静默忽略元数据写入失败，不影响播放
            });
          }
        }
      },

      onError: (error) => {
        this.setState('error');
        this.callbacks.onError?.(error.message);
      },

      onComplete: async () => {
        debugLogger.info('streaming', 'All chunks downloaded');
        if (this.useMSE && this.mediaSource?.readyState === 'open') {
          // MSE 模式下标记流结束
          try {
            this.mediaSource.endOfStream();
          } catch {
            // 忽略
          }
        } else if (!this.useMSE && this.chunks.length > 0) {
          // v21.2 修复：Blob 模式下所有 chunk 下载完成后重建完整 blob
          debugLogger.info('streaming', 'Blob mode: rebuilding blob from all chunks');
          await this.setupBlobPlayback();
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

    // v21.2 修复：如果有预期总大小，必须校验实际缓存大小是否匹配
    // 防止中断下载后 cacheEntry.totalSize 停留在中间值，导致误判为已缓存
    if (
      this.cacheEntry.expectedTotalSize &&
      this.cacheEntry.expectedTotalSize > 0 &&
      this.cacheEntry.totalSize < this.cacheEntry.expectedTotalSize
    ) {
      return false;
    }

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
