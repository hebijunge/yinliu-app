import type { Quality, DownloadStatus, DownloadTask } from '@core/types';
import { sourceRegistry } from '@providers/music/registry';
import { platformFetch } from '@shared/utils/platformFetch';
import { getSqliteDb, flushDatabase } from '@shared/database';
import { Filesystem, Directory } from '@capacitor/filesystem';

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

export class DownloadEngine {
  private tasks = new Map<string, DownloadTask>();
  private abortControllers = new Map<string, AbortController>();
  private listeners: Record<string, Array<(data: unknown) => void>> = {};

  private emit(event: string, data: unknown) {
    const callbacks = this.listeners[event] || [];
    callbacks.forEach((cb) => cb(data));
  }

  on(event: string, callback: (data: unknown) => void): () => void {
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
      return existing;
    }

    this.tasks.set(id, task);
    await this.persistTask(task);
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

    try {
      // 1. 获取播放 URL
      const source = sourceRegistry.get(task.sourceId);
      if (!source) {
        throw new Error(`Source ${task.sourceId} not found`);
      }

      const playUrl = await source.getPlayUrl(task.songId, task.quality);
      task.url = playUrl.url;

      // 2. 确保下载目录存在
      const dir = 'yinliu/downloads';
      try {
        await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true });
      } catch {
        // 目录可能已存在
      }

      // 3. 构建文件路径
      const ext = playUrl.format || 'mp3';
      const fileName = `${task.sourceId}_${task.songId}_${task.quality}.${ext}`;
      const filePath = `${dir}/${fileName}`;
      task.filePath = filePath;

      // 4. 发起二进制下载
      const abortCtrl = new AbortController();
      this.abortControllers.set(taskId, abortCtrl);

      const response = await platformFetch(playUrl.url, {
        method: 'GET',
        signal: abortCtrl.signal,
        headers: playUrl.headers || {},
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

      // 转为 base64 写入 Capacitor Filesystem
      const base64 = btoa(String.fromCharCode(...decrypted));
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

      this.abortControllers.delete(taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      task.status = 'failed';
      task.errorMessage = msg;
      await this.persistTask(task);
      this.emit('stateChange', { taskId, status: 'failed', task });
      this.emit('failed', { taskId, error: msg });
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
  }

  // === 继续下载（paused → downloading）===
  async resumeDownload(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'paused') return;
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

    // 从数据库删除
    try {
      const sqliteDb = getSqliteDb();
      sqliteDb.run('DELETE FROM downloads WHERE id = ?', [taskId]);
      await flushDatabase();
    } catch (err) {
      console.error('[DownloadEngine] Failed to delete task from DB:', err);
    }

    this.emit('stateChange', { taskId, status: 'failed', task: { ...task, status: 'failed' } });
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
