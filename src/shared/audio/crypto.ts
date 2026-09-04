/**
 * 音频加密解密工具模块
 * 支持：汽水音乐 CENC+AES-CTR、咪咕 h5v2.4 响应解密、咪咕 Z3D 循环异或解密
 */

// ======== 咪咕 h5v2.4 响应解密 ========

const H5V24_KEY = new TextEncoder().encode('Jk8qzuePiJ1qE3mDYhLQ3T73DtDoAhLP'); // 32字节固定密钥
const H5V24_MAGIC = [0xab, 0xcd, 0x01];

/**
 * 解密咪咕 h5v2.4 加密响应
 * @param raw 接口返回的原始二进制数据
 * @returns 解密后的 JSON 对象
 */
export function decryptH5v24Response(raw: Uint8Array): Record<string, unknown> {
  if (raw.length < 4) {
    throw new Error('h5v2.4 数据长度不足，至少需要4字节');
  }
  if (raw[0] !== H5V24_MAGIC[0] || raw[1] !== H5V24_MAGIC[1] || raw[2] !== H5V24_MAGIC[2]) {
    throw new Error(
      `h5v2.4 魔数校验失败，期望 AB CD 01，实际 ${toHex(raw.slice(0, 3))}`
    );
  }

  const offset = raw[3];
  const cipher = raw.slice(4);
  const plain = new Uint8Array(cipher.length);

  for (let i = 0; i < cipher.length; i++) {
    plain[i] = (cipher[i] + offset - H5V24_KEY[i % H5V24_KEY.length]) & 0xff;
  }

  const text = new TextDecoder('utf-8', { fatal: false }).decode(plain);
  return JSON.parse(text) as Record<string, unknown>;
}

// ======== 咪咕 Z3D 音频解密 ========

const Z3D_KEY_LEN = 32;

/**
 * 通过 3D60 已知明文攻击提取 Z3D 解密密钥
 * @param z3dFirst32 Z3D 密文前32字节
 * @param p3dFirst32 3D60 明文前32字节（标准WAV头）
 * @returns 32字节循环密钥
 */
export function extractZ3dKey(z3dFirst32: Uint8Array, p3dFirst32: Uint8Array): Uint8Array {
  if (z3dFirst32.length < Z3D_KEY_LEN || p3dFirst32.length < Z3D_KEY_LEN) {
    throw new Error('Z3D/3D60 前32字节不足');
  }
  // 验证 3D60 是标准 WAV
  const riff = new TextDecoder().decode(p3dFirst32.slice(0, 4));
  const wave = new TextDecoder().decode(p3dFirst32.slice(8, 12));
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('3D60 不是标准WAV头，无法作为已知明文');
  }

  const key = new Uint8Array(Z3D_KEY_LEN);
  for (let i = 0; i < Z3D_KEY_LEN; i++) {
    key[i] = (z3dFirst32[i] - p3dFirst32[i]) & 0xff;
  }
  return key;
}

/**
 * 解密 Z3D 数据块（循环异或，减法）
 * @param cipher 密文数据（原地修改并返回）
 * @param key 32字节循环密钥
 * @param offset 该块在文件中的绝对偏移（用于循环取密钥下标）
 */
export function decryptZ3dChunk(cipher: Uint8Array, key: Uint8Array, offset = 0): Uint8Array {
  const klen = key.length;
  for (let i = 0; i < cipher.length; i++) {
    const ki = (offset + i) % klen;
    cipher[i] = (cipher[i] - key[ki]) & 0xff;
  }
  return cipher;
}

/**
 * 解密完整的 Z3D 文件
 * @param cipher 完整的 Z3D 密文
 * @param key 32字节循环密钥
 * @returns 解密后的明文（标准 WAV）
 */
export function decryptZ3d(cipher: Uint8Array, key: Uint8Array): Uint8Array {
  return decryptZ3dChunk(new Uint8Array(cipher), key, 0);
}

/**
 * 创建 Z3D 流式解密 TransformStream
 * v21.4: 用于在线播放「边下载边解密边播放」
 * @param key 32字节循环密钥
 * @returns TransformStream<Uint8Array, Uint8Array>
 */
