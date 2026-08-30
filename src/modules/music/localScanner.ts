import type { SearchResult } from '@core/types';
import { Quality } from '@core/types';

/**
 * 本地音乐文件扫描器
 * 支持：Tauri fs插件 / Capacitor Filesystem / Web File API
 * 扫描目录：Music/音乐/下载等
 * 读取元数据：ID3/MP4（标题/歌手/专辑/封面/时长）
 */

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

/**
 * 扫描指定目录的音频文件
 */
export async function scanLocalMusic(
  directories?: string[]
): Promise<ScannedSong[]> {
  const platform = getPlatform();
  const defaultDirs = directories || getDefaultMusicDirs(platform);

  const allFiles: LocalFileInfo[] = [];

  for (const dir of defaultDirs) {
    try {
      const files = await listAudioFiles(dir, platform);
      allFiles.push(...files);
    } catch (err) {
      console.warn(`扫描目录失败: ${dir}`, err);
    }
  }

  // 解析每个音频文件的元数据
  const songs: ScannedSong[] = [];
  for (const file of allFiles) {
    try {
      const song = await parseAudioMetadata(file, platform);
      if (song) songs.push(song);
    } catch (err) {
      console.warn(`解析元数据失败: ${file.path}`, err);
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
      // Tauri桌面端：使用系统音乐目录
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
      // Capacitor移动端
      return [
        'music',
        'Music',
        'Download',
        'download',
        'Documents/music',
      ];
    case 'web':
    default:
      // Web端：仅支持用户手动选择
      return [];
  }
}

/**
 * 列出目录中的音频文件
 */
async function listAudioFiles(
  dir: string,
  platform: 'tauri' | 'capacitor' | 'web'
): Promise<LocalFileInfo[]> {
  const audioExtensions = ['.mp3', '.flac', '.aac', '.m4a', '.ogg', '.wav', '.wma'];

  if (platform === 'tauri') {
    return listTauriFiles(dir, audioExtensions);
  }

  if (platform === 'capacitor') {
    return listCapacitorFiles(dir, audioExtensions);
  }

  // Web端：使用File System Access API
  return listWebFiles(dir, audioExtensions);
}

/**
 * Tauri文件列表
 */
async function listTauriFiles(dir: string, extensions: string[]): Promise<LocalFileInfo[]> {
  try {
    const { readDir } = await import('@tauri-apps/plugin-fs');
    const entries = await readDir(dir);
    const files: LocalFileInfo[] = [];

    function traverse(entries: any[], basePath: string) {
      for (const entry of entries) {
        const fullPath = `${basePath}/${entry.name}`;
        if (entry.children) {
          traverse(entry.children, fullPath);
        } else {
          const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
          if (extensions.includes(ext)) {
            files.push({
              path: fullPath,
              name: entry.name,
              size: 0, // Tauri readDir不返回大小
              modifiedAt: 0,
            });
          }
        }
      }
    }

    traverse(entries, dir);
    return files;
  } catch {
    return [];
  }
}

/**
 * Capacitor文件列表
 */
async function listCapacitorFiles(dir: string, extensions: string[]): Promise<LocalFileInfo[]> {
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const result = await Filesystem.readdir({
      path: dir,
      directory: Directory.ExternalStorage,
    });

    const files: LocalFileInfo[] = [];

    for (const entry of result.files) {
      const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
      if (extensions.includes(ext)) {
        files.push({
          path: `${dir}/${entry.name}`,
          name: entry.name,
          size: entry.size || 0,
          modifiedAt: entry.mtime || 0,
        });
      }
    }

    return files;
  } catch {
    return [];
  }
}

/**
 * Web文件列表（File System Access API）
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
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const result = await Filesystem.readFile({
        path: file.path,
        directory: Directory.ExternalStorage,
      });
      const base64 = result.data as string;
      const binary = atob(base64);
      arrayBuffer = new ArrayBuffer(binary.length);
      const view = new Uint8Array(arrayBuffer);
      for (let i = 0; i < binary.length; i++) {
        view[i] = binary.charCodeAt(i);
      }
    } else {
      // Web: 无法直接读取文件系统
      return createBasicSongInfo(file);
    }

    return parseId3Tags(arrayBuffer, file);
  } catch {
    return createBasicSongInfo(file);
  }
}

/**
 * 从文件名创建基本信息
 */
