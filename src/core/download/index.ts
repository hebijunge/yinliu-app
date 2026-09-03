import type { Quality, DownloadStatus, DownloadTask } from '@core/types';
import { sourceRegistry } from '@providers/music/registry';
import { platformFetch } from '@shared/utils/platformFetch';
import { getSqliteDb, flushDatabase } from '@shared/database';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { buildFallbackChain, PLATFORM_DISPLAY_NAMES } from '@core/platformPriority';
import { toast } from '@shared/components/Toast';
import { deriveRawKey } from '../../utils/crypto/kuwoEkey';
import { qmc2DecryptBytes } from '../../utils/crypto/qmc2';
import { decryptCencMp4, fetchZ3dKey, decryptZ3d, extractZ3dKey } from '@shared/audio/crypto';

/**
 * v16 内容级音频校验：识别防盗占位/加密废数据。
 * 防盗占位音频 URL 形态正常、码率字段也匹配，仅靠 URL/响应码无法识别；
 * 下载落盘前对内容做魔数校验，不通过则降级到下一个源，绝不把废数据标成「已完成」。
 */
interface MagicCheck {
  ok: boolean;
  detail: string;
  hexHead: string;
}

function looksLikeAudio(data: Uint8Array): MagicCheck {
  const hexAt = (i: number) => data[i].toString(16).padStart(2, '0');
  const n = Math.min(8, data.length);
  let hexHead = '';
  for (let i = 0; i < n; i++) hexHead += (i > 0 ? ' ' : '') + hexAt(i);
  if (data.length < 1024) {
    return { ok: false, detail: `文件过小(${data.length}B)`, hexHead };
  }
  const startsWith = (bytes: number[]) => bytes.every((b, i) => data[i] === b);
  // ID3（mp3 带标签）
  if (startsWith([0x49, 0x44, 0x33])) return { ok: true, detail: 'mp3/ID3', hexHead };
  // mp3 帧头 / ADTS(AAC)：0xFFEx
  if (data[0] === 0xff && (data[1] & 0xe0) === 0xe0) return { ok: true, detail: 'mp3帧/AAC', hexHead };
  // fLaC
  if (startsWith([0x66, 0x4c, 0x61, 0x43])) return { ok: true, detail: 'flac', hexHead };
  // OggS
  if (startsWith([0x4f, 0x67, 0x67, 0x53])) return { ok: true, detail: 'ogg', hexHead };
  // RIFF/WAVE
  if (startsWith([0x52, 0x49, 0x46, 0x46])) return { ok: true, detail: 'wav', hexHead };
  // ftyp（M4A/MP4 容器）
  if (startsWith([0x66, 0x74, 0x79, 0x70])) return { ok: true, detail: 'm4a', hexHead };
  return { ok: false, detail: '魔数不匹配(非 ID3/mp3帧/AAC/flac/ogg/wav/m4a)', hexHead };
}