export function createZ3dDecryptStream(key: Uint8Array): TransformStream<Uint8Array, Uint8Array> {
  if (key.length !== Z3D_KEY_LEN) {
    throw new Error(`Z3D 密钥长度必须是 ${Z3D_KEY_LEN} 字节，实际 ${key.length} 字节`);
  }

  let totalOffset = 0;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const plain = new Uint8Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const ki = (totalOffset + i) % Z3D_KEY_LEN;
        plain[i] = (chunk[i] - key[ki]) & 0xff;
      }
      totalOffset += chunk.length;
      controller.enqueue(plain);
    },
  });
}

/**
 * 通过 Range 请求获取 Z3D 解密密钥（3D60 已知明文攻击）
 * v21.4: 播放/下载前调用，提取 32 字节动态密钥
 * @param z3dUrl Z3D 加密音频直链
 * @param p3dUrl 3D60 明文试听直链
 * @param headers 请求头（咪咕需要 birth/channel/Referer 等）
 * @returns 32字节循环密钥
 */
export async function fetchZ3dKey(
  z3dUrl: string,
  p3dUrl: string,
  headers?: Record<string, string>
): Promise<Uint8Array> {
  // 1. Range 请求 3D60 前32字节（已知明文，标准WAV头）
  const p3dResp = await fetch(p3dUrl, {
    method: 'GET',
    headers: { ...headers, Range: 'bytes=0-31' },
  });
  if (!p3dResp.ok) {
    throw new Error(`3D60 前32字节下载失败: ${p3dResp.status}`);
  }
  const p3dFirst32 = new Uint8Array(await p3dResp.arrayBuffer());
  if (p3dFirst32.length < Z3D_KEY_LEN) {
    throw new Error(`3D60 前32字节不足: ${p3dFirst32.length} 字节`);
  }

  // 2. Range 请求 Z3D 前32字节（密文）
  const z3dResp = await fetch(z3dUrl, {
    method: 'GET',
    headers: { ...headers, Range: 'bytes=0-31' },
  });
  if (!z3dResp.ok) {
    throw new Error(`Z3D 前32字节下载失败: ${z3dResp.status}`);
  }
  const z3dFirst32 = new Uint8Array(await z3dResp.arrayBuffer());
  if (z3dFirst32.length < Z3D_KEY_LEN) {
    throw new Error(`Z3D 前32字节不足: ${z3dFirst32.length} 字节`);
  }

  // 3. 已知明文攻击提取密钥
  return extractZ3dKey(z3dFirst32, p3dFirst32);
}

// ======== 汽水音乐 CENC + AES-128-CTR 解密 ========

interface IsobmffBox {
  type: string;
  offset: number;
  size: number;
  data: Uint8Array;
}

interface CencInfo {
  sampleSizes: number[];
  ivs: Uint8Array[];
  /** 每帧的 subsample 明/密分区（null = 整帧加密） */
  subsamples: (CencSubsample[] | null)[];
  mdatOffset: number;
  isFlac: boolean;
  dfLaData?: Uint8Array;
  headerData: Uint8Array;
}

interface CencSubsample {
  /** 明文字节数（未被加密的区域） */
  clear: number;
  /** 密文字节数（AES-CTR 加密区域） */
  encrypted: number;
}

/**
 * 解析 ISOBMFF box（递归）
 * @param data 文件数据
 * @param start 起始偏移
 * @param end 结束偏移
 */
function parseIsobmffBoxes(data: Uint8Array, start = 0, end?: number): IsobmffBox[] {
  const boxes: IsobmffBox[] = [];
  const limit = end ?? data.length;
  const containerTypes = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'sinf', 'dinf']);

  let pos = start;
  while (pos + 8 <= limit) {
    let size = readUint32(data, pos);
    const type = new TextDecoder().decode(data.slice(pos + 4, pos + 8));

    if (size === 0) {
      size = limit - pos;
    } else if (size === 1) {
      // 64-bit size
      if (pos + 16 > limit) break;
      const hi = readUint32(data, pos + 8);
      const lo = readUint32(data, pos + 12);
      size = hi * 0x100000000 + lo;
    }

    if (size < 8 || pos + size > limit) break;

    const boxData = data.slice(pos, pos + size);
    boxes.push({ type, offset: pos, size, data: boxData });

    if (containerTypes.has(type)) {
      const children = parseIsobmffBoxes(data, pos + 8, pos + size);
      boxes.push(...children);
    }

    pos += size;
  }

  return boxes;
}

