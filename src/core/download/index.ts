import { Quality } from '@core/types';
import type { DownloadTask, DownloadStatus } from '@core/types';
import { sourceRegistry } from '@providers/music/registry';
import { deriveRawKey } from '@/utils/crypto/kuwoEkey';
import { qmc2DecryptBytes, isDecryptedMagic } from '@/utils/crypto/qmc2';

// 使用简单UUID生成（避免引入完整uuid库）
function generateId(): string {
  return 'dl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

export interface DownloadQueueItem extends DownloadTask {
  abortController?: AbortController;
  blob?: Blob;
  fileSize?: number;
  downloadedSize?: number;
  retryCount?: number;
  /** 歌曲标题（用于文件命名） */
  title?: string;
  /** 歌手名 */
  artist?: string;
}

export interface DownloadEngineOptions {
  maxConcurrent?: number;
  downloadDir?: string;
}

/**
 * 下载管理引擎
 * 功能：下载队列管理、多档音质下载、进度显示、暂停/恢复/取消
 *       支持写入本地文件系统（Capacitor Filesystem）
 *       支持酷我加密内容解密（mflac/mgg → flac/ogg）
 */
export class DownloadEngine {
  private queue: DownloadQueueItem[] = [];
  private activeDownloads = 0;
  private maxConcurrent: number;
  private listeners: Map<string, Array<(task: DownloadQueueItem) => void>> = new Map();

  constructor(options: DownloadEngineOptions = {}) {
    this.maxConcurrent = options.maxConcurrent || 3;
  }

  // 事件监听
  on(event: 'progress' | 'complete' | 'error' | 'statusChange', callback: (task: DownloadQueueItem) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);

    return () => {
      const list = this.listeners.get(event);
      if (list) {
        this.listeners.set(event, list.filter((cb) => cb !== callback));
      }
    };
  }

  private emit(event: 'progress' | 'complete' | 'error' | 'statusChange', task: DownloadQueueItem) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach((cb) => cb(task));
  }

  /**
   * 添加下载任务
   */
  async addDownload(
    songId: string,
    sourceId: string,
    quality: Quality,
    metadata?: { title?: string; artist?: string; album?: string }
  ): Promise<DownloadQueueItem> {
    const task: DownloadQueueItem = {
      id: generateId(),
      songId,
      sourceId,
      quality,
      status: 'pending',
      progress: 0,
      speed: 0,
      isFallback: false,
      title: metadata?.title,
      artist: metadata?.artist,
    };

    this.queue.push(task);
    this.processQueue();

    return task;
  }

  /**
   * 批量添加下载任务
   */
  async addBatchDownloads(
    items: Array<{ songId: string; sourceId: string; quality: Quality; metadata?: { title?: string; artist?: string } }>
  ): Promise<DownloadQueueItem[]> {
    const tasks = items.map((item) => ({
      id: generateId(),
      songId: item.songId,
      sourceId: item.sourceId,
      quality: item.quality,
      status: 'pending' as DownloadStatus,
      progress: 0,
      speed: 0,
      isFallback: false,
      title: item.metadata?.title,
      artist: item.metadata?.artist,
    }));

    this.queue.push(...tasks);
    this.processQueue();

    return tasks;
  }

  /**
   * 处理下载队列
   */
  private async processQueue(): Promise<void> {
    if (this.activeDownloads >= this.maxConcurrent) return;

    const pendingTask = this.queue.find((t) => t.status === 'pending');
    if (!pendingTask) return;

    this.activeDownloads++;
    pendingTask.status = 'downloading';
    pendingTask.abortController = new AbortController();
    this.emit('statusChange', pendingTask);

    try {
      await this.executeDownload(pendingTask);
    } finally {
      this.activeDownloads--;
      this.processQueue();
    }
  }

  /**
   * 执行单个下载
   */
  private async executeDownload(task: DownloadQueueItem): Promise<void> {
    const startTime = Date.now();
    let lastUpdateTime = startTime;
    let lastDownloaded = 0;

    try {
      const source = sourceRegistry.get(task.sourceId);
      if (!source) {
        throw new Error(`Source ${task.sourceId} not found`);
      }

      // 获取播放URL（下载链接）
      let playUrl;
      try {
        playUrl = await source.getPlayUrl(task.songId, task.quality);
      } catch {
        // 尝试酷我兜底
        const kuwo = sourceRegistry.get('kuwo');
        if (kuwo && task.sourceId !== 'kuwo') {
          playUrl = await kuwo.getPlayUrl(task.songId, task.quality);
          task.isFallback = true;
        } else {
          throw new Error('无法获取下载链接');
        }
      }

      if (!playUrl?.url) {
        throw new Error('下载链接为空');
      }

      // 开始下载
      const { platformFetch } = await import('@shared/utils/platformFetch');
      const response = await platformFetch(playUrl.url, {
        signal: task.abortController?.signal,
        headers: playUrl.headers,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
      task.fileSize = contentLength;

      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let downloaded = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        downloaded += value.length;

        // 更新进度
        task.progress = contentLength > 0 ? downloaded / contentLength : 0;
        task.downloadedSize = downloaded;

        // 计算速度
        const now = Date.now();
        if (now - lastUpdateTime >= 1000) {
          task.speed = Math.round(((downloaded - lastDownloaded) / (now - lastUpdateTime)) * 1000);
          lastUpdateTime = now;
          lastDownloaded = downloaded;
        }

        this.emit('progress', task);
      }

      // 合并chunks为Blob
      let blob = new Blob(chunks as BlobPart[]);
      task.blob = blob;
      task.progress = 1;
      task.speed = 0;

      // 酷我加密内容解密（mflac/mgg → flac/ogg）
      if (playUrl.ekey) {
        try {
          const rawKey = deriveRawKey(playUrl.ekey);
          if (rawKey) {
            const encrypted = new Uint8Array(await blob.arrayBuffer());
            const decrypted = qmc2DecryptBytes(encrypted, rawKey);
            if (isDecryptedMagic(decrypted)) {
              blob = new Blob([decrypted.buffer as ArrayBuffer]);
              task.blob = blob;
              // 解密成功，修正格式后缀
              if (playUrl.format === 'mflac') playUrl.format = 'flac';
              if (playUrl.format === 'mgg') playUrl.format = 'ogg';
            } else {
              console.warn('酷我解密后魔数校验失败，保留原始加密文件');
            }
          } else {
            console.warn('酷我 ekey 派生密钥失败，保留原始加密文件');
          }
        } catch (decryptErr) {
          console.warn('酷我解密异常，保留原始加密文件:', decryptErr);
        }
      }

      // 保存到本地文件系统
      const localPath = await this.saveToLocalFile(task, blob, playUrl);
      task.localPath = localPath;
      task.status = 'completed';

      this.emit('complete', task);
      this.emit('statusChange', task);
    } catch (err) {
      const message = err instanceof Error ? err.message : '下载失败';
      task.status = 'failed';
      task.errorMessage = message;
      task.speed = 0;

      this.emit('error', task);
      this.emit('statusChange', task);
    }
  }

  /**
   * 保存下载文件到本地存储
   */
  private async saveToLocalFile(
    task: DownloadQueueItem,
    blob: Blob,
    playUrl: any
  ): Promise<string | undefined> {
    try {
      // 检测平台
      const isCapacitor = typeof (window as any)?.Capacitor !== 'undefined';
      if (!isCapacitor) {
        // Web环境：触发浏览器下载
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = this.buildFileName(task, playUrl.format);
        a.click();
        URL.revokeObjectURL(url);
        return undefined;
      }

      // Capacitor环境：写入外部存储
      const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');

      // 构建文件名和路径
      const ext = playUrl.format || 'mp3';
      const fileName = this.buildFileName(task, ext);
      const subDir = 'YinliuDownloads';

      // 确保目录存在
      try {
        await Filesystem.mkdir({
          path: subDir,
          directory: Directory.ExternalStorage,
          recursive: true,
        });
      } catch {
        // 目录可能已存在
      }

      // 读取blob为base64
      const arrayBuffer = await blob.arrayBuffer();
      const base64 = this.arrayBufferToBase64(arrayBuffer);

      // 写入文件
      const filePath = `${subDir}/${fileName}`;
      await Filesystem.writeFile({
        path: filePath,
        data: base64,
        directory: Directory.ExternalStorage,
        recursive: true,
      });

      // 获取文件URI
      const stat = await Filesystem.stat({
        path: filePath,
        directory: Directory.ExternalStorage,
      });

      return stat.uri || filePath;
    } catch (err) {
      console.warn('保存文件失败:', err);
      return undefined;
    }
  }

  /**
   * 构建文件名
   */
  private buildFileName(task: DownloadQueueItem, ext: string): string {
    const safe = (s?: string) => (s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'unknown';
    const title = safe(task.title);
    const artist = safe(task.artist);
    const qualityLabel = this.qualityLabel(task.quality);
    const name = artist && artist !== 'unknown'
      ? `${artist} - ${title}`
      : title;
    return `${name} [${qualityLabel}].${ext}`;
  }

  private qualityLabel(q: Quality): string {
    switch (q) {
      case Quality.LOW: return '48k';
      case Quality.STANDARD: return '128k';
      case Quality.HIGH: return '320k';
      case Quality.LOSSLESS: return 'FLAC';
      case Quality.HIFI: return 'HiFi';
      case Quality.HIRES: return 'Hi-Res';
      default: return 'audio';
    }
  }

  /**
   * ArrayBuffer 转 Base64
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * 暂停下载
   */
  pauseDownload(taskId: string): DownloadQueueItem | null {
    const task = this.queue.find((t) => t.id === taskId);
    if (!task || task.status !== 'downloading') return null;

    task.abortController?.abort();
    task.status = 'paused';
    task.speed = 0;

    this.emit('statusChange', task);
    return task;
  }

  /**
   * 恢复下载
   */
  resumeDownload(taskId: string): DownloadQueueItem | null {
    const task = this.queue.find((t) => t.id === taskId);
    if (!task || task.status !== 'paused') return null;

    task.status = 'pending';
    task.errorMessage = undefined;
    this.emit('statusChange', task);

    this.processQueue();
    return task;
  }

  /**
   * 取消下载
   */
  cancelDownload(taskId: string): boolean {
    const index = this.queue.findIndex((t) => t.id === taskId);
    if (index === -1) return false;

    const task = this.queue[index];

    if (task.status === 'downloading') {
      task.abortController?.abort();
    }

    this.queue.splice(index, 1);
    return true;
  }

  /**
   * 重试下载
   */
  retryDownload(taskId: string): DownloadQueueItem | null {
    const task = this.queue.find((t) => t.id === taskId);
    if (!task || task.status !== 'failed') return null;

    task.status = 'pending';
    task.progress = 0;
    task.errorMessage = undefined;
    task.retryCount = (task.retryCount || 0) + 1;

    this.emit('statusChange', task);
    this.processQueue();
    return task;
  }

  /**
   * 获取所有下载任务
   */
  getAllTasks(): DownloadQueueItem[] {
    return [...this.queue];
  }

  /**
   * 获取指定状态的任务
   */
  getTasksByStatus(status: DownloadStatus): DownloadQueueItem[] {
    return this.queue.filter((t) => t.status === status);
  }

  /**
   * 获取任务统计
   */
  getStats(): {
    total: number;
    pending: number;
    downloading: number;
    paused: number;
    completed: number;
    failed: number;
  } {
    return {
      total: this.queue.length,
      pending: this.queue.filter((t) => t.status === 'pending').length,
      downloading: this.queue.filter((t) => t.status === 'downloading').length,
      paused: this.queue.filter((t) => t.status === 'paused').length,
      completed: this.queue.filter((t) => t.status === 'completed').length,
      failed: this.queue.filter((t) => t.status === 'failed').length,
    };
  }

  /**
   * 清空已完成任务
   */
  clearCompleted(): void {
    this.queue = this.queue.filter((t) => t.status !== 'completed');
  }

  /**
   * 清空失败任务
   */
  clearFailed(): void {
    this.queue = this.queue.filter((t) => t.status !== 'failed');
  }
}

export const downloadEngine = new DownloadEngine();
