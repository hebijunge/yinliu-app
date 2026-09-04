import type { SearchResult } from '@core/types';
import { Quality } from '@core/types';
import { Filesystem, Directory } from '@capacitor/filesystem';
import type { ParsedHeaderMeta } from './metadata.worker';

export interface LocalFileInfo {
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
}

export interface ScannedSong {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  coverUrl?: string;
  filePath: string;
  fileSize: number;
  format: string;
  bitrate?: number;
}

export interface ScanProgress {
  phase: 'listing' | 'parsing';
  current: number;
  total: number;
  currentFile: string;
}

/**
 * 判断当前运行环境
 */
function getPlatform(): 'tauri' | 'capacitor' | 'web' {
  if (typeof window !== 'undefined' && (window as any).__TAURI__) {
    return 'tauri';
  }
  if (typeof (window as any)?.Capacitor !== 'undefined') {
    return 'capacitor';
  }
  return 'web';
}

const AUDIO_EXTENSIONS = ['.mp3', '.flac', '.aac', '.m4a', '.ogg', '.wav', '.wma'];

/**
 * 扫描指定目录的音频文件
 */
export async function scanLocalMusic(
  directories?: string[],
  onProgress?: (progress: ScanProgress) => void
): Promise<ScannedSong[]> {
  const platform = getPlatform();
  const defaultDirs = directories || getDefaultMusicDirs(platform);

  // === Phase 1: 列出所有音频文件 ===
  const allFiles: LocalFileInfo[] = [];

  for (const dir of defaultDirs) {
    try {
      const files = await listAudioFiles(dir, platform);
      allFiles.push(...files);
    } catch (err) {
      console.warn(`[LocalScanner] 扫描目录失败: ${dir}`, err);
    }
  }

  // === Phase 2: 解析元数据 ===
  const songs: ScannedSong[] = [];
  for (let i = 0; i < allFiles.length; i++) {
    const file = allFiles[i];
    try {
      if (onProgress) {
        onProgress({
          phase: 'parsing',
          current: i + 1,
          total: allFiles.length,
          currentFile: file.name,
        });
      }
      const song = await parseAudioMetadata(file, platform);
      if (song) songs.push(song);
    } catch (err) {
      console.warn(`[LocalScanner] 解析元数据失败: ${file.path}`, err);
    }
  }

  return songs;
}

/**
 * 获取默认音乐目录
 */
function getDefaultMusicDirs(platform: 'tauri' | 'capacitor' | 'web'): string[] {
  switch (platform) {
    case 'tauri':
      return [
        'Music',
        'music',
        'Downloads',
        'downloads',
        'Music/网易云音乐',
        'Music/QQ音乐',
        'Music/酷我音乐',
      ];
    case 'capacitor':
      return [
        'yinliu/downloads',
        'music',
        'Music',
        'Download',
        'download',
        'Documents/music',
      ];
    case 'web':
    default:
      return [];
  }
}

/**
 * 列出目录中的音频文件（含递归）
 */
async function listAudioFiles(
  dir: string,
  platform: 'tauri' | 'capacitor' | 'web'
): Promise<LocalFileInfo[]> {
  if (platform === 'tauri') {
    return listTauriFiles(dir, AUDIO_EXTENSIONS);
  }
  if (platform === 'capacitor') {
    return listCapacitorFilesRecursive(dir, AUDIO_EXTENSIONS);
  }
  return listWebFiles(dir, AUDIO_EXTENSIONS);
}

/**
 * Tauri 文件列表（递归）
 */
async function listTauriFiles(dir: string, extensions: string[]): Promise<LocalFileInfo[]> {
  try {
    const { readDir } = await import('@tauri-apps/plugin-fs');
    const entries = await readDir(dir);
    const files: LocalFileInfo[] = [];

    async function traverse(entries: any[], basePath: string) {
      for (const entry of entries) {
        const fullPath = `${basePath}/${entry.name}`;
        if (entry.isDirectory || entry.children) {
          const children = entry.children || [];
          await traverse(children, fullPath);
        } else {
          const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
          if (extensions.includes(ext)) {
            files.push({
              path: fullPath,
              name: entry.name,
              size: 0,
              modifiedAt: 0,
            });
          }
        }
      }
    }

    await traverse(entries, dir);
    return files;
  } catch (err) {
    console.warn('[LocalScanner] Tauri readDir failed:', err);
    return [];
  }
}