function readUint32(data: Uint8Array, offset: number): number {
  return (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/**
 * 从 ISOBMFF 数据中提取 CENC 解密所需信息
 * @param headerData 文件头部数据（建议至少 512KB）
 */
function extractCencInfo(headerData: Uint8Array): CencInfo | null {
  const boxes = parseIsobmffBoxes(headerData);

  const mdat = boxes.find((b) => b.type === 'mdat');
  const stsz = boxes.find((b) => b.type === 'stsz');
  const senc = boxes.find((b) => b.type === 'senc');
  const stsd = boxes.find((b) => b.type === 'stsd');

  if (!mdat || !stsz || !senc) {
    return null;
  }

  // 解析 stsz（样本大小表）
  // stsz box: version(1) + flags(3) + sample_size(4) + count(4) + [sizes...]
  const stszData = stsz.data;
  const sampleSize = readUint32(stszData, 12);
  const sampleCount = readUint32(stszData, 16);
  const sampleSizes: number[] = [];

  if (sampleSize !== 0) {
    for (let i = 0; i < sampleCount; i++) {
      sampleSizes.push(sampleSize);
    }
  } else {
    for (let i = 0; i < sampleCount; i++) {
      sampleSizes.push(readUint32(stszData, 20 + i * 4));
    }
  }

  // 解析 senc（每样本 IV）
  // senc box: version(1) + flags(3) + sample_count(4) + [IV(Per_Sample_IV_Size) + subsample 表...]
  const sencData = senc.data;
  // senc 是 full box：data 前 8 字节为 size+type，version/flags 位于偏移 8，
  // sample_count 位于偏移 12（此前误读偏移 0 的 size 字段导致 subsample 标志随机误判）
  const sencFlags = readUint32(sencData, 8) & 0xffffff;
  const hasSubsamples = (sencFlags & 0x02) !== 0;
  const ivCount = readUint32(sencData, 12);

  // tenc（sinf→schi→tenc）提供 default_Per_Sample_IV_Size；缺失时按 8 字节兜底
  const tenc = boxes.find((b) => b.type === 'tenc');
  let ivSize = 8;
  if (tenc && tenc.data.length >= 17) {
    // tenc: size(4) type(4) version(1) flags(3) reserved(2) isProtected(1) ivSize(1) KID(16)
    const tencIvSize = tenc.data[15];
    if (tencIvSize > 0) ivSize = tencIvSize;
  }

  const ivs: Uint8Array[] = [];
  const subsamples: (CencSubsample[] | null)[] = [];
  let sencPos = 16;

  for (let i = 0; i < ivCount; i++) {
    if (sencPos + ivSize > sencData.length) break;
    ivs.push(sencData.slice(sencPos, sencPos + ivSize));
    sencPos += ivSize;

    if (hasSubsamples) {
      if (sencPos + 2 > sencData.length) break;
      const entryCount = (sencData[sencPos] << 8) | sencData[sencPos + 1];
      sencPos += 2;
      const entries: CencSubsample[] = [];
      for (let e = 0; e < entryCount; e++) {
        if (sencPos + 6 > sencData.length) break;
        entries.push({
          clear: (sencData[sencPos] << 8) | sencData[sencPos + 1],
          encrypted: readUint32(sencData, sencPos + 2),
        });
        sencPos += 6;
      }
      subsamples.push(entries.length > 0 ? entries : null);
    } else {
      subsamples.push(null);
    }
  }

  // FLAC 检测：stsd 中是否有 dfLa
  let isFlac = false;
  let dfLaData: Uint8Array | undefined;
  if (stsd) {
    const stsdData = stsd.data;
    for (let i = 0; i < stsdData.length - 4; i++) {
      const t = new TextDecoder().decode(stsdData.slice(i, i + 4));
      if (t === 'dfLa') {
        isFlac = true;
        // dfLa 是完整 box：size 字段位于 type 前面（i-4），载荷只取到 box 末尾，
        // 不得延伸到 stsd 末尾（否则会把 dfLa 之后的 sinf 等字节误当成 FLAC 元数据）
        const dfLaBoxSize = readUint32(stsdData, i - 4);
        const dfLaStart = i + 8; // 跳过 4 字节 type + 4 字节 version/flags
        const dfLaEnd = Math.min(i - 4 + dfLaBoxSize, stsdData.length);
        if (dfLaStart < dfLaEnd) {
          dfLaData = stsdData.slice(dfLaStart, dfLaEnd);
        }
        break;
      }
    }
  }

  return {
    sampleSizes,
    ivs,
    subsamples,
    mdatOffset: mdat.offset + 8, // 跳过 mdat header
    isFlac,
    dfLaData,
    headerData,
  };
}

// CryptoKey 缓存（B7：importKey 提出逐帧循环，每把密钥只导入一次）
const cencKeyCache = new Map<string, CryptoKey>();

async function getCencCryptoKey(keyHex: string): Promise<CryptoKey> {
  const cached = cencKeyCache.get(keyHex);
  if (cached) return cached;
  const key = hexToBytes(keyHex);
  if (key.length !== 16) {
    throw new Error(`CENC 密钥长度必须是16字节，实际 ${key.length} 字节`);
  }
  const cryptoKey = await crypto.subtle.importKey('raw', key as unknown as BufferSource, { name: 'AES-CTR' }, false, ['decrypt']);
  cencKeyCache.set(keyHex, cryptoKey);
  return cryptoKey;
}

/** AES-CTR 整段解密（IV 前 ivSize 字节 + 后补 0 扩展为 16 字节 counter） */
async function decryptAesCtr(
  encrypted: Uint8Array,
  cryptoKey: CryptoKey,
  iv: Uint8Array
): Promise<Uint8Array> {
  const iv16 = new Uint8Array(16);
  iv16.set(iv.subarray(0, Math.min(iv.length, 16)), 0);
  const counter = iv16.slice().buffer as ArrayBuffer;
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter, length: 128 },
    cryptoKey,
    encrypted.slice().buffer as ArrayBuffer,
  );
  return new Uint8Array(decrypted);
}

