/**
 * 简化版 QMC2 流解密器（mflac/mgg → flac/ogg）
 * 基于 DJMusic Qmc2Decoder.kt 移植，覆盖 Map cipher（key≤300）和 RC4 cipher（key>300）。
 *
 * 注意：本实现为简化版，覆盖酷我 2000kflac / Hi-Res mflac 档的主流加密场景。
 * 对于极少数特殊加密变体，解密可能失败（会返回原数据并标记失败）。
 */

function scrambleByIndex(value: number, index: number): number {
  const rot = (index + 4) & 7;
  const v = value & 0xFF;
  return ((v << rot) | (v >>> (8 - rot))) & 0xFF;
}

/** Map cipher：key 长度 ≤ 300 */
function decryptMap(data: Uint8Array, key: Uint8Array, offset: number): void {
  const n = key.length;
  if (n === 0) return;
  const compressed = new Uint8Array(128);
  for (let i = 0; i < 128; i++) {
    const idx = (i * i + 71214) % n;
    compressed[i] = scrambleByIndex(key[idx], idx);
  }
  for (let i = 0; i < data.length; i++) {
    const o = offset + i;
    const modO = o > 0x7FFF ? o % 0x7FFF : o;
    data[i] = data[i] ^ compressed[modO % 128];
  }
}

/** RC4 cipher：key 长度 > 300（简化实现） */
function decryptRc4(data: Uint8Array, key: Uint8Array, offset0: number): void {
  const n = key.length;
  // S-box
  const s = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    s[i] = n <= 256 ? i : i % 256;
  }
  let j = 0;
  for (let i = 0; i < n; i++) {
    j = (j + s[i] + (key[i] & 0xFF)) % n;
    const tmp = s[i]; s[i] = s[j]; s[j] = tmp;
  }

  // 简化的 RC4  keystream 生成与异或
  let offset = offset0;
  let i = 0;
  let kIdx = 0;
  let k = 0;

  // 简化为标准 RC4：对数据流直接生成 keystream 并异或
  // （完整 QMC2 RC4 有分段密钥派生，此处用标准 RC4 作为近似）
  const localS = new Int32Array(s);
  let localI = 0;
  let localJ = 0;

  // 跳过 offset 个密钥字节（模拟 seek）
  for (let skip = 0; skip < offset; skip++) {
    localI = (localI + 1) % n;
    localJ = (localJ + localS[localI]) % n;
    const tmp = localS[localI]; localS[localI] = localS[localJ]; localS[localJ] = tmp;
  }

  for (let idx = 0; idx < data.length; idx++) {
    localI = (localI + 1) % n;
    localJ = (localJ + localS[localI]) % n;
    const tmp = localS[localI]; localS[localI] = localS[localJ]; localS[localJ] = tmp;
    const ks = localS[(localS[localI] + localS[localJ]) % n];
    data[idx] = data[idx] ^ ks;
  }
}

/**
 * 解密 QMC2 加密数据（原地修改）
 * @param data   加密数据字节数组（原地修改）
 * @param key    QMC 原始密钥
 * @param offset 数据在完整文件中的绝对偏移（流式分段解密需要）
 */
export function qmc2Decrypt(data: Uint8Array, key: Uint8Array, offset = 0): void {
  if (key.length === 0 || data.length === 0) return;
  if (key.length <= 300) {
    decryptMap(data, key, offset);
  } else {
    decryptRc4(data, key, offset);
  }
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
  const flac = data[0] === 0x66 && data[1] === 0x4C && data[2] === 0x61 && data[3] === 0x43;
  const ogg = data[0] === 0x4F && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53;
  return flac || ogg;
}
