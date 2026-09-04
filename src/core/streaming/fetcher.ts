/**
 * 流式分块下载器
 * v14.4: 使用 Range 请求分块拉取音频数据
 *
 * 特性：
 * - 首块 256KB 快速起播
 * - 后续块 512KB 持续缓冲
 * - 支持 seek：从任意字节位置开始下载
 * - 支持取消/暂停
 * - v25: HEAD 预检与首块下载并行（此前 start() 串行 await HEAD——CDN 慢/挂起时
 *   最多阻塞 6s 才开始下载首块，是"点击播放后十几秒才有声音"的主因。
 *   首块下载本身不需要 totalSize，HEAD 只服务于后续块的边界钳制）；
 *   同时从首个响应学习 totalSize（206 短返回 = 尾块 / 200 = 全量），
 *   HEAD 失败或未返回时下载不再失速。
 */

import { platformFetch } from '@shared/utils/platformFetch';
import { debugLogger } from '@shared/utils/debugLogger';

export interface ChunkInfo {
  index: number;
  start: number;
  end: number;
  size: number;
}

export interface FetchProgress {
  chunkIndex: number;
  bytesReceived: number;
  chunkTotal: number;
  overallBytesReceived: number;
  overallTotalBytes: number;
}

export type FetcherState = 'idle' | 'fetching' | 'paused' | 'completed' | 'error';

export interface FetcherCallbacks {
  onChunkStart?: (chunk: ChunkInfo) => void;
  onChunkData?: (chunk: ChunkInfo, data: Uint8Array, offsetInChunk: number) => void;
  onChunkComplete?: (chunk: ChunkInfo, data: Uint8Array) => void;
  onProgress?: (progress: FetchProgress) => void;
  onError?: (error: Error) => void;
  onComplete?: () => void;
}

const FIRST_CHUNK_SIZE = 256 * 1024; // 256KB 首块
const CHUNK_SIZE = 512 * 1024; // 512KB 常规块

export class StreamFetcher {
  private url: string = '';
  private headers: Record<string, string> = {};
  private totalSize: number = 0;
  private state: FetcherState = 'idle';
  private abortController: AbortController | null = null;
  private currentChunkIndex = 0;
  private currentByteOffset = 0;
  private overallReceived = 0;
  private callbacks: FetcherCallbacks = {};

  // v25: 并行 HEAD 预检 —— start() 不再串行等待，downloadLoop 在需要 totalSize
  // （首块之后的边界钳制）时才 await 该 Promise
  private headPromise: Promise<void> | null = null;
  // v25: 本轮 start() 是否真正需要 HEAD（skipHead 或 totalSize 已知时为 false）
  private headPending = false;

  // seek 目标（用于中断后重新定位）
  private seekTargetByte = -1;

  setCallbacks(callbacks: FetcherCallbacks): void {
    this.callbacks = callbacks;
  }

  getState(): FetcherState {
    return this.state;
  }

  getTotalSize(): number {
    return this.totalSize;
  }

  /**
   * 启动流式下载（非阻塞，后台执行）
   * @param url 音频文件 URL
   * @param headers 请求头（可能包含鉴权信息）
   * @param startByte 起始字节位置（默认 0）
   * @param options.skipHead 已知 totalSize 时跳过 HEAD 预检（seek 重启下载时省一次往返）
   */
  async start(
    url: string,
    headers: Record<string, string> = {},
    startByte = 0,
    options: { skipHead?: boolean } = {}
  ): Promise<void> {
    if (this.state === 'fetching') {
      await this.stop();
    }

    this.url = url;
    this.headers = headers;
    this.currentByteOffset = startByte;
    this.currentChunkIndex = 0;
    this.overallReceived = 0;
    this.seekTargetByte = -1;

    // 1. v25: HEAD 预检改为与下载并行发射。它只为后续块提供 totalSize 钳制，
    //    首块（start..start+256KB）无需 totalSize 即可请求。
    //    - 已知 totalSize（seek 的 skipHead）→ 不再发 HEAD；
    //    - HEAD 失败/超时（6s）→ 按无 totalSize 继续（与旧版失败路径一致），
    //      并由 downloadChunk 从响应学习 totalSize 兜底。
    this.headPromise = null;
    this.headPending = false;
    if (!(options.skipHead && this.totalSize > 0)) {
      this.headPending = true;
      this.headPromise = this.probeHead();
    }

    this.state = 'fetching';
    debugLogger.info('streaming', 'StreamFetcher started', {
      url: url.slice(0, 80),
      startByte,
      totalSize: this.totalSize,
      headParallel: this.headPending,
    });

    // 2. 立即开始分块下载（后台执行，不等 HEAD）
    void this.downloadLoop();
  }