/**
 * 解密单帧：整帧加密，或按 subsample 明/密分区解密。
 * subsample 模式下所有加密区按 CENC 规范共享同一 keystream（从 IV 连续推进），
 * 实现：把所有加密区拼接成一段做单次 AES-CTR，再按位置拼回。
 */
async function decryptFrame(
  frameCipher: Uint8Array,
  cryptoKey: CryptoKey,
  iv: Uint8Array,
  subsamples: CencSubsample[] | null
): Promise<Uint8Array> {
  if (!subsamples || subsamples.length === 0) {
    return decryptAesCtr(frameCipher, cryptoKey, iv);
  }

  // 收集加密区
  let totalEncrypted = 0;
  for (const s of subsamples) totalEncrypted += s.encrypted;

  const cipherCat = new Uint8Array(totalEncrypted);
  let catPos = 0;
  let framePos = 0;
  for (const s of subsamples) {
    framePos += s.clear;
    if (s.encrypted > 0 && framePos + s.encrypted <= frameCipher.length) {
      cipherCat.set(frameCipher.subarray(framePos, framePos + s.encrypted), catPos);
      catPos += s.encrypted;
    }
    framePos += s.encrypted;
  }

  const plainCat = await decryptAesCtr(cipherCat, cryptoKey, iv);

  // 拼回
  const out = new Uint8Array(frameCipher.length);
  let plainPos = 0;
  framePos = 0;
  for (const s of subsamples) {
    if (framePos + s.clear <= frameCipher.length) {
      out.set(frameCipher.subarray(framePos, framePos + s.clear), framePos);
    }
    framePos += s.clear;
    if (s.encrypted > 0 && framePos + s.encrypted <= frameCipher.length) {
      out.set(plainCat.subarray(plainPos, plainPos + s.encrypted), framePos);
      plainPos += s.encrypted;
    }
    framePos += s.encrypted;
  }
  // 尾部未覆盖区域按明文处理
  if (framePos < frameCipher.length) {
    out.set(frameCipher.subarray(framePos), framePos);
  }
  return out;
}

