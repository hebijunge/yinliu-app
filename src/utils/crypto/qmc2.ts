/**
 * QMC2 流解密器（mflac/mgg → flac/ogg）
 * 基于 musicdl KuwoQmcDecryptor 同源算法（2026-09-04 用酷我《花海》至臻档真实文件实测通过）。
 *
 * 两种 cipher 按密钥长度选择：
 *   - Map cipher（key ≤ 300）：逐字节位置哈希异或
 *   - RC4 cipher（key > 300）：首 128 字节特殊处理 + 5120 字节分段预生成密钥流
 *
 * v23 修复说明：旧实现把 RC4 写成了「标准 RC4 连续流」，实测无法解开酷我任何加密档
 * （连 S-box 对 key>256 的场景都是坏的）。本版为分段算法的正确移植，等效于
 * 「每段从初始 S-box 重新起跑 PRGA、快进 (段内偏移 + 段跳过量) 字节」，用预生成
 * keystream 缓存避免逐段重跑，O(1) 段定位。
 */

const FIRST_SEGMENT_SIZE = 0x80; // 128：文件头特殊区
const OTHER_SEGMENT_SIZE = 0x1400; // 5120：RC4 分段大小

function rotateByte(value: number, bits: number): number {
  const r = (bits + 4) % 8;
  const v = value & 0xff;
  return (((v << r) | (v >>> (8 - r))) & 0xff) & 0xff;
}

/** QMC 哈希（RC4 cipher 的段跳变量种子） */
function qmcHashBase(key: Uint8Array): number {
  let hash = 1;
  for (let i = 0; i < key.length; i++) {
    const v = key[i] & 0xff;
    if (v === 0) continue;
    // uint32 环绕（hash*v ≤ ~2^40，float64 精确，>>>0 取模 2^32）
    const next = (hash * v) >>> 0;
    if (next === 0 || next <= hash) break;
    hash = next;
  }
  return hash >>> 0;
}

function getSegmentKey(segmentId: number, seed: number, hash: number): number {
  if (seed === 0) return 0;
  return Math.floor((hash / ((segmentId + 1) * seed)) * 100.0);
}

// ============ Map cipher（key ≤ 300） ============

function decryptMap(data: Uint8Array, key: Uint8Array, offset: number): void {
  const n = key.length;
  if (n === 0) return;
  for (let i = 0; i < data.length; i++) {
    let p = offset + i;
    p = p > 0x7fff ? p % 0x7fff : p;
    const idx = (p * p + 71214) % n;
    data[i] = (data[i] ^ rotateByte(key[idx], idx & 7)) & 0xff;
  }
}

// ============ RC4 cipher（key > 300） ============

class Rc4Cipher {
  private readonly key: Uint8Array;
  private readonly n: number;
  private readonly hash: number;
  private readonly ks: Uint8Array;
  private readonly skipCache = new Map<number, number>();

  constructor(key: Uint8Array) {
    this.key = key;
    this.n = key.length;
    this.hash = qmcHashBase(key);
    // 预生成 keystream：长度 5120 + n（段跳变量 ∈ [0, n)，段内偏移 ∈ [0, 5120)）
    this.ks = new Uint8Array(OTHER_SEGMENT_SIZE + this.n);
    // RC4 KSA（S-box 按字节回绕，与参考实现一致）
    const box = new Uint8Array(this.n);
    for (let i = 0; i < this.n; i++) box[i] = i & 0xff;
    let j = 0;
    for (let i = 0; i < this.n; i++) {
      j = (j + box[i] + (key[i] & 0xff)) % this.n;
      const tmp = box[i];
      box[i] = box[j];
      box[j] = tmp;
    }
    // PRGA：从初始状态连续生成（等效于每段重新起跑后快进）
    let i = 0;
    let k = 0;
    for (let x = 0; x < this.ks.length; x++) {
      i = (i + 1) % this.n;
      k = (box[i] + k) % this.n;
      const tmp = box[i];
      box[i] = box[k];
      box[k] = tmp;
      this.ks[x] = box[(box[i] + box[k]) % this.n];
    }
  }

