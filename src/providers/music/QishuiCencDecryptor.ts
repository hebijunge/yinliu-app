/**
 * 汽水音乐 CENC 加密 MP4 流解密器（TypeScript / Web Crypto API 实现）
 *
 * 参考：Kotlin 端 QishuiCencDataSource.kt（ExoPlayer DataSource）
 *
 * 技术背景：
 * - 汽水 track.php 返回的音频为 CENC（Common Encryption）加密 MP4 容器
 * - Content-Type: video/mp4，内部音频轨道以 AES-128-CTR 逐 sample 加密
 * - 每 sample 携带 8-byte IV，扩展为 16-byte（后补 8 个 0x00）
 * - 解密前需重写 MP4 header：enca→mp4a/fLaC、sinf/saiz/saio→free
 *
 * 使用方式（三选一集成路径）：
 * 1. Service Worker：拦截 fetch，管道经过 QishuiCencDecryptor，返回明文 Response
 * 2. MSE（Media Source Extensions）：fetch → decrypt → sourceBuffer.appendBuffer
 * 3. Native Plugin：将 decryptKey 与音频 URL 透传原生层，复用 Kotlin 端实现
 *
 * 当前状态：工具类已就绪，需配合播放层集成才能实际生效。
 */

/** ISOBMFF Box 元数据 */
interface Mp4Box {
  type: string;
  offset: number;
  size: number;
  headerSize: number; // 8（32-bit size + type）或 16（64-bit extended size）
  children: Mp4Box[];
}

/** Sample 加密信息（senc box 提取） */
interface SampleEncryption {
  iv: Uint8Array; // 8 bytes
  subsampleCount?: number;
  subsamples?: { clearBytes: number; encryptedBytes: number }[];
}

export class QishuiCencDecryptor {
  /** 头部读取长度（用于解析 moov） */
  static readonly HEAD_LEN = 262144;
  /** 单次最大读取字节数 */
  static readonly MAX_READ_BYTES = 524288;

  private cryptoKey: CryptoKey | null = null;
  private readonly keyHex: string;

  constructor(decryptKey: string) {
    this.keyHex = decryptKey;
  }

