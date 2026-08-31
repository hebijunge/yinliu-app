import type { SearchResult } from '@core/types';
import { Quality } from '@core/types';
import { Filesystem, Directory } from '@capacitor/filesystem';

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
 */
async function parseAudioMetadata(
  file: LocalFileInfo,
  platform: 'tauri' | 'capacitor' | 'web'
): Promise<ScannedSong | null> {
  try {
    let arrayBuffer: ArrayBuffer;

    if (platform === 'tauri') {
      const { readFile } = await import('@tauri-apps/plugin-fs');
      const bytes = await readFile(file.path);
      arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } else if (platform === 'capacitor') {
      arrayBuffer = await readCapacitorFile(file.path);
    } else {
      return createBasicSongInfo(file);
    }

    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      return createBasicSongInfo(file);
    }

    return parseId3Tags(arrayBuffer, file);
  } catch (err) {
    console.warn('[LocalScanner] parseAudioMetadata failed:', err);
    return createBasicSongInfo(file);
  }
}

/**
 * 从 Capacitor 读取文件为 ArrayBuffer（多目录尝试）
 */
async function readCapacitorFile(filePath: string): Promise<ArrayBuffer> {
  const dirsToTry = [Directory.Data, Directory.ExternalStorage, Directory.Documents];

  for (const directory of dirsToTry) {
    try {
      const result = await Filesystem.readFile({ path: filePath, directory });
      const base64 = typeof result.data === 'string' ? result.data : '';
      if (!base64) continue;
      const binary = atob(base64);
      const buffer = new ArrayBuffer(binary.length);
      const view = new Uint8Array(buffer);
      for (let i = 0; i < binary.length; i++) {
        view[i] = binary.charCodeAt(i);
      }
      return buffer;
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
 * 解析 ID3 标签（简化版）
 * 支持 ID3v2.3/2.4 和 ID3v1
 */
function parseId3Tags(arrayBuffer: ArrayBuffer, file: LocalFileInfo): ScannedSong {
  const view = new Uint8Array(arrayBuffer);
  const info = createBasicSongInfo(file);

  // 检查 ID3v2 标签
  if (view.length >= 10 && view[0] === 0x49 && view[1] === 0x44 && view[2] === 0x33) {
    const version = view[3];
    const flags = view[5];
    const size = syncSafeInt(view, 6);
    let offset = 10;

    if (flags & 0x40) {
      const extSize = syncSafeInt(view, offset);
      offset += 4 + extSize;
    }

    const endOffset = Math.min(10 + size, view.length);

    while (offset < endOffset && offset < view.length - 10) {
      const frameId = String.fromCharCode(view[offset], view[offset + 1], view[offset + 2], view[offset + 3]);
      const frameSize = version >= 4 ? syncSafeInt(view, offset + 4) : readInt32BE(view, offset + 4);

      if (frameId === '\x00\x00\x00\x00') break;
      if (frameSize < 0 || frameSize > view.length) break;

      const contentOffset = offset + 10;

      try {
        switch (frameId) {
          case 'TIT2':
            info.title = readTextFrame(view, contentOffset, frameSize) || info.title;
            break;
          case 'TPE1':
          case 'TPE2':
            info.artist = readTextFrame(view, contentOffset, frameSize) || info.artist;
            break;
          case 'TALB':
            info.album = readTextFrame(view, contentOffset, frameSize) || info.album;
            break;
          case 'TLEN':
            info.duration = parseInt(readTextFrame(view, contentOffset, frameSize), 10) / 1000;
            break;
          case 'APIC': {
            const picData = extractApicData(view, contentOffset, frameSize);
            if (picData) {
              try {
                // 复制到独立的 ArrayBuffer 避免 SharedArrayBuffer 类型冲突
                const ab = new ArrayBuffer(picData.byteLength);
                new Uint8Array(ab).set(new Uint8Array(picData));
                const blob = new Blob([ab]);
                info.coverUrl = URL.createObjectURL(blob);
              } catch {
                // ignore blob creation failure
              }
            }
            break;
          }
          case 'TBPM':
            // 比特率信息可能在其他帧
            break;
        }
      } catch {
        // 跳过解析失败的帧
      }

      offset += 10 + frameSize;
    }
  }

  // 检查 ID3v1 标签（在文件末尾）
  if (view.length >= 128) {
    const id3v1Offset = view.length - 128;
    if (view[id3v1Offset] === 0x54 && view[id3v1Offset + 1] === 0x41 && view[id3v1Offset + 2] === 0x47) {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const getString = (start: number, len: number) => {
        const bytes = view.slice(id3v1Offset + start, id3v1Offset + start + len);
        const str = decoder.decode(bytes);
        return str.replace(/\x00/g, '').trim();
      };

      if (!info.title || info.title === '未知歌曲') info.title = getString(3, 30) || info.title;
      if (!info.artist || info.artist === '未知歌手') info.artist = getString(33, 30) || info.artist;
      if (!info.album) info.album = getString(63, 30) || info.album;
    }
  }

  // 估算时长（基于文件大小和比特率）
  if (info.duration === 0 && file.size > 0) {
    info.duration = Math.round((file.size * 8) / (192 * 1000));
  }

  return info;
}

// ID3 辅助函数
function syncSafeInt(view: Uint8Array, offset: number): number {
  return (view[offset] << 21) | (view[offset + 1] << 14) | (view[offset + 2] << 7) | view[offset + 3];
}

function readInt32BE(view: Uint8Array, offset: number): number {
  return (view[offset] << 24) | (view[offset + 1] << 16) | (view[offset + 2] << 8) | view[offset + 3];
}

function readTextFrame(view: Uint8Array, offset: number, size: number): string {
  if (size <= 1) return '';

  const encoding = view[offset];
  const contentStart = offset + 1;
  const contentLength = size - 1;

  let decoder: TextDecoder;
  let bytes: Uint8Array;

  if (encoding === 0) {
    decoder = new TextDecoder('iso-8859-1');
    bytes = view.slice(contentStart, contentStart + contentLength);
  } else if (encoding === 1 || encoding === 2) {
    decoder = new TextDecoder('utf-16');
    bytes = view.slice(contentStart, contentStart + contentLength);
  } else if (encoding === 3) {
    decoder = new TextDecoder('utf-8');
    bytes = view.slice(contentStart, contentStart + contentLength);
  } else {
    decoder = new TextDecoder('utf-8');
    bytes = view.slice(contentStart, contentStart + contentLength);
  }

  return decoder.decode(bytes).replace(/\x00/g, '').trim();
}

function extractApicData(view: Uint8Array, offset: number, size: number): Uint8Array | null {
  try {
    let pos = offset;
    const encoding = view[pos++];

    // 跳过 MIME 类型
    while (pos < offset + size && view[pos] !== 0) pos++;
    pos++;

    // 跳过图片类型
    pos++;

    // 跳过描述
    if (encoding === 0 || encoding === 3) {
      while (pos < offset + size && view[pos] !== 0) pos++;
      pos++;
    } else {
      while (pos < offset + size - 1 && (view[pos] !== 0 || view[pos + 1] !== 0)) pos++;
      pos += 2;
    }

    if (pos < offset + size) {
      return view.slice(pos, offset + size);
    }
  } catch {
    // ignore
  }
  return null;
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

      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: mime });
      return URL.createObjectURL(blob);
    } catch {
      // 尝试下一个目录
    }
  }

  throw new Error(`无法读取本地音频文件: ${filePath}`);
}