export interface DecryptedAudio {
  data: Uint8Array;
  format: 'flac' | 'm4a';
  sampleRate?: number;
  channels?: number;
}

/**
 * 解密汽水音乐 CENC 加密 MP4 文件（完整文件，用于下载后解密）
 * @param encryptedData 完整的加密文件数据
 * @param keyHex 16进制 AES 密钥字符串（track.php 返回的 decrypt_key）
 * @returns 解密后的音频数据
 */
export async function decryptCencMp4(
  encryptedData: ArrayBuffer,
  keyHex: string
): Promise<DecryptedAudio> {
  const data = new Uint8Array(encryptedData);
  const key = hexToBytes(keyHex);
  if (key.length !== 16) {
    throw new Error(`CENC 密钥长度必须是16字节，实际 ${key.length} 字节`);
  }

  // 先用前 512KB 解析 box 结构
  const headerLen = Math.min(data.length, 524288);
  const headerData = data.slice(0, headerLen);
  const info = extractCencInfo(headerData);

  if (!info) {
    throw new Error('无法解析 CENC ISOBMFF 结构（缺少 mdat/stsz/senc）');
  }

  const { sampleSizes, ivs, subsamples, mdatOffset, isFlac, dfLaData } = info;

  // 预分配输出缓冲区
  const totalEncryptedSize = sampleSizes.reduce((a, b) => a + b, 0);
  let output: Uint8Array;
  let outputPos = 0;

  if (isFlac) {
    // FLAC: fLaC 头 + dfLa 元数据 + 解密帧
    const flacHeaderSize = 4 + (dfLaData?.length ?? 0);
    output = new Uint8Array(flacHeaderSize + totalEncryptedSize);
    output.set(new TextEncoder().encode('fLaC'), 0);
    outputPos = 4;
    if (dfLaData) {
      output.set(dfLaData, 4);
      outputPos += dfLaData.length;
    }
  } else {
    // M4A: 重写头部（enca→mp4a, sinf/saiz/saio→free）+ 解密后的 mdat
    const headerBytes = data.slice(0, mdatOffset);
    // 替换加密标识为明文标识
    const modifiedHeader = new Uint8Array(headerBytes);
    replaceAllBoxes(modifiedHeader, 'enca', 'mp4a');
    replaceAllBoxes(modifiedHeader, 'sinf', 'free');
    replaceAllBoxes(modifiedHeader, 'saiz', 'free');
    replaceAllBoxes(modifiedHeader, 'saio', 'free');
    replaceAllBoxes(modifiedHeader, 'senc', 'free');

    output = new Uint8Array(modifiedHeader.length + totalEncryptedSize);
    output.set(modifiedHeader, 0);
    outputPos = modifiedHeader.length;
  }

  // 逐帧解密（CryptoKey 已缓存，不再逐帧 importKey）
  const cryptoKey = await getCencCryptoKey(keyHex);
  let mdatPos = mdatOffset;
  const frameCount = Math.min(sampleSizes.length, ivs.length);

  for (let i = 0; i < frameCount; i++) {
    const frameSize = sampleSizes[i];
    const frameCipher = data.slice(mdatPos, mdatPos + frameSize);
    const plain = await decryptFrame(frameCipher, cryptoKey, ivs[i], subsamples[i] ?? null);
    output.set(plain, outputPos);
    outputPos += plain.length;
    mdatPos += frameSize;
  }

  // 截断到实际写入长度
  const finalOutput = output.slice(0, outputPos);

  return {
    data: finalOutput,
    format: isFlac ? 'flac' : 'm4a',
  };
}

