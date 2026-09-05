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
 * - v29: 会话/运行代际守卫（P1 播放核心链路修复）——
 *   ① session：每次 start() 递增。切歌/seek 重启下载 = 新会话，
 *      旧会话在途请求（Capacitor 原生 HTTP 无法真正取消，abort 只是置标志）
 *      完成后的错误与回调全部丢弃——此前旧循环的 AbortError 用「当前 state」
 *      归因，stop→start 后恰好落在新会话的 fetching 态上，把错误记到新歌头上
 *      （seek 无声 / 快速切歌误报播放失败的直接根因）；
 *   ② runId：每次 start()/resume()/seek() 递增，区分同会话内的下载循环，
 *      防止 pause→resume 后旧循环污染新循环；
 *   ③ 非 seek 重启的 start() 清零 totalSize——上一首遗留的 totalSize 会钳制
 *      新歌分块边界，并令播放端 totalDownloaded < totalSize 永远成立，
 *      ended 守卫误判 buffering → 播完卡死无法自动切下一首。
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

  // v29: 会话与运行代际（见文件头注释）
  private session = 0;
  private runId = 0;

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

    // v29: 新会话开始——使旧会话在途请求的全部结果作废
    const session = ++this.session;
    const runId = ++this.runId;

    // v29: 非 seek 重启（skipHead）时清零上一首遗留的 totalSize。
    // 旧值会钳制新歌的分块边界（chunk.end 提前截断），并令播放端
    // totalDownloaded < totalSize 永远成立 → ended 守卫误判 → 播完卡死
    if (!(options.skipHead && this.totalSize > 0)) {
      this.totalSize = 0;
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
      this.headPromise = this.probeHead(session);
    }

    this.state = 'fetching';
    debugLogger.info('streaming', 'StreamFetcher started', {
      url: url.slice(0, 80),
      startByte,
      totalSize: this.totalSize,
      headParallel: this.headPending,
      session,
      runId,
    });

    // 2. 立即开始分块下载（后台执行，不等 HEAD）
    void this.downloadLoop(session, runId);
  }

  /** v25: HEAD 预检（并行执行，失败静默——由响应学习 totalSize 兜底） */
  private async probeHead(session: number): Promise<void> {
    try {
      const headResp = await platformFetch(this.url, {
        method: 'HEAD',
        headers: this.headers,
        signal: AbortSignal.timeout(6000),
      });
      // v29: 会话已切换 → 旧 URL 的 HEAD 结果不得写入新会话（会污染 totalSize
      // 与 Range 边界，导致新歌分块错位/时长估算错误）
      if (session !== this.session) return;
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
      // v29: 仅当前会话才清除 headPending 标记（旧会话的 finally 不得影响新会话）
      if (session === this.session) {
        this.headPending = false;
      }
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
    // v29: 递增 runId 使在途请求结果作废，并重新拉起下载循环
    // （旧实现在 abort 后旧循环 break 退出、无人重启，fetcher 假死）
    const runId = ++this.runId;
    this.abortController?.abort();
    void this.downloadLoop(this.session, runId);
  }

  /**
   * 暂停下载
   */
  pause(): void {
    if (this.state === 'fetching') {
      this.state = 'paused';
      // v29: 作废在途请求结果
      this.runId++;
      this.abortController?.abort();
    }
  }

  /**
   * 恢复下载
   */
  async resume(): Promise<void> {
    if (this.state === 'paused') {
      this.state = 'fetching';
      const runId = ++this.runId;
      await this.downloadLoop(this.session, runId);
    }
  }

  /**
   * 停止下载
   */
  async stop(): Promise<void> {
    this.state = 'idle';
    // v29: 作废在途请求结果（旧循环/在途 chunk 的回调与错误全部丢弃）
    this.session++;
    this.runId++;
    this.abortController?.abort();
    this.seekTargetByte = -1;
    // 等待一小段时间让 abort 生效
    await new Promise((r) => setTimeout(r, 50));
  }

  // === 内部分块下载循环 ===

  private async downloadLoop(session: number, runId: number): Promise<void> {
    while (this.state === 'fetching' && session === this.session && runId === this.runId) {
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
        // v29: 等待 HEAD 期间会话/循环可能已切换（切歌/seek/暂停），
        // 旧循环必须立即退出，不得继续发请求
        if (session !== this.session || runId !== this.runId || this.state !== 'fetching') {
          return;
        }
      }

      // 计算当前块范围
      const chunk = this.calcChunk(this.currentChunkIndex, this.currentByteOffset);

      try {
        await this.downloadChunk(chunk, session, runId);
        // v29: chunk 下载期间被打断（seek/pause/切歌）→ 立即退出，
        // 不得推进偏移量，也不得触发完成判定
        if (session !== this.session || runId !== this.runId || this.state !== 'fetching') {
          return;
        }
        this.currentChunkIndex++;
        this.currentByteOffset = chunk.end + 1;

        // 检查是否已完成
        if (this.totalSize > 0 && this.currentByteOffset >= this.totalSize) {
          this.state = 'completed';
          this.callbacks.onComplete?.();
          break;
        }
      } catch (err) {
        // v29: 错误只允许归属「发起它的那个循环」——旧循环被 abort 后，其
        // 原生请求仍会跑完并补抛 AbortError，此时 state/runId 已是新循环的，
        // 旧判定（只看 state）会把错误记到新会话头上 → seek 无声 / 切歌误报
        if (
          session === this.session &&
          runId === this.runId &&
          this.state === 'fetching' &&
          this.seekTargetByte < 0
        ) {
          // 不是由 seek/暂停 导致的错误
          this.state = 'error';
          const error = err instanceof Error ? err : new Error(String(err));
          debugLogger.error('streaming', 'Download chunk failed', {
            chunk: chunk.index,
            error: error.message,
          });
          this.callbacks.onError?.(error);
        } else {
          debugLogger.info('streaming', 'Stale download loop error discarded', {
            chunk: chunk.index,
            staleSession: session !== this.session,
            staleRun: runId !== this.runId,
            state: this.state,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
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

  private async downloadChunk(chunk: ChunkInfo, session: number, runId: number): Promise<void> {
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

    // v29: 响应返回时会话/循环可能已被切换（原生 HTTP 无法真正取消在途请求），
    // 旧会话的数据一律丢弃，不得进入回调（防止跨歌数据写入新歌缓存 → 混音）
    if (session !== this.session || runId !== this.runId || this.state !== 'fetching') {
      debugLogger.info('streaming', 'Stale chunk response discarded', {
        chunk: chunk.index,
        staleSession: session !== this.session,
        staleRun: runId !== this.runId,
        state: this.state,
      });
      return;
    }

    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    // v29: body 读取期间同样可能被打断，读取完成后再校验一次
    if (session !== this.session || runId !== this.runId || this.state !== 'fetching') {
      debugLogger.info('streaming', 'Stale chunk body discarded', {
        chunk: chunk.index,
        staleSession: session !== this.session,
        staleRun: runId !== this.runId,
        state: this.state,
      });
      return;
    }
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