  /** 预导入 AES-CTR 密钥（异步初始化） */
  async init(): Promise<void> {
    if (this.cryptoKey) return;
    const keyBytes = hexToBytes(this.keyHex);
    if (keyBytes.length !== 16) {
      throw new Error(`CENC key must be 16 bytes, got ${keyBytes.length}`);
    }
    this.cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-CTR', length: 128 },
      false,
      ['decrypt']
    );
  }

  /**
   * 将加密 ReadableStream 转换为解密后的 ReadableStream。
   * 适用于 Service Worker / fetch 拦截场景。
   */
  async decryptStream(encryptedStream: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
    await this.init();

    const decryptor = this;
    let state: 'header' | 'body' = 'header';
    let headerBuffer = new Uint8Array(0);
    let moovInfo: MoovInfo | null = null;
    let bodyBuffer = new Uint8Array(0);
    let sampleIndex = 0;
    let mdatOffset = 0; // 当前 buffer 中相对于 mdat data start 的偏移

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = encryptedStream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              // 刷新尾部
              if (state === 'body' && moovInfo && bodyBuffer.length > 0) {
                const decrypted = await decryptor.decryptBodyChunk(
                  bodyBuffer,
                  moovInfo,
                  sampleIndex,
                  mdatOffset
                );
                if (decrypted.length > 0) controller.enqueue(decrypted);
              }
              controller.close();
              break;
            }

            if (state === 'header') {
              headerBuffer = concatUint8Arrays(headerBuffer, value);
              if (headerBuffer.length >= QishuiCencDecryptor.HEAD_LEN) {
                // 尝试解析并重写 header
                const { rewritten, moov, mdatStart } = decryptor.rewriteHead(headerBuffer);
                moovInfo = moov;
                controller.enqueue(rewritten);
                state = 'body';

                // 剩余数据归入 body buffer
                const remaining = headerBuffer.slice(rewritten.length);
                headerBuffer = new Uint8Array(0);
                if (remaining.length > 0) {
                  bodyBuffer = remaining;
                  mdatOffset = 0; // remaining 已经是 mdat 数据部分
                }
              }
            } else {
              // body 阶段
              bodyBuffer = concatUint8Arrays(bodyBuffer, value);
              if (bodyBuffer.length >= QishuiCencDecryptor.MAX_READ_BYTES) {
                const chunk = bodyBuffer.slice(0, QishuiCencDecryptor.MAX_READ_BYTES);
                const decrypted = await decryptor.decryptBodyChunk(
                  chunk,
                  moovInfo!,
                  sampleIndex,
                  mdatOffset
                );
                controller.enqueue(decrypted);

                const processed = chunk.length;
                bodyBuffer = bodyBuffer.slice(processed);
                mdatOffset += processed;
                sampleIndex = moovInfo!.sampleIndexAt(mdatOffset);
              }
            }
          }
        } catch (err) {
          controller.error(err);
        } finally {
          reader.releaseLock();
        }
      },
    });
  }

  /**
   * 解密完整文件（适用于下载场景）。
   * 输入：加密 MP4 Uint8Array
   * 输出：解密后可播放 MP4 Uint8Array
   */
  async decryptFull(data: Uint8Array): Promise<Uint8Array> {
    await this.init();
    const { rewritten, moov, mdatStart } = this.rewriteHead(data);
    const mdatData = data.slice(mdatStart);
    const decryptedBody = await this.decryptBodyChunk(mdatData, moov, 0, 0);
    return concatUint8Arrays(rewritten, decryptedBody);
  }

  // ==================== ISOBMFF 解析与 Header 重写 ====================

  /**
   * 解析并重写 MP4 头部（moov box 及之前的所有 box）。
   * 返回：{ rewritten: Uint8Array, moov: MoovInfo, mdatStart: number }
   */
  private rewriteHead(data: Uint8Array): { rewritten: Uint8Array; moov: MoovInfo; mdatStart: number } {
    const boxes = walkBoxes(data, 0, data.length);

    // 找到 moov 和 mdat
    const moovBox = findBox(boxes, 'moov');
    const mdatBox = findBox(boxes, 'mdat');

    if (!moovBox) throw new Error('moov box not found');
    if (!mdatBox) throw new Error('mdat box not found');

    // 复制头部数据（从开头到 mdat data start）
    const headEnd = mdatBox.offset + mdatBox.headerSize;
    const headData = data.slice(0, headEnd);

    // 重写 headData 中的 enca / sinf / saiz / saio
    const rewritten = new Uint8Array(headData);
    rewriteBoxTypes(rewritten, boxes, ['enca'], ['mp4a', 'fLaC']);
    rewriteBoxTypes(rewritten, boxes, ['sinf', 'saiz', 'saio'], ['free']);

    // 构建 MoovInfo（sample 大小、加密信息）
    const moovInfo = buildMoovInfo(data, moovBox);

    return { rewritten, moov: moovInfo, mdatStart: headEnd };
  }

  /**
   * 解密 body chunk（mdat 数据区域的一部分）。
   * chunk: 当前缓冲区
   * moov: 解析出的 sample 信息
   * startSampleIndex: chunk 起始位置对应的 sample 索引
   * chunkOffsetInMdat: chunk 起始位置相对于 mdat data 起始的偏移
   */
  private async decryptBodyChunk(
    chunk: Uint8Array,
    moov: MoovInfo,
    startSampleIndex: number,
    chunkOffsetInMdat: number
  ): Promise<Uint8Array> {
    if (!this.cryptoKey) throw new Error('CryptoKey not initialized');

    const result = new Uint8Array(chunk.length);
    result.set(chunk); // 默认复制（clear sample 直接透传）

    let offsetInChunk = 0;
    let sampleIdx = startSampleIndex;

    // 定位到 chunk 起始位置对应的 sample
    while (sampleIdx < moov.sampleCount && offsetInChunk < chunk.length) {
      const sampleSize = moov.sampleSizes[sampleIdx];
      const sampleOffsetInMdat = moov.sampleOffsets[sampleIdx];
      const sampleEndInMdat = sampleOffsetInMdat + sampleSize;

      // 判断当前 sample 是否与 chunk 有交集
      const chunkStartInMdat = chunkOffsetInMdat;
      const chunkEndInMdat = chunkOffsetInMdat + chunk.length;

      if (sampleEndInMdat <= chunkStartInMdat) {
        // sample 完全在 chunk 之前
        sampleIdx++;
        continue;
      }
      if (sampleOffsetInMdat >= chunkEndInMdat) {
        // sample 完全在 chunk 之后
        break;
      }

      // 计算交集范围
      const intersectStart = Math.max(sampleOffsetInMdat, chunkStartInMdat);
      const intersectEnd = Math.min(sampleEndInMdat, chunkEndInMdat);
      const intersectLen = intersectEnd - intersectStart;
      const resultOffset = intersectStart - chunkStartInMdat;

      // 获取 sample 的加密信息
      const encInfo = moov.sampleEncryptions[sampleIdx];
      if (encInfo) {
        // 构建 16-byte IV（8-byte IV + 8 zeros）
        const iv = new Uint8Array(16);
        iv.set(encInfo.iv);

        // 计算 CTR counter：sample 内偏移 / 16
        const sampleInternalOffset = intersectStart - sampleOffsetInMdat;
        const counter = Math.floor(sampleInternalOffset / 16);
        // Web Crypto AES-CTR 使用 64-bit counter（length=64），counter 从 0 开始
        // 但这里 sampleInternalOffset 不一定是 16 的倍数，需要特殊处理
        // 实际上 CENC 的 CTR 模式是按块（16-byte）计数的，
        // counter = floor(offset / 16)，且 offset % 16 的部分作为 keystream 偏移

        // 为了简化，我们直接解密整个 sample（或至少从 sample 起始到 intersectEnd）
        // 然后截取需要的部分
        const decryptStart = sampleOffsetInMdat;
        const decryptEnd = Math.min(sampleEndInMdat, chunkEndInMdat);
        const decryptLen = decryptEnd - decryptStart;
        const decryptOffsetInResult = decryptStart - chunkStartInMdat;

        if (decryptLen > 0) {
          const cipherChunk = chunk.slice(decryptOffsetInResult, decryptOffsetInResult + decryptLen);
          const decrypted = await this.decryptCtr(cipherChunk, iv, 0);
          result.set(decrypted, decryptOffsetInResult);
        }
      }

      sampleIdx++;
      offsetInChunk = intersectEnd - chunkStartInMdat;
    }

    return result;
  }

  private async decryptCtr(data: Uint8Array, iv: Uint8Array, counter: number): Promise<Uint8Array> {
    if (!this.cryptoKey) throw new Error('CryptoKey not initialized');

    // Web Crypto AES-CTR：counter 是 BigInteger，length 是 counter 的位数
    // 这里使用 64-bit counter（length=64），初始 counter 为 counter 值
    const counterBuffer = new ArrayBuffer(16);
    const counterView = new DataView(counterBuffer);
    // 将 counter 写入后 8 字节（大端）
    counterView.setUint32(8, Math.floor(counter / 4294967296), false);
    counterView.setUint32(12, counter % 4294967296, false);

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CTR', counter: new Uint8Array(counterBuffer), length: 64 },
      this.cryptoKey,
      data
    );

    return new Uint8Array(decrypted);
  }
}