/**
 * 在 Uint8Array 中查找并替换所有 4 字节 box type（等长替换）
 */
function replaceAllBoxes(data: Uint8Array, from: string, to: string): void {
  const fromBytes = new TextEncoder().encode(from);
  const toBytes = new TextEncoder().encode(to);
  if (fromBytes.length !== 4 || toBytes.length !== 4) return;

  for (let i = 0; i <= data.length - 4; i++) {
    if (
      data[i] === fromBytes[0] &&
      data[i + 1] === fromBytes[1] &&
      data[i + 2] === fromBytes[2] &&
      data[i + 3] === fromBytes[3]
    ) {
      data[i] = toBytes[0];
      data[i + 1] = toBytes[1];
      data[i + 2] = toBytes[2];
      data[i + 3] = toBytes[3];
    }
  }
}

function hexToBytes(hex: string): Uint8Array {
  const len = hex.length;
  const bytes = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * 创建 CENC 流式解密 TransformStream（用于在线播放「边缓存边解密边播放」）
 * @param keyHex 16进制 AES 密钥
 * @param onProgress 进度回调（已处理字节数, 总字节数）
 * @returns TransformStream<Uint8Array, Uint8Array>
 */
export function createCencDecryptStream(
  keyHex: string,
  onProgress?: (processed: number, total: number) => void
): TransformStream<Uint8Array, Uint8Array> {
  if (hexToBytes(keyHex).length !== 16) {
    throw new Error(`CENC 密钥长度必须是16字节，实际 ${hexToBytes(keyHex).length} 字节`);
  }
  // B7：CryptoKey 在流开始前一次性导入，逐帧解密不再重复 importKey
  const cryptoKeyPromise = getCencCryptoKey(keyHex);

  let buffer = new Uint8Array(0);
  let headerParsed = false;
  let cencInfo: CencInfo | null = null;
  let frameIndex = 0;
  let mdatPos = 0;
  let headerOutput = false;
  let totalSize = 0;
  let processedSize = 0;
  let cryptoKey: CryptoKey | null = null;

  return new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      // 追加到缓冲区
      const newBuffer = new Uint8Array(buffer.length + chunk.length);
      newBuffer.set(buffer, 0);
      newBuffer.set(chunk, buffer.length);
      buffer = newBuffer;
      totalSize = Math.max(totalSize, buffer.length);

      if (!headerParsed) {
        // 需要足够的数据解析 ISOBMFF 头部（至少 512KB 或直到遇到 mdat 数据）
        if (buffer.length < 262144) {
          // 继续缓冲，但如果已经看到 mdat 且知道偏移，可以提前解析
          const mdatIdx = findBoxOffset(buffer, 'mdat');
          if (mdatIdx < 0 || buffer.length < mdatIdx + 8) {
            return; // 数据不足，继续等待
          }
        }

        cencInfo = extractCencInfo(buffer);
        if (!cencInfo) {
          // 仍然解析失败，可能是数据还不够完整
          if (buffer.length < 1048576) {
            return;
          }
          throw new Error('CENC 流式解密：无法在 1MB 内解析 ISOBMFF 头部');
        }

        headerParsed = true;
        mdatPos = cencInfo.mdatOffset;
        frameIndex = 0;

        // 输出重建后的头部
        if (cencInfo.isFlac) {
          const header = new Uint8Array(4 + (cencInfo.dfLaData?.length ?? 0));
          header.set(new TextEncoder().encode('fLaC'), 0);
          if (cencInfo.dfLaData) {
            header.set(cencInfo.dfLaData, 4);
          }
          controller.enqueue(header);
        } else {
          // M4A: 修改头部后输出
          const headerBytes = buffer.slice(0, mdatPos);
          const modifiedHeader = new Uint8Array(headerBytes);
          replaceAllBoxes(modifiedHeader, 'enca', 'mp4a');
          replaceAllBoxes(modifiedHeader, 'sinf', 'free');
          replaceAllBoxes(modifiedHeader, 'saiz', 'free');
          replaceAllBoxes(modifiedHeader, 'saio', 'free');
          replaceAllBoxes(modifiedHeader, 'senc', 'free');
          controller.enqueue(modifiedHeader);
        }

        headerOutput = true;

        // 保留 mdat 之后的数据在缓冲区
        buffer = buffer.slice(mdatPos);
        mdatPos = 0;
      }

      if (!cencInfo) return;

      if (!cryptoKey) {
        cryptoKey = await cryptoKeyPromise;
      }

      // 处理帧：逐帧从缓冲区读取、解密、输出
      const { sampleSizes, ivs, subsamples } = cencInfo;

      while (frameIndex < Math.min(sampleSizes.length, ivs.length)) {
        const frameSize = sampleSizes[frameIndex];
        if (mdatPos + frameSize > buffer.length) {
          break; // 数据不足，等待更多数据
        }

        const frameCipher = buffer.slice(mdatPos, mdatPos + frameSize);
        const plain = await decryptFrame(frameCipher, cryptoKey, ivs[frameIndex], subsamples[frameIndex] ?? null);
        controller.enqueue(plain);

        processedSize += plain.length;
        mdatPos += frameSize;
        frameIndex++;

        if (onProgress) {
          onProgress(processedSize, totalSize);
        }
      }

      // 保留未处理的尾部数据
      buffer = buffer.slice(mdatPos);
      mdatPos = 0;
    },

    flush(controller) {
      // 流结束，输出剩余数据（如果有未完成的帧，可能是填充数据，通常忽略）
      if (buffer.length > 0 && frameIndex >= (cencInfo?.sampleSizes.length ?? 0)) {
        controller.enqueue(buffer);
      }
    },
  });
}

