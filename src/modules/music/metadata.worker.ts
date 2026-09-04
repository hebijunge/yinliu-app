/**
 * 音频元数据解析 Worker（C8）
 *
 * 职责：
 * - 在 Worker 线程完成 base64 → 二进制的分块解码（旧实现 atob + 逐字符循环阻塞主线程）
 * - 仅解析文件头部区域（ID3v2 标签 + 尾部 128B ID3v1）+ FLAC STREAMINFO，
 *   不再把整文件载入主线程内存
 * - FLAC 用 STREAMINFO 的 sampleRate/totalSamples 计算精确时长
 *   （旧实现按 192kbps 统一估算，对 FLAC 高估约 5 倍）
 *
 * 协议（request id 关联）：
 *   { type: 'parse-header', id, head: ArrayBuffer, tail?: ArrayBuffer, fileName, fileSize, format }
 *     → { type: 'parse-header-ok', id, title, artist, album, duration, apic?: ArrayBuffer }
 *   { type: 'decode-full', id, base64 }
 *     → { type: 'decode-full-ok', id, bytes: ArrayBuffer }（用于播放：整文件在 Worker 解码）
 *   失败 → { type: 'parse-error', id, message }
 *
 * head/tail 由主线程从 base64 中只切出头部区域小片段解码而来，整文件二进制不落主线程。
 */

export interface ParsedHeaderMeta {
  title?: string;
  artist?: string;
  album?: string;
  duration: number;
  apic?: ArrayBuffer;
}

interface ParseHeaderRequest {
  type: 'parse-header';
  id: number;
  head: ArrayBuffer;
  tail?: ArrayBuffer;
  fileName: string;
  fileSize: number;
  format: string;
}

interface DecodeFullRequest {
  type: 'decode-full';
  id: number;
  base64: string;
}

type WorkerRequest = ParseHeaderRequest | DecodeFullRequest;

// ============ 分块 base64 解码 ============

/** 分块解码 base64：避免一次性 atob 生成超大字符串导致主线程/Worker 卡顿 */
function decodeBase64Chunked(base64: string): Uint8Array {
  const totalBytes = Math.floor((base64.length * 3) / 4);
  const out = new Uint8Array(totalBytes);
  const CHUNK_CHARS = 4 * 32768; // 32768 字节/块
  let outOffset = 0;

  for (let start = 0; start < base64.length; start += CHUNK_CHARS) {
    let slice = base64.slice(start, start + CHUNK_CHARS);
    // 对齐 4 字符（base64 每字符 3/4 字节）
    const remainder = slice.length % 4;
    if (remainder !== 0) slice = slice.slice(0, slice.length - remainder);
    if (!slice) break;

    const binary = atob(slice);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    out.set(bytes, outOffset);
    outOffset += bytes.length;
  }

  return out.subarray(0, outOffset);
}

// ============ 元数据解析 ============

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
  if (encoding === 0) {
    decoder = new TextDecoder('iso-8859-1');
  } else if (encoding === 1 || encoding === 2) {
    decoder = new TextDecoder('utf-16');
  } else {
    decoder = new TextDecoder('utf-8');
  }
  const bytes = view.slice(contentStart, contentStart + contentLength);
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
 * FLAC STREAMINFO 精确时长
 * fLaC(4) + 块头(4) 后是 STREAMINFO 内容（34B）：
 *   内容偏移 10..12 = 20bit sampleRate，13..17 = 36bit totalSamples（与 3bit channels/5bit bps 共用字节）
 */
function parseFlacDuration(head: Uint8Array, fileSize: number, format: string): number {
  if (head.length >= 8 + 18 && head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) {
    const c = 8; // STREAMINFO 内容起点
    const sampleRate = (head[c + 10] << 12) | (head[c + 11] << 4) | (head[c + 12] >> 4);
    const totalSamplesHigh = head[c + 13] & 0x0f;
    const totalSamples =
      totalSamplesHigh * 2 ** 32 +
      ((head[c + 14] << 24) | (head[c + 15] << 16) | (head[c + 16] << 8) | head[c + 17]) >>> 0;
    if (sampleRate > 0 && totalSamples > 0) {
      return totalSamples / sampleRate;
    }
  }
  // 无 STREAMINFO 时按格式码率估算（flac ≈ 900kbps，不再是 192）
  return estimateDuration(fileSize, format === 'flac' ? 900 : fallbackBitrateKbps(format));
}

