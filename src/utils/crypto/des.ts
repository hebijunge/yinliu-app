/**
 * 酷我魔改 DES-ECB/NoPadding —— 用于 ekey 解密（密钥 ylzsxkwm）
 *
 * ⚠️ 这不是标准 DES。酷我在客户端使用了一组自定义置换/S盒（小端位流约定、
 *    EXP 表含重复位、KPC2 表含无效位），标准 DES 对同一密文解出的是乱码
 *    （2026-09-04 实测：标准 DES（含 pycryptodome）解《花海》至臻档 ekey
 *    得到乱码，本实现解出 ASCII+base64 结构，与 musicdl KuwoQmcDecryptor 一致）。
 *
 * 算法参考：musicdl KuwoQmcDecryptor._des_round_keys / _des_block（Python 实测通过）。
 * 移植要点：
 *   - int.from_bytes(key, 'little')：小端位流
 *   - _shuffle(table, bits, value)：按表逐位重排，表项 <0 时跳过（输出该位为 0）
 *   - 16 轮 ROT/ROT_MASK 循环移位；解密方向轮密钥反转
 *   - SBOX 8×64，每字节取 6 位出 4 位，按 (b*4) 位置拼装
 */

const KUWO_KEY = new Uint8Array([0x79, 0x6c, 0x7a, 0x73, 0x78, 0x6b, 0x77, 0x6d]); // 'ylzsxkwm'

const EXP = [
  31, 0, 1, 2, 3, 4, -1, -1, 3, 4, 5, 6, 7, 8, -1, -1,
  7, 8, 9, 10, 11, 12, -1, -1, 11, 12, 13, 14, 15, 16, -1, -1,
  15, 16, 17, 18, 19, 20, -1, -1, 19, 20, 21, 22, 23, 24, -1, -1,
  23, 24, 25, 26, 27, 28, -1, -1, 27, 28, 29, 30, 31, 30, -1, -1,
];

const IPERM = [
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
  56, 48, 40, 32, 24, 16, 8, 0, 58, 50, 42, 34, 26, 18, 10, 2,
  60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6,
];

const FPERM = [
  39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30,
  37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28,
  35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26,
  33, 1, 41, 9, 49, 17, 57, 25, 32, 0, 40, 8, 48, 16, 56, 24,
];

const ROUND_P = [
  15, 6, 19, 20, 28, 11, 27, 16, 0, 14, 22, 25, 4, 17, 30, 9,
  1, 7, 23, 13, 31, 26, 2, 8, 18, 12, 29, 5, 21, 10, 3, 24,
];

const KPC1 = [
  56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1,
  58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 62, 54, 46, 38,
  30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 60, 52, 44, 36,
  28, 20, 12, 4, 27, 19, 11, 3,
];

const KPC2 = [
  13, 16, 10, 23, 0, 4, -1, -1, 2, 27, 14, 5, 20, 9, -1, -1,
  22, 18, 11, 3, 25, 7, -1, -1, 15, 6, 26, 19, 12, 1, -1, -1,
  40, 51, 30, 36, 46, 54, -1, -1, 29, 39, 50, 44, 32, 47, -1, -1,
  43, 48, 38, 55, 33, 52, -1, -1, 45, 41, 49, 35, 28, 31, -1, -1,
];

const ROT = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const ROT_MASK = [0n, 0x100001n, 0x300003n];