/**
 * 在 Uint8Array 中查找 box type 的偏移位置
 */
function findBoxOffset(data: Uint8Array, type: string): number {
  const typeBytes = new TextEncoder().encode(type);
  for (let i = 0; i <= data.length - 8; i++) {
    const size = readUint32(data, i);
    if (size >= 8 &&
      data[i + 4] === typeBytes[0] &&
      data[i + 5] === typeBytes[1] &&
      data[i + 6] === typeBytes[2] &&
      data[i + 7] === typeBytes[3]) {
      return i;
    }
  }
  return -1;
}

/**
 * 通过 fetch 获取加密音频流并返回解密后的 ReadableStream
 * 用于在线播放：播放器直接使用返回的 ReadableStream
 */
export async function fetchDecryptedAudioStream(
  url: string,
  keyHex: string,
  headers?: Record<string, string>,
  onProgress?: (processed: number, total: number) => void
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(url, { headers });
  if (!response.ok || !response.body) {
    throw new Error(`获取加密音频流失败: ${response.status}`);
  }

  const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
  const decryptStream = createCencDecryptStream(keyHex, onProgress);

  // 将 response.body 通过 decryptStream 转换
  return response.body.pipeThrough(decryptStream);
}

// ======== 通用工具 ========

/**
 * 验证 WAV 头并返回音频参数
 */
export function verifyWavHeader(data: Uint8Array): { valid: boolean; info?: { sampleRate: number; channels: number; bits: number; duration: number } } {
  if (data.length < 44) return { valid: false };

  const riff = new TextDecoder().decode(data.slice(0, 4));
  const wave = new TextDecoder().decode(data.slice(8, 12));
  const fmt = new TextDecoder().decode(data.slice(12, 16));

  if (riff !== 'RIFF' || wave !== 'WAVE' || fmt !== 'fmt ') {
    return { valid: false };
  }

  try {
    const channels = data[22] | (data[23] << 8);
    const sampleRate = (data[24] | (data[25] << 8) | (data[26] << 16) | (data[27] << 24));
    const bits = data[34] | (data[35] << 8);
    const chunkSize = (data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24));
    const byteRate = (sampleRate * channels * bits) / 8;
    const duration = byteRate > 0 ? chunkSize / byteRate : 0;

    return {
      valid: true,
      info: { sampleRate, channels, bits, duration },
    };
  } catch {
    return { valid: false };
  }
}
