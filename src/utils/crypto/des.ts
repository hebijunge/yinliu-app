/**
 * 精简但正确的 DES-ECB/NoPadding 实现（基于 BigInt，避免 JS 32 位有符号溢出）
 * 用于酷我 KuwoEkeyDecoder：ekey(base64) → DES解密（密钥 ylzsxkwm）→ QMC原始密钥
 *
 * 算法：标准 Feistel 网络，16轮，56位密钥，64位分组，NoPadding
 */

// ========== 标准 DES 查表 ==========

const IP = [
  58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,
  62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,
  57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,
  61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7,
];

const FP = [
  40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,
  38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,
  36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,
  34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25,
];

const E = [
  32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,
  12,13,14,15,16,17,16,17,18,19,20,21,20,21,22,23,24,25,
  24,25,26,27,28,29,28,29,30,31,32,1,
];

const P = [
  16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,
  2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25,
];

const S = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
];

const PC1 = [
  57,49,41,33,25,17,9,1,58,50,42,34,26,18,
  10,2,59,51,43,35,27,19,11,3,60,52,44,36,
  63,55,47,39,31,23,15,7,62,54,46,38,30,22,
  14,6,61,53,45,37,29,21,13,5,28,20,12,4,
];

const PC2 = [
  14,17,11,24,1,5,3,28,15,6,21,10,
  23,19,12,4,26,8,16,7,27,20,13,2,
  41,52,31,37,47,55,30,40,51,45,33,48,
  44,49,39,56,34,53,46,42,50,36,29,32,
];

const SHIFTS = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];

// ========== BigInt 辅助函数 ==========

function permuteBI(input: bigint, table: number[], n: number): bigint {
  let out = 0n;
  for (let i = 0; i < table.length; i++) {
    const bit = (input >> BigInt(n - table[i])) & 1n;
    out = (out << 1n) | bit;
  }
  return out;
}

function fBI(right: bigint, subkey: bigint): bigint {
  // 扩展置换 E: 32 → 48
  let expanded = 0n;
  for (let i = 0; i < 48; i++) {
    const bit = (right >> BigInt(32 - E[i])) & 1n;
    expanded = (expanded << 1n) | bit;
  }
  // 与子密钥异或
  const xored = expanded ^ subkey;
  // S盒替换
  let sOut = 0n;
  for (let i = 0; i < 8; i++) {
    const chunk = Number((xored >> BigInt(42 - i * 6)) & 0x3Fn);
    const row = ((chunk >> 4) & 2) | (chunk & 1);
    const col = (chunk >> 1) & 0xF;
    sOut = (sOut << 4n) | BigInt(S[i][row * 16 + col]);
  }
  // P置换
  let pOut = 0n;
  for (let i = 0; i < 32; i++) {
    const bit = (sOut >> BigInt(32 - P[i])) & 1n;
    pOut = (pOut << 1n) | bit;
  }
  return pOut;
}

function generateSubkeysBI(key64: bigint): bigint[] {
  // PC1: 64 → 56
  const key56 = permuteBI(key64, PC1, 64);
  let c = (key56 >> 28n) & 0xFFFFFFFn;
  let d = key56 & 0xFFFFFFFn;
  const subkeys: bigint[] = [];
  for (let i = 0; i < 16; i++) {
    const shift = SHIFTS[i];
    c = ((c << BigInt(shift)) | (c >> BigInt(28 - shift))) & 0xFFFFFFFn;
    d = ((d << BigInt(shift)) | (d >> BigInt(28 - shift))) & 0xFFFFFFFn;
    const cd = (c << 28n) | d;
    // PC2: 56 → 48
    subkeys.push(permuteBI(cd, PC2, 56));
  }
  return subkeys;
}

function desBlockBI(block64: bigint, subkeys: bigint[], decrypt: boolean): bigint {
  // 初始置换 IP
  const ip = permuteBI(block64, IP, 64);
  let left = (ip >> 32n) & 0xFFFFFFFFn;
  let right = ip & 0xFFFFFFFFn;
  // 16轮Feistel
  for (let i = 0; i < 16; i++) {
    const sk = decrypt ? subkeys[15 - i] : subkeys[i];
    const newRight = left ^ fBI(right, sk);
    left = right;
    right = newRight;
  }
  // 交换并逆初始置换 FP
  const preFp = ((right & 0xFFFFFFFFn) << 32n) | (left & 0xFFFFFFFFn);
  return permuteBI(preFp, FP, 64);
}

// ========== 对外接口 ==========

/**
 * DES-ECB 解密（NoPadding）
 * @param data 密文字节（必须是8字节倍数）
 * @param key  密钥字节（8字节）
 * @returns    明文字节
 */
export function desEcbDecrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== 8) throw new Error('DES key must be 8 bytes');
  if (data.length % 8 !== 0) throw new Error('DES data must be multiple of 8 bytes');

  // 将密钥转为64位BigInt
  let key64 = 0n;
  for (let i = 0; i < 8; i++) {
    key64 = (key64 << 8n) | BigInt(key[i] & 0xFF);
  }
  const subkeys = generateSubkeysBI(key64);

  const out = new Uint8Array(data.length);
  for (let b = 0; b < data.length; b += 8) {
    let block64 = 0n;
    for (let i = 0; i < 8; i++) {
      block64 = (block64 << 8n) | BigInt(data[b + i] & 0xFF);
    }
    const plain64 = desBlockBI(block64, subkeys, true);
    for (let i = 0; i < 8; i++) {
      out[b + i] = Number((plain64 >> BigInt(56 - i * 8)) & 0xFFn);
    }
  }
  return out;
}