const SBOX: number[][] = [
  [14,4,3,15,2,13,5,3,13,14,6,9,11,2,0,5,4,1,10,12,15,6,9,10,1,8,12,7,8,11,7,0,0,15,10,5,14,4,9,10,7,8,12,3,13,1,3,6,15,12,6,11,2,9,5,0,4,2,11,14,1,7,8,13],
  [15,0,9,5,6,10,12,9,8,7,2,12,3,13,5,2,1,14,7,8,11,4,0,3,14,11,13,6,4,1,10,15,3,13,12,11,15,3,6,0,4,10,1,7,8,4,11,14,13,8,0,6,2,15,9,5,7,1,10,12,14,2,5,9],
  [10,13,1,11,6,8,11,5,9,4,12,2,15,3,2,14,0,6,13,1,3,15,4,10,14,9,7,12,5,0,8,7,13,1,2,4,3,6,12,11,0,13,5,14,6,8,15,2,7,10,8,15,4,9,11,5,9,0,14,3,10,7,1,12],
  [7,10,1,15,0,12,11,5,14,9,8,3,9,7,4,8,13,6,2,1,6,11,12,2,3,0,5,14,10,13,15,4,13,3,4,9,6,10,1,12,11,0,2,5,0,13,14,2,8,15,7,4,15,1,10,7,5,6,12,11,3,8,9,14],
  [2,4,8,15,7,10,13,6,4,1,3,12,11,7,14,0,12,2,5,9,10,13,0,3,1,11,15,5,6,8,9,14,14,11,5,6,4,1,3,10,2,12,15,0,13,2,8,5,11,8,0,15,7,14,9,4,12,7,10,9,1,13,6,3],
  [12,9,0,7,9,2,14,1,10,15,3,4,6,12,5,11,1,14,13,0,2,8,7,13,15,5,4,10,8,3,11,6,10,4,6,11,7,9,0,6,4,2,13,1,9,15,3,8,15,3,1,14,12,5,11,0,2,12,14,7,5,10,8,13],
  [4,1,3,10,15,12,5,0,2,11,9,6,8,7,6,9,11,4,12,15,0,3,10,5,14,13,7,8,13,14,1,2,13,6,14,9,4,1,2,14,11,13,5,0,1,10,8,3,0,11,3,5,9,4,15,2,7,8,12,15,10,7,6,12],
  [13,7,10,0,6,9,5,15,8,4,3,10,11,14,12,5,2,11,9,6,15,12,0,3,4,1,14,13,1,2,7,8,1,2,12,15,10,4,0,3,13,14,6,9,7,8,9,6,15,1,5,12,3,10,14,5,8,7,11,0,4,13,2,11],
];

/** 按表逐位重排：out.p = value.table[p]，表项 <0 时该位为 0 */
function shuffle(table: number[], bits: number, value: bigint): bigint {
  let out = 0n;
  for (let p = 0; p < bits; p++) {
    const s = table[p];
    if (s >= 0) {
      out |= ((value >> BigInt(s)) & 1n) << BigInt(p);
    }
  }
  return out;
}

/** 小端读取 8 字节为 BigInt */
function readU64LE(b: Uint8Array, off = 0): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]);
  return v;
}

function desRoundKeys(key: Uint8Array, decrypt: boolean): bigint[] {
  if (key.length !== 8) throw new Error('DES key must be 8 bytes');
  let cv = shuffle(KPC1, 56, readU64LE(key));
  const keys: bigint[] = [];
  for (const amt of ROT) {
    const m = ROT_MASK[amt];
    cv = ((cv & m) << BigInt(28 - amt)) | ((cv & ~m) >> BigInt(amt));
    keys.push(shuffle(KPC2, 64, cv));
  }
  return decrypt ? keys.slice().reverse() : keys;
}

function desBlock(block: Uint8Array, roundKeys: bigint[]): Uint8Array {
  const v = shuffle(IPERM, 64, readU64LE(block));
  let lo = Number(v & 0xFFFFFFFFn);
  let hi = Number((v >> 32n) & 0xFFFFFFFFn);
  for (const rk of roundKeys) {
    const e = shuffle(EXP, 64, BigInt(hi)) ^ rk;
    let s = 0;
    for (let b = 0; b < 8; b++) {
      s |= SBOX[b][Number((e >> BigInt(b * 8)) & 0x3Fn)] << (b * 4);
    }
    const prevLo = lo;
    lo = hi;
    hi = (prevLo ^ Number(shuffle(ROUND_P, 32, BigInt(s)))) >>> 0;
  }
  const pre = (BigInt(lo >>> 0) << 32n) | BigInt(hi >>> 0);
  const fp = shuffle(FPERM, 64, pre);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((fp >> BigInt(i * 8)) & 0xFFn); // little-endian
  return out;
}

/**
 * 酷我魔改 DES-ECB/NoPadding 解密（密钥固定 ylzsxkwm，由调用方传入）
 * @param data 密文（长度须为 8 的倍数，多余尾部字节被忽略）
 * @param key 8 字节密钥
 */
export function desEcbDecrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const roundKeys = desRoundKeys(key, true);
  const blockLen = data.length - (data.length % 8);
  const out = new Uint8Array(blockLen);
  for (let off = 0; off < blockLen; off += 8) {
    out.set(desBlock(data.subarray(off, off + 8), roundKeys), off);
  }
  return out;
}

export { KUWO_KEY };