  /** 段跳变量：hash/((segId+1)*seed)*100 取整后对 key 长度取模 */
  private skipOf(segmentId: number): number {
    const cached = this.skipCache.get(segmentId);
    if (cached !== undefined) return cached;
    const seed = this.key[segmentId % this.n] & 0xff;
    const skip = seed === 0 ? 0 : getSegmentKey(segmentId, seed, this.hash) % this.n;
    this.skipCache.set(segmentId, skip);
    return skip;
  }

  decrypt(data: Uint8Array, offset: number): void {
    let pos = 0;
    let off = offset;

    // 1. 首 128 字节特殊区：data[i] ^= key[skipOf(绝对偏移)]
    if (off < FIRST_SEGMENT_SIZE) {
      const len = Math.min(FIRST_SEGMENT_SIZE - off, data.length);
      for (let i = 0; i < len; i++) {
        data[pos + i] = (data[pos + i] ^ this.key[this.skipOf(off + i)]) & 0xff;
      }
      pos += len;
      off += len;
    }

    // 2. 分段：ksIndex = 段跳变量 + 段内偏移
    while (pos < data.length) {
      const segId = Math.floor(off / OTHER_SEGMENT_SIZE);
      const blockOffset = off % OTHER_SEGMENT_SIZE;
      const skip = this.skipOf(segId);
      const len = Math.min(data.length - pos, OTHER_SEGMENT_SIZE - blockOffset);
      for (let i = 0; i < len; i++) {
        data[pos + i] = (data[pos + i] ^ this.ks[skip + blockOffset + i]) & 0xff;
      }
      pos += len;
      off += len;
    }
  }
}

// ============ 对外 API ============

/**
 * 解密 QMC2 加密数据（原地修改）
 * @param data   加密数据字节数组（原地修改）
 * @param key    QMC 原始密钥（deriveRawKey 派生）
 * @param offset 数据在完整文件中的绝对偏移（流式分段解密需要）
 */
export function qmc2Decrypt(data: Uint8Array, key: Uint8Array, offset = 0): void {
  if (key.length === 0 || data.length === 0) return;
  if (key.length <= 300) {
    decryptMap(data, key, offset);
  } else {
    new Rc4Cipher(key).decrypt(data, offset);
  }
}

/**
 * 创建 QMC2 流式解密 TransformStream（B7：在线播放边下载边解密）
 * cipher 在流开始时构建一次，逐块按绝对偏移解密（RC4 分段算法依赖绝对 offset）
 */
export function createQmc2DecryptStream(key: Uint8Array): TransformStream<Uint8Array, Uint8Array> {
  if (key.length === 0) {
    throw new Error('QMC2 密钥不能为空');
  }
  // RC4 cipher 预生成 keystream 只做一次；Map cipher 无状态
  const rc4 = key.length > 300 ? new Rc4Cipher(key) : null;
  let totalOffset = 0;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const plain = new Uint8Array(chunk);
      if (rc4) {
        rc4.decrypt(plain, totalOffset);
      } else {
        decryptMap(plain, key, totalOffset);
      }
      totalOffset += chunk.length;
      controller.enqueue(plain);
    },
  });
}

/**
 * 解密整个文件（快捷入口）
 * @param data 加密数据
 * @param key  QMC 原始密钥
 * @returns    解密后的新数组
 */
export function qmc2DecryptBytes(data: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(data);
  qmc2Decrypt(out, key, 0);
  return out;
}

/**
 * 检查解密后数据是否为合法的 flac/ogg 魔数
 */
export function isDecryptedMagic(data: Uint8Array): boolean {
  if (data.length < 4) return false;
  const flac = data[0] === 0x66 && data[1] === 0x4c && data[2] === 0x61 && data[3] === 0x43;
  const ogg = data[0] === 0x4f && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53;
  return flac || ogg;
}