/** 按格式给兜底码率（kbps）；mp3 无 Xing 头时 CBR 192 是常见情形 */
function fallbackBitrateKbps(format: string): number {
  switch (format) {
    case 'flac': return 900;
    case 'wav': return 1411;
    case 'm4a':
    case 'aac': return 128;
    case 'ogg': return 160;
    case 'wma': return 128;
    default: return 192;
  }
}

function estimateDuration(fileSize: number, bitrateKbps: number): number {
  if (fileSize <= 0) return 0;
  return Math.round((fileSize * 8) / (bitrateKbps * 1000));
}

function parseHeaderBytes(head: Uint8Array, tail: Uint8Array | null, file: { name: string; size: number; format: string }): ParsedHeaderMeta {
  const meta: ParsedHeaderMeta = {
    title: undefined,
    artist: undefined,
    album: undefined,
    duration: 0,
  };

  // === ID3v2 标签 ===
  if (head.length >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    const version = head[3];
    const flags = head[5];
    const tagSize = syncSafeInt(head, 6);
    let offset = 10;

    if (flags & 0x40) {
      const extSize = syncSafeInt(head, offset);
      offset += 4 + extSize;
    }

    const endOffset = Math.min(10 + tagSize, head.length);

    while (offset < endOffset && offset < head.length - 10) {
      const frameId = String.fromCharCode(head[offset], head[offset + 1], head[offset + 2], head[offset + 3]);
      const frameSize = version >= 4 ? syncSafeInt(head, offset + 4) : readInt32BE(head, offset + 4);

      if (frameId === '\x00\x00\x00\x00') break;
      if (frameSize < 0 || frameSize > head.length) break;

      const contentOffset = offset + 10;

      try {
        switch (frameId) {
          case 'TIT2':
            meta.title = readTextFrame(head, contentOffset, frameSize) || meta.title;
            break;
          case 'TPE1':
          case 'TPE2':
            meta.artist = readTextFrame(head, contentOffset, frameSize) || meta.artist;
            break;
          case 'TALB':
            meta.album = readTextFrame(head, contentOffset, frameSize) || meta.album;
            break;
          case 'TLEN': {
            const ms = parseInt(readTextFrame(head, contentOffset, frameSize), 10);
            if (!isNaN(ms) && ms > 0) meta.duration = ms / 1000;
            break;
          }
          case 'APIC': {
            const picData = extractApicData(head, contentOffset, frameSize);
            if (picData && picData.byteLength > 0) {
              // 拷贝为独立 ArrayBuffer 并 transfer 回主线程
              const ab = new ArrayBuffer(picData.byteLength);
              new Uint8Array(ab).set(picData);
              meta.apic = ab;
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

  // === ID3v1 尾部标签 ===
  if (tail && tail.length >= 128 && tail[0] === 0x54 && tail[1] === 0x41 && tail[2] === 0x47) {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const getString = (start: number, len: number) => {
      const bytes = tail.slice(start, start + len);
      return decoder.decode(bytes).replace(/\x00/g, '').trim();
    };
    if (!meta.title) meta.title = getString(3, 30) || undefined;
    if (!meta.artist) meta.artist = getString(33, 30) || undefined;
    if (!meta.album) meta.album = getString(63, 30) || undefined;
  }

  // === 时长 ===
  if (meta.duration === 0) {
    if (file.format === 'flac' || (head.length >= 4 && head[0] === 0x66 && head[1] === 0x4c)) {
      meta.duration = parseFlacDuration(head, file.size, 'flac');
    } else if (file.format === 'wav') {
      meta.duration = estimateDuration(file.size, 1411);
    } else if (file.format === 'm4a' || file.format === 'aac') {
      meta.duration = estimateDuration(file.size, 128);
    } else if (file.format === 'ogg') {
      meta.duration = estimateDuration(file.size, 160);
    } else {
      meta.duration = estimateDuration(file.size, fallbackBitrateKbps(file.format));
    }
  }

  return meta;
}

// ============ 消息处理 ============

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;

  try {
    if (req.type === 'parse-header') {
      const head = new Uint8Array(req.head);
      const tail = req.tail ? new Uint8Array(req.tail) : null;
      const meta = parseHeaderBytes(head, tail, {
        name: req.fileName,
        size: req.fileSize,
        format: req.format,
      });
      const transfer: ArrayBuffer[] = meta.apic ? [meta.apic] : [];
      (self as unknown as Worker).postMessage({ type: 'parse-header-ok', id: req.id, ...meta }, transfer);
      return;
    }

    if (req.type === 'decode-full') {
      const bytes = decodeBase64Chunked(req.base64);
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      (self as unknown as Worker).postMessage({ type: 'decode-full-ok', id: req.id, bytes: ab }, [ab]);
      return;
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: 'parse-error',
      id: req.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