  /** v25: HEAD 预检（并行执行，失败静默——由响应学习 totalSize 兜底） */
  private async probeHead(): Promise<void> {
    try {
      const headResp = await platformFetch(this.url, {
        method: 'HEAD',
        headers: this.headers,
        signal: AbortSignal.timeout(6000),
      });
      const contentLength = headResp.headers.get('content-length');
      if (contentLength) {
        this.totalSize = parseInt(contentLength, 10);
      }
      // 检查是否支持 Range
      const acceptRanges = headResp.headers.get('accept-ranges');
      if (acceptRanges !== 'bytes') {
        debugLogger.warn('streaming', 'Server may not support Range requests', {
          acceptRanges,
          url: this.url.slice(0, 80),
        });
      }
    } catch (err) {
      debugLogger.warn('streaming', 'HEAD request failed, proceeding without total size', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.headPending = false;
    }
  }

  /** 当前下载的 URL（seek 重启下载时复用） */
  getUrl(): string {
    return this.url;
  }

  /** 当前下载的请求头（seek 重启下载时复用） */
  getHeaders(): Record<string, string> {
    return this.headers;
  }

  /**
   * Seek 到指定字节位置
   * 会中断当前下载，从新的位置重新开始
   */
  async seek(bytePosition: number): Promise<void> {
    if (this.state !== 'fetching') return;

    debugLogger.info('streaming', 'StreamFetcher seek', {
      from: this.currentByteOffset,
      to: bytePosition,
    });

    this.seekTargetByte = bytePosition;
    this.abortController?.abort();
  }

  /**
   * 暂停下载
   */
  pause(): void {
    if (this.state === 'fetching') {
      this.state = 'paused';
      this.abortController?.abort();
    }
  }

  /**
   * 恢复下载
   */
  async resume(): Promise<void> {
    if (this.state === 'paused') {
      this.state = 'fetching';
      await this.downloadLoop();
    }
  }

  /**
   * 停止下载
   */
  async stop(): Promise<void> {
    this.state = 'idle';
    this.abortController?.abort();
    // 等待一小段时间让 abort 生效
    await new Promise((r) => setTimeout(r, 50));
  }

  // === 内部分块下载循环 ===

  private async downloadLoop(): Promise<void> {
    while (this.state === 'fetching') {
      // 检查是否有 seek 请求
      if (this.seekTargetByte >= 0) {
        this.currentByteOffset = this.seekTargetByte;
        this.seekTargetByte = -1;
        // 重新计算 chunk index
        if (this.currentByteOffset < FIRST_CHUNK_SIZE) {
          this.currentChunkIndex = 0;
        } else {
          this.currentChunkIndex = 1 + Math.floor((this.currentByteOffset - FIRST_CHUNK_SIZE) / CHUNK_SIZE);
        }
      }

      // v25: 首块之后的块需要 totalSize 做边界钳制（避免请求越过 EOF 得到 416）。
      // 此时并行 HEAD 大概率已完成（首块 256KB 下载耗时 ≥ HEAD 往返）；
      // 若 HEAD 仍未返回（极慢 CDN），在此等待——仅影响第二块之后的节奏，不阻塞起播。
      if (this.headPending && this.currentChunkIndex > 0) {
        await this.headPromise;
      }

      // 计算当前块范围
      const chunk = this.calcChunk(this.currentChunkIndex, this.currentByteOffset);

      try {
        await this.downloadChunk(chunk);
        this.currentChunkIndex++;
        this.currentByteOffset = chunk.end + 1;

        // 检查是否已完成
        if (this.totalSize > 0 && this.currentByteOffset >= this.totalSize) {
          this.state = 'completed';
          this.callbacks.onComplete?.();
          break;
        }
      } catch (err) {
        if (this.state === 'fetching' && this.seekTargetByte < 0) {
          // 不是由 seek/暂停 导致的错误
          this.state = 'error';
          const error = err instanceof Error ? err : new Error(String(err));
          debugLogger.error('streaming', 'Download chunk failed', {
            chunk: chunk.index,
            error: error.message,
          });
          this.callbacks.onError?.(error);
        }
        break;
      }
    }
  }

  private calcChunk(index: number, preferredStart = -1): ChunkInfo {
    let start: number;
    let size: number;

    if (index === 0) {
      start = preferredStart >= 0 ? preferredStart : 0;
      size = FIRST_CHUNK_SIZE;
    } else {
      start = preferredStart >= 0 ? preferredStart : FIRST_CHUNK_SIZE + (index - 1) * CHUNK_SIZE;
      size = CHUNK_SIZE;
    }

    let end = start + size - 1;
    if (this.totalSize > 0) {
      end = Math.min(end, this.totalSize - 1);
    }

    return {
      index,
      start,
      end,
      size: end - start + 1,
    };
  }

  private async downloadChunk(chunk: ChunkInfo): Promise<void> {
    this.abortController = new AbortController();

    const rangeHeader = `bytes=${chunk.start}-${chunk.end}`;
    debugLogger.info('streaming', `Downloading chunk ${chunk.index}: ${rangeHeader}`);

    this.callbacks.onChunkStart?.(chunk);

    const response = await platformFetch(this.url, {
      method: 'GET',
      headers: {
        ...this.headers,
        Range: rangeHeader,
      },
      signal: this.abortController.signal,
      responseType: 'arraybuffer',
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);

    // v25: 从响应学习 totalSize（HEAD 失败 / CDN 不返回 content-length 时兜底）
    // - 206 且返回字节数 < 请求范围 → 已到文件尾
    // - 200 → 服务器不支持 Range，返回的是完整文件
    if (response.status === 206 && data.length < chunk.size) {
      this.totalSize = chunk.start + data.length;
      debugLogger.info('streaming', 'Learned totalSize from short 206 response (tail)', {
        totalSize: this.totalSize,
      });
    } else if (response.status === 200 && this.totalSize === 0) {
      this.totalSize = chunk.start + data.length;
      debugLogger.info('streaming', 'Learned totalSize from full 200 response', {
        totalSize: this.totalSize,
      });
    }

    // 如果服务器不支持 Range，可能返回完整内容
    // 此时需要截取我们需要的部分
    let effectiveData = data;
    if (response.status === 200 && data.length > chunk.size) {
      // 服务器返回了完整文件，截取对应部分
      effectiveData = data.subarray(chunk.start, chunk.end + 1);
    }

    this.overallReceived += effectiveData.length;

    this.callbacks.onChunkComplete?.(chunk, effectiveData);
    this.callbacks.onProgress?.({
      chunkIndex: chunk.index,
      bytesReceived: effectiveData.length,
      chunkTotal: chunk.size,
      overallBytesReceived: this.overallReceived,
      overallTotalBytes: this.totalSize,
    });
  }
}

export const streamFetcher = new StreamFetcher();