/**
 * Capacitor 文件列表（递归，多目录尝试）
 */
async function listCapacitorFilesRecursive(
  dir: string,
  extensions: string[]
): Promise<LocalFileInfo[]> {
  const files: LocalFileInfo[] = [];

  // 尝试的目录优先级：Data（应用内部，下载目录）> External > Documents
  const dirsToTry: { directory: Directory; path: string }[] = [
    { directory: Directory.Data, path: dir },
    { directory: Directory.ExternalStorage, path: dir },
    { directory: Directory.Documents, path: dir },
    { directory: Directory.Data, path: `yinliu/downloads` },
  ];

  for (const { directory, path } of dirsToTry) {
    try {
      const result = await Filesystem.readdir({ path, directory });
      await traverseCapacitorDir(result.files, path, directory, extensions, files);
      // 如果成功读取到一个目录，通常就够了（避免重复扫描）
      if (files.length > 0) break;
    } catch {
      // 目录不存在或无权限，继续尝试下一个
    }
  }

  return files;
}

async function traverseCapacitorDir(
  entries: any[],
  basePath: string,
  directory: Directory,
  extensions: string[],
  files: LocalFileInfo[]
): Promise<void> {
  for (const entry of entries) {
    const fullPath = `${basePath}/${entry.name}`;

    if (entry.type === 'directory') {
      try {
        const subResult = await Filesystem.readdir({ path: fullPath, directory });
        await traverseCapacitorDir(subResult.files, fullPath, directory, extensions, files);
      } catch {
        // 跳过无法读取的子目录
      }
    } else {
      const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
      if (extensions.includes(ext)) {
        files.push({
          path: fullPath,
          name: entry.name,
          size: entry.size || 0,
          modifiedAt: entry.mtime || 0,
        });
      }
    }
  }
}

/**
 * Web 文件列表（File System Access API）
 */
async function listWebFiles(_dir: string, _extensions: string[]): Promise<LocalFileInfo[]> {
  try {
    const dirHandle = await (window as any).showDirectoryPicker();
    const files: LocalFileInfo[] = [];

    async function traverse(handle: any, path: string) {
      for await (const [name, entry] of handle.entries()) {
        const fullPath = `${path}/${name}`;
        if (entry.kind === 'directory') {
          await traverse(entry, fullPath);
        } else {
          files.push({
            path: fullPath,
            name,
            size: 0,
            modifiedAt: 0,
          });
        }
      }
    }

    await traverse(dirHandle, '');
    return files;
  } catch {
    return [];
  }
}

/**
 * 解析音频文件元数据
 *
 * C8 修复：
 * - 解析逻辑移入 metadata.worker.ts（Worker 线程），主线程不再整文件 atob + 逐字符解码
 * - 仅向 Worker 传文件头部区域（ID3v2 标签区，上限 2MB）+ 尾部 128B（ID3v1），
 *   整文件二进制不再落主线程
 * - FLAC 时长由 STREAMINFO 精确计算（旧实现按 192kbps 估算，对 FLAC 高估约 5 倍）
 */