function createBasicSongInfo(file: LocalFileInfo): ScannedSong {
  const name = file.name.replace(/\.[^.]+$/, '');
  // 尝试从文件名解析歌手-歌名格式
  const parts = name.split(/[-–—_]/);
  const artist = parts.length > 1 ? parts[0].trim() : '未知歌手';
  const title = parts.length > 1 ? parts.slice(1).join(' - ').trim() : name.trim();

  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();

  return {
    id: `local_${btoa(file.path).replace(/[^a-zA-Z0-9]/g, '')}`,
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
 * 解析ID3标签（简化版）
 * 支持ID3v2.3/2.4和ID3v1
 */
function parseId3Tags(arrayBuffer: ArrayBuffer, file: LocalFileInfo): ScannedSong {
  const view = new Uint8Array(arrayBuffer);
  const info = createBasicSongInfo(file);

  // 检查ID3v2标签
  if (view[0] === 0x49 && view[1] === 0x44 && view[2] === 0x33) {
    // ID3v2 header
    const version = view[3];
    const flags = view[5];
    const size = syncSafeInt(view, 6);
    let offset = 10;

    // 如果有扩展头，跳过
    if (flags & 0x40) {
      const extSize = syncSafeInt(view, offset);
      offset += 4 + extSize;
    }

    const endOffset = 10 + size;

    while (offset < endOffset && offset < view.length - 10) {
      const frameId = String.fromCharCode(view[offset], view[offset + 1], view[offset + 2], view[offset + 3]);
      const frameSize = version >= 4 ? syncSafeInt(view, offset + 4) : readInt32BE(view, offset + 4);
      const frameFlags = (view[offset + 8] << 8) | view[offset + 9];

      if (frameId === '\x00\x00\x00\x00') break;

      const contentOffset = offset + 10;

      try {
        switch (frameId) {
          case 'TIT2':
            info.title = readTextFrame(view, contentOffset, frameSize);
            break;
          case 'TPE1':
          case 'TPE2':
            info.artist = readTextFrame(view, contentOffset, frameSize);
            break;
          case 'TALB':
            info.album = readTextFrame(view, contentOffset, frameSize);
            break;
          case 'TLEN':
            info.duration = parseInt(readTextFrame(view, contentOffset, frameSize), 10) / 1000;
            break;
          case 'APIC': {
            // 封面图片 - 简化处理
            const picData = extractApicData(view, contentOffset, frameSize);
            if (picData) {
              const blob = new Blob([picData as BlobPart]);
              info.coverUrl = URL.createObjectURL(blob);
            }
            break;
          }
        }
      } catch {
        // 跳过解析失败的帧
      }

      offset += 10 + frameSize;
    }
  }

  // 检查ID3v1标签（在文件末尾）
  if (view.length >= 128) {
    const id3v1Offset = view.length - 128;
    if (view[id3v1Offset] === 0x54 && view[id3v1Offset + 1] === 0x41 && view[id3v1Offset + 2] === 0x47) {
      // TAG found
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const getString = (start: number, len: number) => {
        const bytes = view.slice(id3v1Offset + start, id3v1Offset + start + len);
        const str = decoder.decode(bytes);
        return str.replace(/\x00/g, '').trim();
      };

      if (!info.title) info.title = getString(3, 30) || info.title;
      if (!info.artist) info.artist = getString(33, 30) || info.artist;
      if (!info.album) info.album = getString(63, 30) || info.album;
    }
  }

  // 估算时长（基于文件大小和比特率）
  if (info.duration === 0 && file.size > 0) {
    // 假设平均比特率192kbps
    info.duration = Math.round((file.size * 8) / (192 * 1000));
  }

  return info;
}

// ID3辅助函数
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
    // ISO-8859-1
    decoder = new TextDecoder('iso-8859-1');
    bytes = view.slice(contentStart, contentStart + contentLength);
  } else if (encoding === 1 || encoding === 2) {
    // UTF-16 with BOM
    decoder = new TextDecoder('utf-16');
    bytes = view.slice(contentStart, contentStart + contentLength);
  } else if (encoding === 3) {
    // UTF-8
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

    // 跳过MIME类型
    while (pos < offset + size && view[pos] !== 0) pos++;
    pos++; // 跳过null

    // 跳过图片类型
    pos++;

    // 跳过描述
    if (encoding === 0) {
      while (pos < offset + size && view[pos] !== 0) pos++;
      pos++;
    } else {
      while (pos < offset + size - 1 && (view[pos] !== 0 || view[pos + 1] !== 0)) pos++;
      pos += 2;
    }

    // 剩余的是图片数据
    if (pos < offset + size) {
      return view.slice(pos, offset + size);
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * 将扫描到的本地歌曲转换为SearchResult格式
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
