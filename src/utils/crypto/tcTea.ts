/**
 * 腾讯 TEA-CBC 解密（tc_tea，16 轮 QQ 变体）
 *
 * 用于酷我 ekey 的 QMC 原始密钥派生链（KuwoEkeyDecoder 第二/三段）：
 *   - ekey DES 解密后尾部的 base64 → base64 解码（可选 "QQMusic EncV2,Key:" 前缀二次 TEA）
 *   - 标准 QMC v1 派生：simpleKey 与密钥头 8 字节交错组成 TEA key，TEA-CBC 解密剩余部分
 *
 * 算法参考：musicdl KuwoQmcDecryptor._tencent_tea / unlock-music tc_tea.cpp。
 */

const TEA_DELTA = 0x9e3779b9;
const TEA_ROUNDS = 16;
const SALT_LEN = 2;
const ZERO_LEN = 7;

function readU32BE(buf: Uint8Array, off: number): number {
  return (
    (((buf[off] & 0xff) << 24) |
      ((buf[off + 1] & 0xff) << 16) |
      ((buf[off + 2] & 0xff) << 8) |
      (buf[off + 3] & 0xff)) >>> 0
  );
}

function writeU32BE(buf: Uint8Array, off: number, v: number): void {
  buf[off] = (v >>> 24) & 0xff;
  buf[off + 1] = (v >>> 16) & 0xff;
  buf[off + 2] = (v >>> 8) & 0xff;
  buf[off + 3] = v & 0xff;
}

/** 单块 TEA 解密（8 字节 → 8 字节），全部 uint32 环绕运算 */
function decryptBlock(blockHi: number, blockLo: number, k: number[]): [number, number] {
  let y = blockHi >>> 0;
  let z = blockLo >>> 0;
  let sum = (TEA_DELTA * TEA_ROUNDS) >>> 0;
  for (let round = 0; round < TEA_ROUNDS; round++) {
    const t1 = ((((y << 4) >>> 0) + k[2]) >>> 0) ^ ((y + sum) >>> 0) ^ (((y >>> 5) + k[3]) >>> 0);
    z = (z - t1) >>> 0;
    const t0 = ((((z << 4) >>> 0) + k[0]) >>> 0) ^ ((z + sum) >>> 0) ^ (((z >>> 5) + k[1]) >>> 0);
    y = (y - t0) >>> 0;
    sum = (sum - TEA_DELTA) >>> 0;
  }
  return [y, z];
}

/**
 * 腾讯 TEA-CBC 解密。
 * @param data 密文（长度须为 8 的倍数且 ≥16）
 * @param key  16 字节 TEA 密钥
 * @returns 去除填充后的明文；格式校验失败返回 null
 */
export function tcTeaDecrypt(data: Uint8Array, key: Uint8Array): Uint8Array | null {
  if (data.length % 8 !== 0 || data.length < 16 || key.length !== 16) return null;

  const k = [
    readU32BE(key, 0),
    readU32BE(key, 4),
    readU32BE(key, 8),
    readU32BE(key, 12),
  ];

  const plain = new Uint8Array(data.length);
  let iv1Hi = 0, iv1Lo = 0; // 前一块密文
  let iv2Hi = 0, iv2Lo = 0; // 前一块明文
  let off = 0;
  while (off < data.length) {
    const cHi = readU32BE(data, off);
    const cLo = readU32BE(data, off + 4);
    const xHi = (cHi ^ iv2Hi) >>> 0;
    const xLo = (cLo ^ iv2Lo) >>> 0;
    const [dHi, dLo] = decryptBlock(xHi, xLo, k);
    writeU32BE(plain, off, (dHi ^ iv1Hi) >>> 0);
    writeU32BE(plain, off + 4, (dLo ^ iv1Lo) >>> 0);
    iv1Hi = cHi;
    iv1Lo = cLo;
    iv2Hi = dHi;
    iv2Lo = dLo;
    off += 8;
  }

  // 填充格式：1 字节(padSize 高5位必须为0) + padSize 字节 + 2 字节 salt + 正文 + 7 字节 0
  const padSize = plain[0] & 0x07;
  const start = 1 + padSize + SALT_LEN;
  const end = data.length - ZERO_LEN;
  if (end <= start) return null;
  for (let i = end; i < plain.length; i++) {
    if (plain[i] !== 0) return null;
  }
  return plain.slice(start, end);
}

/** simpleKey：int(|tan(106 + i*0.1) * 100|)，QMC v1 派生固定盐 */
export function qmcSimpleKey(length = 8): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Math.floor(Math.abs(Math.tan(106 + i * 0.1) * 100.0)) & 0xff;
  }
  return out;
}