async function parseAudioMetadata(
  file: LocalFileInfo,
  platform: 'tauri' | 'capacitor' | 'web'
): Promise<ScannedSong | null> {
  const basic = createBasicSongInfo(file);
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();

  try {
    if (platform === 'capacitor') {
      // Capacitor Filesystem API 不支持偏移读取，只能整文件取回 base64 字符串；
      // 但二进制解码与解析全部下沉 Worker，主线程只做小片段 base64 切割
      const base64 = await readCapacitorFileBase64(file.path);
      if (!base64) return basic;
      const head = sliceBase64HeadRegion(base64, ext);
      const tail = sliceBase64Tail128(base64);
      const meta = await workerParseHeader(head, tail, { name: file.name, size: file.size, format: ext });
      if (!meta) return basic;
      return applyMeta(basic, meta);
    }

    if (platform === 'tauri') {
      const { readFile } = await import('@tauri-apps/plugin-fs');
      const bytes = await readFile(file.path);
      if (!bytes || bytes.byteLength === 0) return basic;
      const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const headRegion = sliceHeadRegion(view, ext);
      const tailRegion = view.length >= 128 ? view.slice(view.length - 128) : undefined;
      const meta = await workerParseHeader(
        headRegion.buffer.slice(headRegion.byteOffset, headRegion.byteOffset + headRegion.byteLength) as ArrayBuffer,
        tailRegion ? (tailRegion.buffer.slice(tailRegion.byteOffset, tailRegion.byteOffset + tailRegion.byteLength) as ArrayBuffer) : undefined,
        { name: file.name, size: file.size, format: ext }
      );
      if (!meta) return basic;
      return applyMeta(basic, meta);
    }

    // web：无文件系统读取能力
    return basic;
  } catch (err) {
    console.warn('[LocalScanner] parseAudioMetadata failed:', err);
    return basic;
  }
}

/** 用 Worker 解析出的元数据填充基本信息 */
function applyMeta(basic: ScannedSong, meta: ParsedHeaderMeta): ScannedSong {
  const info: ScannedSong = { ...basic };
  if (meta.title) info.title = meta.title;
  if (meta.artist) info.artist = meta.artist;
  if (meta.album) info.album = meta.album;
  if (meta.duration > 0) info.duration = Math.round(meta.duration);
  if (meta.apic) {
    info.coverUrl = registerCoverUrl(meta.apic);
  }
  return info;
}

// ============ 封面 URL 生命周期管理（C8：页面卸载/重新扫描时统一 revoke，防泄漏）============

const coverUrls = new Set<string>();

function registerCoverUrl(apic: ArrayBuffer): string {
  const url = URL.createObjectURL(new Blob([apic], { type: 'image/jpeg' }));
  coverUrls.add(url);
  return url;
}

/** 撤销当前已登记的全部封面 Blob URL（LocalMusicPage 卸载或重新扫描时调用） */
export function revokeScannedCoverUrls(): void {
  for (const url of coverUrls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
  coverUrls.clear();
}

// ============ Worker 客户端 ============

let metadataWorker: Worker | null = null;
let workerSeq = 0;
const pendingWorkerRequests = new Map<
  number,
  { resolve: (meta: ParsedHeaderMeta | null) => void; timer: ReturnType<typeof setTimeout> }
>();

function getMetadataWorker(): Worker | null {
  if (metadataWorker) return metadataWorker;
  try {
    const worker = new Worker(new URL('./metadata.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as
        | ({ type: 'parse-header-ok'; id: number } & ParsedHeaderMeta)
        | { type: 'decode-full-ok'; id: number; bytes: ArrayBuffer }
        | { type: 'parse-error'; id: number; message: string };
      if (data.type === 'parse-header-ok') {
        const pending = pendingWorkerRequests.get(data.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingWorkerRequests.delete(data.id);
          const { apic, ...rest } = data;
          pending.resolve({ ...rest, apic });
        }
      }
      // decode-full-ok 由专用请求处理
    };
    worker.onerror = (err) => {
      console.warn('[LocalScanner] metadata worker error:', err.message || err);
    };
    metadataWorker = worker;
    return worker;
  } catch (err) {
    console.warn('[LocalScanner] Worker 创建失败，降级为基础信息:', err);
    return null;
  }
}

/**
 * 借道同一 Worker 发送 decode-full 请求（播放用整文件解码）
 */
export function workerDecodeFull(base64: string): Promise<ArrayBuffer | null> {
  const worker = getMetadataWorker();
  if (!worker) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = ++workerSeq;
    const handler = (event: MessageEvent) => {
      const data = event.data as { type: string; id: number; bytes?: ArrayBuffer; message?: string };
      if (data.id !== id) return;
      worker.removeEventListener('message', handler);
      clearTimeout(timer);
      resolve(data.type === 'decode-full-ok' && data.bytes ? data.bytes : null);
    };
    const timer = setTimeout(() => {
      worker.removeEventListener('message', handler);
      resolve(null);
    }, 30000);
    worker.addEventListener('message', handler);
    worker.postMessage({ type: 'decode-full', id, base64 });
  });
}