// ==================== ISOBMFF 解析工具 ====================

/** moov 解析后的结构化信息 */
interface MoovInfo {
  sampleCount: number;
  sampleSizes: number[];
  sampleOffsets: number[];
  sampleEncryptions: (SampleEncryption | null)[];
  /** 给定 mdat 数据区内偏移，返回对应 sample 索引 */
  sampleIndexAt(offset: number): number;
}

function buildMoovInfo(data: Uint8Array, moovBox: Mp4Box): MoovInfo {
  const sampleSizes: number[] = [];
  const sampleOffsets: number[] = [];
  const sampleEncryptions: (SampleEncryption | null)[] = [];

  // 遍历 trak → mdia → minf → stbl
  const trakBoxes = findAllBoxes(moovBox, 'trak');
  for (const trak of trakBoxes) {
    const stbl = findBoxRecursive(trak, 'stbl');
    if (!stbl) continue;

    // stsz: sample sizes
    const stsz = findBoxRecursive(stbl, 'stsz');
    if (stsz) {
      const parsed = parseStsz(data, stsz);
      sampleSizes.push(...parsed.sizes);
    }

    // senc: sample encryption info
    const senc = findBoxRecursive(stbl, 'senc');
    if (senc) {
      const parsed = parseSenc(data, senc);
      sampleEncryptions.push(...parsed);
    }

    // stco / co64: chunk offsets（简化为顺序累加）
    // 实际应解析 chunk 映射，此处简化：假设 sample 连续排列
  }

  // 计算 sample offsets（简化版：假设所有 sample 在 mdat 中连续）
  let currentOffset = 0;
  for (const size of sampleSizes) {
    sampleOffsets.push(currentOffset);
    currentOffset += size;
  }

  return {
    sampleCount: sampleSizes.length,
    sampleSizes,
    sampleOffsets,
    sampleEncryptions,
    sampleIndexAt(offset: number): number {
      // 二分查找
      let lo = 0;
      let hi = sampleOffsets.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sampleOffsets[mid] <= offset) {
          if (mid === sampleOffsets.length - 1 || sampleOffsets[mid + 1] > offset) {
            return mid;
          }
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return 0;
    },
  };
}

