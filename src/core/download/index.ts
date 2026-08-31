import type { Quality, DownloadStatus, DownloadTask } from '@core/types';
import { sourceRegistry } from '@providers/music/registry';
import { platformFetch } from '@shared/utils/platformFetch';
import { getSqliteDb, flushDatabase } from '@shared/database';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { buildFallbackChain, PLATFORM_DISPLAY_NAMES } from '@core/platformPriority';
import { toast } from '@shared/components/Toast';
import { debugLogger } from '@shared/utils/debugLogger';

function qmc2DecryptBytes(data: Uint8Array): Uint8Array {
  // Kuwo QMC2 格式解密；若全局未注册解密器则透传
  const gw = globalThis as unknown as Record<string, unknown>;
  if (typeof gw.qmc2DecryptBytes === 'function') {
    return (gw.qmc2DecryptBytes as (d: Uint8Array) => Uint8Array)(data);
  }
  return data;
}

export interface DownloadProgressEvent {
  taskId: string;
  progress: number;
  downloadedSize: number;
  totalSize: number;
  speed: number;
}

/**
 * 单个 source 下的取链结果。
 * 用于下载引擎内部把「取链」与「下载文件」解耦，方便在多个 source 之间降级。
 */
interface ResolvedSourceUrl {
  sourceId: string;
  songId: string;
  url: string;
  format: string;
  headers?: Record<string, string>;
}

export class DownloadEngine {
  private tasks = new Map<string, DownloadTask>();
  private abortControllers = new Map<string, AbortController>();
  private listeners: Record<string, Array<(data: unknown) => void>> = {};
  /** 任务元数据：除 DownloadTask 之外，记住每条任务的可用源/降级链（仅内存，DB 不持久化） */
  private taskMeta = new Map<string, { availableSources?: Array<{ sourceId: string; sourceSongId: string }>; title?: string; artist?: string }>();

  private emit(event: string, data: unknown) {
    const callbacks = this.listeners[event] || [];
    callbacks.forEach((cb) => cb(data));
  }