/** 头部解析请求（10s 超时，失败返回 null 走基本信息兜底） */
function workerParseHeader(
  head: ArrayBuffer,
  tail: ArrayBuffer | undefined,
  file: { name: string; size: number; format: string }
): Promise<ParsedHeaderMeta | null> {
  const worker = getMetadataWorker();
  if (!worker) return Promise.resolve(null);
  const transfer: ArrayBuffer[] = tail ? [head, tail] : [head];
  return new Promise((resolve) => {
    const id = ++workerSeq;
    const timer = setTimeout(() => {
      pendingWorkerRequests.delete(id);
      resolve(null);
    }, 10000);
    pendingWorkerRequests.set(id, { resolve, timer });
    worker.postMessage({ type: 'parse-header', id, head, tail, fileName: file.name, fileSize: file.size, format: file.format }, transfer);
  });
}

// ============ base64 头部/尾部小片段切割（Capacitor：避免整文件解码）============

function syncSafeIntMain(view: Uint8Array, offset: number): number {
  return (view[offset] << 21) | (view[offset + 1] << 14) | (view[offset + 2] << 7) | view[offset + 3];
}

const HEAD_REGION_MAX_BYTES = 2 * 1024 * 1024; // ID3 标签区上限 2MB（含内嵌封面）

/**
 * 从 base64 中只解码出「文件头部区域」：
 * - ID3v2：头部 10B 读出标签总长，再解 10+tagSize（上限 2MB）
 * - 非标签（flac 等）：前 64B（覆盖 fLaC + STREAMINFO）
 */
function sliceBase64HeadRegion(base64: string, format: string): ArrayBuffer {
  const peek = decodeBase64Slice(base64, 10);
  let headBytes = 64;
  if (peek && peek.length >= 10 && peek[0] === 0x49 && peek[1] === 0x44 && peek[2] === 0x33) {
    const tagSize = syncSafeIntMain(peek, 6);
    headBytes = Math.min(10 + tagSize, HEAD_REGION_MAX_BYTES);
  }
  void format;
  const head = decodeBase64Slice(base64, headBytes)!;
  return head.buffer.slice(head.byteOffset, head.byteOffset + head.byteLength) as ArrayBuffer;
}