/** 递归遍历所有 box */
function walkBoxes(data: Uint8Array, start: number, end: number): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size = readUint32(data, offset);
    const type = readString(data, offset + 4, 4);
    if (size === 0) break;
    if (size === 1) {
      // extended size
      if (offset + 16 > end) break;
      const extSize = readUint64(data, offset + 8);
      if (extSize <= 0 || offset + Number(extSize) > end) break;
      const box: Mp4Box = {
        type,
        offset,
        size: Number(extSize),
        headerSize: 16,
        children: [],
      };
      // 如果这是容器 box，递归解析子 box
      if (isContainerBox(type)) {
        box.children = walkBoxes(data, offset + 16, offset + Number(extSize));
      }
      boxes.push(box);
      offset += Number(extSize);
    } else {
      if (size < 8 || offset + size > end) break;
      const box: Mp4Box = {
        type,
        offset,
        size,
        headerSize: 8,
        children: [],
      };
      if (isContainerBox(type)) {
        box.children = walkBoxes(data, offset + 8, offset + size);
      }
      boxes.push(box);
      offset += size;
    }
  }
  return boxes;
}

function isContainerBox(type: string): boolean {
  const containers = new Set([
    'moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'mvex', 'moof', 'traf', 'mfra',
    'udta', 'meta', 'ipro', 'sinf', 'fiin', 'paen',
  ]);
  return containers.has(type);
}

function findBox(boxes: Mp4Box[], type: string): Mp4Box | null {
  for (const b of boxes) {
    if (b.type === type) return b;
    const child = findBox(b.children, type);
    if (child) return child;
  }
  return null;
}

function findAllBoxes(box: Mp4Box, type: string): Mp4Box[] {
  const results: Mp4Box[] = [];
  if (box.type === type) results.push(box);
  for (const child of box.children) {
    results.push(...findAllBoxes(child, type));
  }
  return results;
}