/** Uint8Array → base64（32KB 分块避免大文件栈溢出） */
function arrayBufferToBase64(buffer: Uint8Array): string {
  const chunkSize = 32768;
  let binary = '';
  for (let i = 0; i < buffer.length; i += chunkSize) {
    const chunk = buffer.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
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
          title: row.title ? String(row.title) : undefined,
          artist: row.artist ? String(row.artist) : undefined,
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
      title: params.title || undefined,
      artist: params.artist || undefined,
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
        this.taskMeta.set(existing.id, meta);
      }
      if (!existing.title && params.title) existing.title = params.title;
      if (!existing.artist && params.artist) existing.artist = params.artist;
      return existing;
    }

    this.tasks.set(id, task);
    if (params.availableSources && params.availableSources.length > 0) {
      this.taskMeta.set(id, { availableSources: params.availableSources });
    }
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
    task.downloadedSize = 0;
    await this.persistTask(task);
    this.emit('stateChange', { taskId, status: 'downloading', task });

    try {
      // 1. 构建多平台降级链（v13）
      const meta = this.taskMeta.get(taskId);
      const availableIds = (meta?.availableSources || []).map((s) => s.sourceId);
      const songIdMap = new Map<string, string>();
      for (const s of meta?.availableSources || []) {
        songIdMap.set(s.sourceId, s.sourceSongId);
      }
      // 兜底：主 songId 在主源下
      songIdMap.set(task.sourceId, task.songId);

      const chain = buildFallbackChain(task.sourceId, availableIds);

      // 2. 确保下载目录存在
      const dir = 'yinliu/downloads';
      try {
        await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true });
      } catch {
        // 目录可能已存在
      }

      // 3. 逐源尝试：取链 → 下载 → 内容校验 → 解密 → 落盘
      //    v16：校验放在下载之后、落盘之前——防盗占位/加密废数据不再被标成「已完成」
      let lastError: unknown = null;
      let saved = false;
      let filePath = '';

      for (let i = 0; i < chain.length; i++) {
        const trySourceId = chain[i];
        const source = sourceRegistry.get(trySourceId);
        if (!source || !source.enabled) continue;
        const trySongId = songIdMap.get(trySourceId) || task.songId;

        const abortCtrl = new AbortController();
        this.abortControllers.set(taskId, abortCtrl);

        try {
          const playUrl = await source.getPlayUrl(trySongId, task.quality, abortCtrl.signal);
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
          }

          // 把实际取到的源回写到 task（便于后续断点续传/本地播放知道该找哪个源）
          task.sourceId = trySourceId;
          task.songId = trySongId;
          task.url = playUrl.url;
          this.emit('stateChange', { taskId, status: 'downloading', task });

          // 3a. 下载二进制（v16：Range 分块拉取，真实进度 + 可暂停；不支持 Range 回退整包）
          const raw = await this.fetchBinary(taskId, playUrl.url, playUrl.headers || {}, abortCtrl.signal);

          // 3b. QMC2 解密（v15 及之前该解密从未生效：全局解密器从未注册、ekey 从未被使用）
          let bytes = raw;
          if (playUrl.ekey && (playUrl.isEncrypted || trySourceId === 'kuwo')) {
            const rawKey = deriveRawKey(playUrl.ekey);
            if (rawKey) {
              bytes = qmc2DecryptBytes(raw, rawKey);
              console.log(
                `[DownloadEngine] QMC2 decrypted: ${raw.length} -> ${bytes.length} bytes (${trySourceId})`
              );
            } else {
              console.warn(
                '[DownloadEngine] ekey present but key derivation failed; raw bytes go to magic check'
              );
            }
          }

          // 3b-2. CENC 解密（汽水音乐 track.php 返回的加密 MP4 流）
          if (playUrl.decryptKey) {
            try {
              const decrypted = await decryptCencMp4(bytes.buffer as ArrayBuffer, playUrl.decryptKey);
              bytes = new Uint8Array(decrypted.data);
              playUrl.format = decrypted.format;
              console.log(
                `[DownloadEngine] CENC decrypted: ${decrypted.format}, ${bytes.length} bytes (${trySourceId})`
              );
            } catch (cencErr) {
              console.error(
                `[DownloadEngine] CENC decrypt failed: ${cencErr instanceof Error ? cencErr.message : String(cencErr)} (${trySourceId})`
              );
              throw new Error(
                `CENC 解密失败: ${cencErr instanceof Error ? cencErr.message : String(cencErr)}`
              );
            }
          }

          // 3b-3. Z3D 解密（咪咕加密音频）——下载路径优化：已持有完整 Z3D bytes，只需 fetch 3D60 前32字节提取密钥
          if (playUrl.z3dDecryptInfo) {
            try {
              const p3dResp = await fetch(playUrl.z3dDecryptInfo.p3dUrl, {
                method: 'GET',
                headers: { ...(playUrl.headers || {}), Range: 'bytes=0-31' },
              });
              if (!p3dResp.ok) {
                throw new Error(`3D60 前32字节下载失败: ${p3dResp.status}`);
              }
              const p3dFirst32 = new Uint8Array(await p3dResp.arrayBuffer());
              const z3dFirst32 = bytes.slice(0, 32);
              const key = extractZ3dKey(z3dFirst32, p3dFirst32);
              bytes = decryptZ3d(bytes, key);
              playUrl.format = 'wav';
              console.log(
                `[DownloadEngine] Z3D decrypted: ${bytes.length} bytes (${trySourceId})`
              );
            } catch (z3dErr) {
              console.error(
                `[DownloadEngine] Z3D decrypt failed: ${z3dErr instanceof Error ? z3dErr.message : String(z3dErr)} (${trySourceId})`
              );
              throw new Error(
                `Z3D 解密失败: ${z3dErr instanceof Error ? z3dErr.message : String(z3dErr)}`
              );
            }
          }

          // 3c. 内容级校验：魔数不符 = 防盗占位/加密废数据，记录证据后降级到下一源
          const magic = looksLikeAudio(bytes);
          if (!magic.ok) {
            console.error(
              `[DownloadEngine] ANTI-THEFT/INVALID content detected: source=${trySourceId} ` +
                `songId=${trySongId} size=${bytes.length} head=[${magic.hexHead}] detail=${magic.detail} ` +
                `url=${playUrl.url.slice(0, 120)}`
            );
            throw new Error(`内容校验失败（${magic.detail}，头部字节 ${magic.hexHead}）`);
          }

          // 3d. 构建文件路径并写入
          const ext = playUrl.format || 'mp3';
          filePath = `${dir}/${trySourceId}_${trySongId}_${task.quality}.${ext}`;
          const base64 = arrayBufferToBase64(bytes);
          await Filesystem.writeFile({
            path: filePath,
            data: base64,
            directory: Directory.Data,
            recursive: true,
          });

          saved = true;
          task.totalSize = bytes.length;
          task.downloadedSize = bytes.length;
          task.progress = 1;
          break;
        } catch (err) {
          lastError = err;
          console.warn(
            `[DownloadEngine] source ${trySourceId} failed:`,
            err instanceof Error ? err.message : err
          );
          // 用户主动暂停/取消：不降级，直接抛出让外层按 paused 收尾
          if (task.status !== 'downloading') {
            throw err;
          }
        } finally {
          this.abortControllers.delete(taskId);
        }
      }

      if (!saved) {
        throw new Error(
          `All ${chain.length} sources failed for download: ${
            lastError instanceof Error ? lastError.message : 'unknown'
          }`
        );
      }

      task.filePath = filePath;
      // 4. 标记完成
      task.status = 'completed';
      task.progress = 1;
      await this.persistTask(task);
      this.emit('stateChange', { taskId, status: 'completed', task });
      this.emit('completed', { taskId, filePath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 用户主动暂停：保持 paused 状态，不算失败（paused 由 pauseDownload 异步写入，这里用 string 比较）
      if ((task.status as string) === 'paused') {
        await this.persistTask(task);
        this.emit('stateChange', { taskId, status: 'paused', task });
      } else {
        task.status = 'failed';
        task.errorMessage = msg;
        await this.persistTask(task);
        this.emit('stateChange', { taskId, status: 'failed', task });
        this.emit('failed', { taskId, error: msg });
      }
      this.abortControllers.delete(taskId);
    }
  }

  /**
   * v16: 分块拉取音频二进制。
   * 背景：Android 原生端 platformFetch 走 CapacitorHttp，arraybuffer 响应是整包缓冲——
   * response.body 的流只在结尾吐一个大块，旧实现下载全程进度恒 0%（显示「计算中...」），
   * 大文件还有整包 base64 过桥的内存峰值。这里改为 HEAD 探测大小后按 1MiB Range 分块拉取，
   * 每块落地即发 progress 事件，块间检查暂停/取消；服务器不支持 Range 时回退整包 GET。
   */
  private async fetchBinary(
    taskId: string,
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal
  ): Promise<Uint8Array> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const CHUNK = 1 << 20; // 1 MiB

    // HEAD 探测 content-length 与 Range 支持（失败不阻塞，走整包回退）
    let totalSize = 0;
    let acceptRanges = false;
    try {
      const head = await platformFetch(url, { method: 'HEAD', headers, signal, timeout: 15000 });
      if (head.ok) {
        totalSize = Number(head.headers.get('content-length') || '0');
        acceptRanges = (head.headers.get('accept-ranges') || '').toLowerCase() === 'bytes';
      }
    } catch (err) {
      console.warn(
        '[DownloadEngine] HEAD probe failed, fallback to full GET:',
        err instanceof Error ? err.message : err
      );
    }
    task.totalSize = totalSize;

    const chunks: Uint8Array[] = [];
    let downloaded = 0;
    let lastTime = Date.now();
    let lastDownloaded = 0;

    const emitProgress = () => {
      task.downloadedSize = downloaded;
      task.totalSize = totalSize;
      const ratio = totalSize > 0 ? Math.max(0, Math.min(1, downloaded / totalSize)) : 0;
      task.progress = ratio;
      const now = Date.now();
      const dt = now - lastTime;
      const speed = dt >= 500 ? Math.round(((downloaded - lastDownloaded) / dt) * 1000) : undefined;
      if (dt >= 500) {
        lastTime = now;
        lastDownloaded = downloaded;
      }
      this.emit('progress', {
        taskId,
        progress: ratio,
        downloadedSize: downloaded,
        totalSize,
        speed: speed ?? 0,
      });
    };

    if (acceptRanges && totalSize > 0) {
      for (let start = 0; start < totalSize; start += CHUNK) {
        if (signal.aborted || task.status !== 'downloading') {
          throw new DOMException('Aborted', 'AbortError');
        }
        const end = Math.min(start + CHUNK - 1, totalSize - 1);
        const resp = await platformFetch(url, {
          method: 'GET',
          headers: { ...headers, Range: `bytes=${start}-${end}` },
          responseType: 'arraybuffer',
          signal,
        });
        if (resp.status === 206) {
          const buf = new Uint8Array(await resp.arrayBuffer());
          chunks.push(buf);
          downloaded += buf.length;
          emitProgress();
        } else if (resp.status === 200) {
          // 服务器忽略 Range 返回整包：首块直接收下整个文件
          if (start === 0) {
            const buf = new Uint8Array(await resp.arrayBuffer());
            chunks.push(buf);
            downloaded = buf.length;
            totalSize = buf.length;
            emitProgress();
            break;
          }
          throw new Error(`Range ignored (HTTP 200) at offset ${start}`);
        } else {
          throw new Error(`HTTP ${resp.status} on Range ${start}-${end}`);
        }
      }
    } else {
      // 整包 GET（不支持 Range 或大小未知）：无法流式，但至少接收后立即给出完整进度
      const resp = await platformFetch(url, {
        method: 'GET',
        headers,
        responseType: 'arraybuffer',
        signal,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      const buf = new Uint8Array(await resp.arrayBuffer());
      chunks.push(buf);
      downloaded = buf.length;
      if (totalSize <= 0) totalSize = buf.length;
      emitProgress();
    }

    const merged = new Uint8Array(downloaded);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
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

  // === 播放本地已下载文件 ===
  async playLocalFile(taskId: string): Promise<string> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'completed') {
      throw new Error(`Task ${taskId} not found or not completed`);
    }
    if (!task.filePath) {
      throw new Error(`Task ${taskId} has no local file path`);
    }
    return this.readLocalFileAsUrl(task.filePath);
  }

  // === 清空所有已完成任务 ===
  async clearCompleted(): Promise<number> {
    const completed = this.getTasks().filter((t) => t.status === 'completed');
    let removed = 0;
    for (const task of completed) {
      try {
        if (task.filePath) {
          await Filesystem.deleteFile({
            path: task.filePath,
            directory: Directory.Data,
          });
        }
      } catch {
        // 文件可能已被手动删除
      }
      this.tasks.delete(task.id);
      this.taskMeta.delete(task.id);
      removed++;
    }
    // 批量从数据库删除
    if (removed > 0) {
      try {
        const sqliteDb = getSqliteDb();
        sqliteDb.run("DELETE FROM downloads WHERE status = 'completed'");
        await flushDatabase();
      } catch (err) {
        console.error('[DownloadEngine] clearCompleted DB delete failed:', err);
      }
    }
    this.emit('stateChange', { type: 'bulkClear', count: removed });
    return removed;
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
         (id, song_id, source_id, quality, status, progress, local_path, file_size, downloaded_size, error_message, title, artist, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          task.id,
          task.songId,
          task.sourceId,
          task.quality,
          task.status,
          task.progress,
          task.filePath || null,
          task.totalSize,
          task.downloadedSize ?? null,
          task.errorMessage || null,
          task.title || null,
          task.artist || null,
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