/** 解码 base64 前 byteLen 字节（对齐 4 字符切片，小片段 atob 不卡线程） */
function decodeBase64Slice(base64: string, byteLen: number): Uint8Array | null {
  if (!base64) return null;
  const chars = Math.ceil((Math.min(byteLen, Math.floor(base64.length / 4) * 3) * 4) / 3 / 4) * 4;
  try {
    const binary = atob(base64.slice(0, chars));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** 解码 base64 最后 128 字节（ID3v1），不足或失败返回 undefined */
function sliceBase64Tail128(base64: string): ArrayBuffer | undefined {
  if (!base64) return undefined;
  const chars = Math.ceil((131 * 4) / 3 / 4) * 4; // 覆盖 128B 的最小 4 对齐前缀
  const slice = base64.slice(Math.max(0, base64.length - chars));
  try {
    const binary = atob(slice);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.length < 128) return undefined;
    return bytes.buffer.slice(bytes.byteOffset + bytes.byteLength - 128, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } catch {
    return undefined;
  }
}

/**
 * 非 Capacitor 路径：从完整字节中切头部区域（字节已在内存，零拷贝切片后复制传输给 Worker）
 */
function sliceHeadRegion(view: Uint8Array, format: string): Uint8Array {
  let headBytes = 64;
  if (view.length >= 10 && view[0] === 0x49 && view[1] === 0x44 && view[2] === 0x33) {
    const tagSize = syncSafeIntMain(view, 6);
    headBytes = Math.min(10 + tagSize, HEAD_REGION_MAX_BYTES);
  }
  void format;
  return view.slice(0, Math.min(headBytes, view.length));
}

/**
 * 从 Capacitor 读取文件 base64（多目录尝试）
 * 注意：Filesystem API 不支持偏移读取，此处整文件 base64 由 Worker 分块解码消化，
 * 主线程不再做 atob + 逐字符全量转换
 */
async function readCapacitorFileBase64(filePath: string): Promise<string> {
  const dirsToTry = [Directory.Data, Directory.ExternalStorage, Directory.Documents];

  for (const directory of dirsToTry) {
    try {
      const result = await Filesystem.readFile({ path: filePath, directory });
      const base64 = typeof result.data === 'string' ? result.data : '';
      if (base64) return base64;
    } catch {
      // 尝试下一个目录
    }
  }

  throw new Error(`无法读取文件: ${filePath}`);
}

/**
 * 从文件名创建基本信息
 */
function createBasicSongInfo(file: LocalFileInfo): ScannedSong {
  const name = file.name.replace(/\.[^.]+$/, '');
  const parts = name.split(/[-–—_]/);
  const artist = parts.length > 1 ? parts[0].trim() : '未知歌手';
  const title = parts.length > 1 ? parts.slice(1).join(' - ').trim() : name.trim();
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();

  return {
    id: `local_${btoa(unescape(encodeURIComponent(file.path))).replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}`,
    title: title || '未知歌曲',
    artist: artist || '未知歌手',
    album: '',
    duration: 0,
    filePath: file.path,
    fileSize: file.size,
    format: ext,
  };
}

/**
 * 将扫描到的本地歌曲转换为 SearchResult 格式
 */
export function localSongToSearchResult(song: ScannedSong): SearchResult {
  return {
    id: song.id,
    type: 'song',
    title: song.title,
    artist: song.artist,
    album: song.album,
    duration: song.duration,
    coverUrl: song.coverUrl,
    sourceId: 'local',
    sourceSongId: song.filePath,
    quality: Quality.STANDARD,
    bitrate: song.bitrate || 128,
  };
}

/**
 * 读取本地音频文件并生成 Blob URL（用于播放）
 * C8：整文件 base64 解码下沉 Worker 分块执行，Worker 不可用时主线程分块兜底
 */
export async function readLocalAudioAsUrl(filePath: string): Promise<string> {
  const dirsToTry = [Directory.Data, Directory.ExternalStorage, Directory.Documents];
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

  for (const directory of dirsToTry) {
    try {
      const result = await Filesystem.readFile({ path: filePath, directory });
      const base64 = typeof result.data === 'string' ? result.data : '';
      if (!base64) continue;

      // 首选：Worker 分块解码（返回 transferable ArrayBuffer）
      const bytes = await workerDecodeFull(base64);
      let blob: Blob;
      if (bytes) {
        blob = new Blob([bytes as BlobPart], { type: mime });
      } else {
        // 兜底：主线程分块解码（仍避免一次性 atob 巨串）
        blob = new Blob([decodeBase64MainThreadChunked(base64)], { type: mime });
      }
      return URL.createObjectURL(blob);
    } catch {
      // 尝试下一个目录
    }
  }

  throw new Error(`无法读取本地音频文件: ${filePath}`);
}

/** 主线程分块 base64 解码兜底实现（每块 32KB，避免长任务阻塞） */
function decodeBase64MainThreadChunked(base64: string): Uint8Array<ArrayBuffer> {
  const totalBytes = Math.floor((base64.length * 3) / 4);
  const out = new Uint8Array(totalBytes);
  const CHUNK_CHARS = 4 * 32768;
  let outOffset = 0;

  for (let start = 0; start < base64.length; start += CHUNK_CHARS) {
    let slice = base64.slice(start, start + CHUNK_CHARS);
    const remainder = slice.length % 4;
    if (remainder !== 0) slice = slice.slice(0, slice.length - remainder);
    if (!slice) break;

    const binary = atob(slice);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    out.set(bytes, outOffset);
    outOffset += bytes.length;
  }

  return out.subarray(0, outOffset);
}