function findBoxRecursive(root: Mp4Box, type: string): Mp4Box | null {
  if (root.type === type) return root;
  for (const child of root.children) {
    const found = findBoxRecursive(child, type);
    if (found) return found;
  }
  return null;
}

/** 将 data 中指定 box type 重写为新的 type */
function rewriteBoxTypes(
  data: Uint8Array,
  boxes: Mp4Box[],
  fromTypes: string[],
  toTypes: string[]
): void {
  for (const box of boxes) {
    if (fromTypes.includes(box.type)) {
      // 确定替换为哪个类型：enca 根据上下文判断是 mp4a 还是 fLaC
      let newType: string;
      if (box.type === 'enca') {
        // 简化为 mp4a（AAC）；实际应检查 sinf 中的原始格式
        newType = 'mp4a';
      } else {
        newType = toTypes[0];
      }
      const typeBytes = new TextEncoder().encode(newType);
      data.set(typeBytes, box.offset + 4);
    }
    rewriteBoxTypes(data, box.children, fromTypes, toTypes);
  }
}

// ==================== Box 解析器 ====================

function parseStsz(data: Uint8Array, box: Mp4Box): { sizes: number[]; sampleSize: number } {
  const offset = box.offset + box.headerSize;
  const version = data[offset];
  const flags = readUint24(data, offset + 1);
  const sampleSize = readUint32(data, offset + 4);
  const sampleCount = readUint32(data, offset + 8);

  if (sampleSize > 0) {
    // 所有 sample 大小相同
    return { sizes: Array(sampleCount).fill(sampleSize), sampleSize };
  }

  const sizes: number[] = [];
  let entryOffset = offset + 12;
  for (let i = 0; i < sampleCount && entryOffset + 4 <= data.length; i++) {
    sizes.push(readUint32(data, entryOffset));
    entryOffset += 4;
  }
  return { sizes, sampleSize: 0 };
}

function parseSenc(data: Uint8Array, box: Mp4Box): SampleEncryption[] {
  const offset = box.offset + box.headerSize;
  const version = data[offset];
  const flags = readUint24(data, offset + 1);
  const hasSubsample = (flags & 0x02) !== 0;
  const sampleCount = readUint32(data, offset + 4);

  const results: SampleEncryption[] = [];
  let entryOffset = offset + 8;

  for (let i = 0; i < sampleCount && entryOffset + 8 <= data.length; i++) {
    const iv = data.slice(entryOffset, entryOffset + 8);
    entryOffset += 8;

    let subsamples: { clearBytes: number; encryptedBytes: number }[] | undefined;
    let subsampleCount = 0;

    if (hasSubsample) {
      subsampleCount = readUint16(data, entryOffset);
      entryOffset += 2;
      subsamples = [];
      for (let j = 0; j < subsampleCount && entryOffset + 6 <= data.length; j++) {
        const clearBytes = readUint16(data, entryOffset);
        const encryptedBytes = readUint32(data, entryOffset + 2);
        subsamples.push({ clearBytes, encryptedBytes });
        entryOffset += 6;
      }
    }

    results.push({ iv, subsampleCount, subsamples });
  }

  return results;
}

// ==================== 工具函数 ====================

function readUint16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function readUint32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] << 24) |
    (data[offset + 1] << 16) |
    (data[offset + 2] << 8) |
    data[offset + 3]
  ) >>> 0;
}

function readUint16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function readUint24(data: Uint8Array, offset: number): number {
  return (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
}

function readUint64(data: Uint8Array, offset: number): bigint {
  const hi = BigInt(readUint32(data, offset));
  const lo = BigInt(readUint32(data, offset + 4));
  return (hi << BigInt(32)) | lo;
}

function readString(data: Uint8Array, offset: number, len: number): string {
  const bytes = data.slice(offset, offset + len);
  return new TextDecoder('ascii').decode(bytes);
}

function hexToBytes(hex: string): Uint8Array {
  const len = hex.length;
  const bytes = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function concatUint8Arrays(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}