  on(event: string, callback: (data: any) => void): () => void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
    return () => {
      this.listeners[event] = this.listeners[event].filter((cb) => cb !== callback);
    };
  }

  // === 从数据库恢复下载任务 ===
  async restoreTasks(): Promise<void> {
    try {
      const sqliteDb = getSqliteDb();
      const stmt = sqliteDb.prepare('SELECT * FROM downloads ORDER BY created_at DESC');
      while (stmt.step()) {
        const row = stmt.getAsObject() as Record<string, unknown>;
        const task: DownloadTask = {
          id: String(row.id),
          songId: String(row.song_id),
          sourceId: String(row.source_id || ''),
          quality: String(row.quality || 'standard') as Quality,
          url: row.url ? String(row.url) : undefined,
          filePath: row.local_path ? String(row.local_path) : undefined,
          status: String(row.status || 'pending') as DownloadStatus,
          progress: Number(row.progress || 0),
          totalSize: Number(row.file_size || 0),
          errorMessage: row.error_message ? String(row.error_message) : undefined,
          createdAt: Number(row.created_at || Date.now()),
        };
        this.tasks.set(task.id, task);
        // 旧任务没有 availableSources 元数据 → 视为单平台，无降级
      }
      stmt.free();
    } catch (err) {
      console.error('[DownloadEngine] restoreTasks failed:', err);
    }
  }

  getTasks(): DownloadTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  getTask(id: string): DownloadTask | undefined {
    return this.tasks.get(id);
  }

  // === 创建下载任务 ===
  async createTask(params: {
    songId: string;
    sourceId: string;
    quality: Quality;
    title: string;
    artist?: string;
    /** v13: 聚合搜索结果中的可用源列表（用于下载取链降级） */
    availableSources?: Array<{ sourceId: string; sourceSongId: string }>;
  }): Promise<DownloadTask> {
    const id = `dl_${params.sourceId}_${params.songId}_${params.quality}_${Date.now()}`;
    const task: DownloadTask = {
      id,
      songId: params.songId,
      sourceId: params.sourceId,
      quality: params.quality,
      status: 'pending',
      progress: 0,
      totalSize: 0,
      createdAt: Date.now(),
    };

    // 去重：同一 source+song+quality 如果已在 pending/downloading 状态，直接返回
    const existing = this.getTasks().find(
      (t) => t.songId === params.songId && t.sourceId === params.sourceId && t.quality === params.quality
        && (t.status === 'pending' || t.status === 'downloading')
    );
    if (existing) {
      // 即使命中已有任务，也补一份元数据（避免旧任务元数据不全）
      if (params.availableSources && params.availableSources.length > 0) {
        const meta = this.taskMeta.get(existing.id) || {};
        meta.availableSources = params.availableSources;
        meta.title = params.title || meta.title;
        meta.artist = params.artist || meta.artist;
        this.taskMeta.set(existing.id, meta);
      }
      debugLogger.info('download', `下载任务已存在: ${params.title}`, {
        taskId: existing.id,
        sourceId: params.sourceId,
        quality: params.quality,
      });
      return existing;
    }

    this.tasks.set(id, task);
    if (params.availableSources && params.availableSources.length > 0) {
      this.taskMeta.set(id, {
        availableSources: params.availableSources,
        title: params.title,
        artist: params.artist,
      });
    }
    await this.persistTask(task);
    debugLogger.info('download', `创建下载任务: ${params.title}`, {
      taskId: id,
      sourceId: params.sourceId,
      quality: params.quality,
    });
    return task;
  }

  // === 启动下载（pending → downloading）===
  async startDownload(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status === 'completed') return;
    if (task.status === 'downloading') return;

    task.status = 'downloading';
    task.errorMessage = undefined;
    await this.persistTask(task);
    this.emit('stateChange', { taskId, status: 'downloading', task });

    const meta = this.taskMeta.get(taskId);
    const title = meta?.title || task.songId;

    debugLogger.info('download', `开始下载: ${title}`, {
      taskId,
      sourceId: task.sourceId,
      quality: task.quality,
    });

    try {
      // 1. 取链（v13: 多平台降级链）
      const availableIds = (meta?.availableSources || []).map((s) => s.sourceId);
      const songIdMap = new Map<string, string>();
      for (const s of meta?.availableSources || []) {
        songIdMap.set(s.sourceId, s.sourceSongId);
      }
      // 兜底：主 songId 在主源下
      songIdMap.set(task.sourceId, task.songId);

      const chain = buildFallbackChain(task.sourceId, availableIds);

      let resolved: ResolvedSourceUrl | null = null;
      let lastError: unknown = null;

      for (let i = 0; i < chain.length; i++) {
        const trySourceId = chain[i];
        const source = sourceRegistry.get(trySourceId);
        if (!source || !source.enabled) continue;
        const trySongId = songIdMap.get(trySourceId) || task.songId;

        try {
          const playUrl = await source.getPlayUrl(trySongId, task.quality);
          if (i > 0) {
            // 有降级：提示用户
            const fromName = PLATFORM_DISPLAY_NAMES[chain[i - 1]] || chain[i - 1];
            const toName = PLATFORM_DISPLAY_NAMES[trySourceId] || trySourceId;
            const reason = lastError instanceof Error ? lastError.message : '不可用';
            console.warn(
              `[DownloadEngine] Link fallback: ${chain[i - 1]} → ${trySourceId} (${reason})`
            );
            toast.info(
              `下载已切换到 ${toName}`,
              `${fromName} 取链失败（${reason}），已自动降级到 ${toName}`
            );
            debugLogger.warn('download', `下载取链降级: ${fromName} → ${toName}`, {
              taskId,
              from: chain[i - 1],
              to: trySourceId,
              reason,
            });
          }
          resolved = {
            sourceId: trySourceId,
            songId: trySongId,
            url: playUrl.url,
            format: playUrl.format,
            headers: playUrl.headers,
          };
          // 把实际取到的源回写到 task（便于后续断点续传知道该找哪个源）
          task.sourceId = trySourceId;
          task.songId = trySongId;
          task.url = playUrl.url;
          break;
        } catch (err) {
          lastError = err;
          console.warn(
            `[DownloadEngine] getPlayUrl failed on ${trySourceId}:`,
            err instanceof Error ? err.message : err
          );
          debugLogger.warn('download', `下载取链失败: ${trySourceId}`, {
            taskId,
            error: err instanceof Error ? err.message : String(err),
          });
          // 继续降级
        }
      }

      if (!resolved) {
        throw new Error(
          `All ${chain.length} sources failed for download: ${
            lastError instanceof Error ? lastError.message : 'unknown'
          }`
        );

      }

      // 2. 确保下载目录存在
      const dir = 'yinliu/downloads';
      try {
        await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true });
      } catch {
        // 目录可能已存在
      }

      // 3. 构建文件路径
      const ext = resolved.format || 'mp3';
      const fileName = `${resolved.sourceId}_${resolved.songId}_${task.quality}.${ext}`;
      const filePath = `${dir}/${fileName}`;
      task.filePath = filePath;

      // 4. 发起二进制下载
      const abortCtrl = new AbortController();
      this.abortControllers.set(taskId, abortCtrl);

      const response = await platformFetch(resolved.url, {
        method: 'GET',
        signal: abortCtrl.signal,
        headers: resolved.headers || {},
        responseType: 'arraybuffer',
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentLength = Number(response.headers.get('content-length') || '0');
      task.totalSize = contentLength;

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }

      // 5. 流式读取并写入文件
      const chunks: Uint8Array[] = [];
      let downloaded = 0;
      let lastTime = Date.now();
      let lastDownloaded = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // 检查是否被暂停/取消
        if (task.status !== 'downloading') {
          reader.cancel();
          break;
        }

        chunks.push(value);
        downloaded += value.length;
        task.progress = task.totalSize > 0 ? downloaded / task.totalSize : 0;

        // 计算速度 (bytes/s)
        const now = Date.now();
        const dt = now - lastTime;
        if (dt >= 500) {
          const speed = Math.round(((downloaded - lastDownloaded) / dt) * 1000);
          lastTime = now;
          lastDownloaded = downloaded;
          this.emit('progress', {
            taskId,
            progress: task.progress,
            downloadedSize: downloaded,
            totalSize: task.totalSize,
            speed,
          });
        }
      }

      // 6. 合并 chunks 并写入本地文件
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const merged = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }

      // QMC2 解密（Kuwo 源）
      const decrypted = task.sourceId === 'kuwo' ? qmc2DecryptBytes(merged) : merged;

      // 转为 base64 写入 Capacitor Filesystem（32KB 分块避免大文件栈溢出）
      function arrayBufferToBase64(buffer: Uint8Array): string {
        const chunkSize = 32768;
        let binary = '';
        for (let i = 0; i < buffer.length; i += chunkSize) {
          const chunk = buffer.subarray(i, i + chunkSize);
          binary += String.fromCharCode(...chunk);
        }
        return btoa(binary);
      }
      const base64 = arrayBufferToBase64(decrypted);
      await Filesystem.writeFile({
        path: filePath,
        data: base64,
        directory: Directory.Data,
        recursive: true,
      });

      // 7. 标记完成
      task.status = 'completed';
      task.progress = 1;
      await this.persistTask(task);
      this.emit('stateChange', { taskId, status: 'completed', task });
      this.emit('completed', { taskId, filePath });
      debugLogger.info('download', `下载完成: ${title}`, {
        taskId,
        filePath,
        size: totalLength,
      });

      this.abortControllers.delete(taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      task.status = 'failed';
      task.errorMessage = msg;
      await this.persistTask(task);
      this.emit('stateChange', { taskId, status: 'failed', task });
      this.emit('failed', { taskId, error: msg });
      debugLogger.error('download', `下载失败: ${title}`, {
        taskId,
        error: msg,
      });
      this.abortControllers.delete(taskId);
    }
  }

  // === 暂停下载（downloading → paused）===
  async pauseDownload(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'downloading') return;

    const ctrl = this.abortControllers.get(taskId);
    if (ctrl) {
      ctrl.abort();
      this.abortControllers.delete(taskId);
    }

    task.status = 'paused';
    await this.persistTask(task);
    this.emit('stateChange', { taskId, status: 'paused', task });
    debugLogger.info('download', `下载暂停: ${this.taskMeta.get(taskId)?.title || taskId}`, {
      taskId,
    });
  }

  // === 继续下载（paused → downloading）===
  async resumeDownload(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'paused') return;
    debugLogger.info('download', `下载恢复: ${this.taskMeta.get(taskId)?.title || taskId}`, {
      taskId,
    });
    await this.startDownload(taskId);
  }

  // === 取消/删除任务 ===
  async cancelDownload(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    const ctrl = this.abortControllers.get(taskId);
    if (ctrl) {
      ctrl.abort();
      this.abortControllers.delete(taskId);
    }

    // 如果已完成，尝试删除本地文件
    if (task.status === 'completed' && task.filePath) {
      try {
        await Filesystem.deleteFile({
          path: task.filePath,
          directory: Directory.Data,
        });
      } catch {
        // 文件可能不存在
      }
    }

    this.tasks.delete(taskId);
    this.taskMeta.delete(taskId);

    // 从数据库删除
    try {
      const sqliteDb = getSqliteDb();
      sqliteDb.run('DELETE FROM downloads WHERE id = ?', [taskId]);
      await flushDatabase();
    } catch (err) {
      console.error('[DownloadEngine] Failed to delete task from DB:', err);
    }

    this.emit('stateChange', { taskId, status: 'failed', task: { ...task, status: 'failed' } });
    debugLogger.info('download', `下载任务取消/删除: ${taskId}`, {
      taskId,
      wasCompleted: task.status === 'completed',
    });
  }

  // === 便捷方法（兼容 v10 调用方）===
  async addDownload(
    songId: string,
    sourceId: string,
    quality: Quality,
    metadata?: { title?: string; artist?: string; album?: string }
  ): Promise<string> {
    const task = await this.createTask({
      songId,
      sourceId,
      quality,
      title: metadata?.title || '',
      artist: metadata?.artist,
    });
    await this.startDownload(task.id);
    return task.id;
  }

  setMaxConcurrent(max: number): void {
    // TODO: 实现最大并发下载控制
    console.log('[DownloadEngine] setMaxConcurrent:', max);
  }

  setDefaultQuality(quality: Quality): void {
    // TODO: 实现默认音质设置
    console.log('[DownloadEngine] setDefaultQuality:', quality);
  }

  // === 检查本地文件是否存在 ===
  async checkLocalFile(filePath: string): Promise<boolean> {
    try {
      await Filesystem.stat({ path: filePath, directory: Directory.Data });
      return true;
    } catch {
      return false;
    }
  }

  // === 读取本地文件为 Blob URL（用于离线播放）===
  async readLocalFileAsUrl(filePath: string): Promise<string> {
    const result = await Filesystem.readFile({
      path: filePath,
      directory: Directory.Data,
    });
    const base64 = typeof result.data === 'string' ? result.data : '';
    // 推断 mime type
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

  // === 持久化任务到数据库 ===
  private async persistTask(task: DownloadTask): Promise<void> {
    try {
      const sqliteDb = getSqliteDb();
      sqliteDb.run(
        `INSERT OR REPLACE INTO downloads
         (id, song_id, source_id, quality, status, progress, local_path, file_size, error_message, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          task.id,
          task.songId,
          task.sourceId,
          task.quality,
          task.status,
          task.progress,
          task.filePath || null,
          task.totalSize,
          task.errorMessage || null,
          task.createdAt,
          task.status === 'completed' ? Date.now() : null,
        ]
      );
      // 每次写操作后显式 flush，确保落盘
      await flushDatabase();
    } catch (err) {
      console.error('[DownloadEngine] persistTask failed:', err);
    }
  }
}

export const downloadEngine = new DownloadEngine();
