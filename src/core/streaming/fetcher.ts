/**
 * 流式分块下载器
 * v14.4: 使用 Range 请求分块拉取音频数据
 *
 * 特性：
 * - 首块 256KB 快速起播
 * - 后续块 512KB 持续缓冲
 * - 支持 seek：从任意字节位置开始下载
 * - 支持取消/暂停
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

    // 1. 先获取文件总大小（HEAD 请求）
    if (!(options.skipHead && this.totalSize > 0)) {
      try {
        // v24: HEAD 加超时兜底（此前无 signal 无超时，CDN 挂起时整条起播链路被卡死，
        // 表现为"加载好久"+ 播放按钮一直转圈）。超时后按无 totalSize 继续走分块下载。
        const headResp = await platformFetch(url, {
          method: 'HEAD',
          headers,
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
            url: url.slice(0, 80),
          });
        }
      } catch (err) {
        debugLogger.warn('streaming', 'HEAD request failed, proceeding without total size', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.state = 'fetching';
    debugLogger.info('streaming', 'StreamFetcher started', {
      url: url.slice(0, 80),
      startByte,
      totalSize: this.totalSize,
    });

    // 2. 开始分块下载（后台执行，不阻塞）
    void this.downloadLoop();
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

