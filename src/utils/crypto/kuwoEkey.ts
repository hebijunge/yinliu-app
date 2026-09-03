/**
 * 酷我 KuwoEkeyDecoder —— 至臻/全景声/母带 mflac 档 ekey → QMC 原始密钥
 *
 * 实测（2026-09-04，周杰伦《花海》rid=440615，20201kmflac 档）确认的完整派生链：
 *   1. ekey(base64，952 字符) → base64 解码 → DES-ECB/NoPadding 解密（密钥 ylzsxkwm）
 *   2. 去尾部 NUL 后为 ASCII 文本，取末尾 704（或 364）个字符（该段本身是 base64）
 *   3. base64 解码 → 528 字节；若以 "QQMusic EncV2,Key:" 开头则走 EncV2 双重 TEA 再回到 base64
 *   4. QMC v1 标准派生：simpleKey(tan 固定盐) 与密钥头 8 字节交错组成 TEA key，
 *      TEA-CBC 解密剩余密文，拼接回头部 8 字节 → 最终 QMC 原始密钥（本例 512 字节，>300 → RC4 cipher）
 *
 * 旧实现（直接把 DES 解密结果当 QMC 密钥）实测无法解开任何至臻档文件，已废弃。
 * 算法参考：musicdl KuwoQmcDecryptor（实测通过）、unlock-music tc_tea。
 */

import { desEcbDecrypt } from './des';
import { tcTeaDecrypt, qmcSimpleKey } from './tcTea';

const DES_KEY = new TextEncoder().encode('ylzsxkwm');
const V2_PREFIX = 'QQMusic EncV2,Key:';
const V2_KEY1 = new Uint8Array([
  0x33, 0x38, 0x36, 0x5a, 0x4a, 0x59, 0x21, 0x40,
  0x23, 0x2a, 0x24, 0x25, 0x5e, 0x26, 0x29, 0x28,
]);
const V2_KEY2 = new Uint8Array([
  0x2a, 0x2a, 0x23, 0x21, 0x28, 0x23, 0x24, 0x25,
  0x26, 0x5e, 0x61, 0x31, 0x63, 0x5a, 0x2c, 0x54,
]);
/** ekey DES 解密后尾部 base64 段的合法长度（对应 528 / 273 字节 QMC 原始密钥） */
const RAW_KEY_B64_LENGTHS = [704, 364] as const;

/**
 * 由 base64 ekey 派生 QMC 原始密钥（直接喂 qmc2Decrypt）
 * @param ekeyB64 取链响应中的 ekey 字段（约 952 字符 base64）
 * @returns QMC 原始密钥字节，失败返回 null
 */
export function deriveRawKey(ekeyB64: string): Uint8Array | null {
  if (!ekeyB64 || !ekeyB64.trim()) return null;
  try {
    // 1. base64 解码 + DES 解密
    const decoded = base64ToUint8Array(ekeyB64.trim());
    const blockLen = decoded.length - (decoded.length % 8);
    if (blockLen <= 0) return null;
    const desOut = desEcbDecrypt(decoded.subarray(0, blockLen), DES_KEY);

    // 去尾部 NUL → ASCII 文本
    let end = desOut.length;
    while (end > 0 && desOut[end - 1] === 0) end--;
    const text = bytesToAscii(desOut.subarray(0, end));

    // 2. 取尾部 base64 段（704 或 364 字符）
    let rawKeyB64: string | null = null;
    for (const n of RAW_KEY_B64_LENGTHS) {
      if (text.length < n) continue;
      const candidate = text.slice(text.length - n);
      if (isValidBase64(candidate)) {
        rawKeyB64 = candidate;
        break;
      }
    }
    if (!rawKeyB64) return null;

    // 3. base64 解码（可能带 EncV2 前缀）
    let dk = base64ToUint8Array(rawKeyB64);
    if (startsWithAscii(dk, V2_PREFIX)) {
      const t1 = tcTeaDecrypt(dk.subarray(V2_PREFIX.length), V2_KEY1);
      if (!t1) return null;
      const t2 = tcTeaDecrypt(t1, V2_KEY2);
      if (!t2) return null;
      // 去尾部 NUL → base64 文本 → 再解码
      let v2End = t2.length;
      while (v2End > 0 && t2[v2End - 1] === 0) v2End--;
      const v2Text = bytesToAscii(t2.subarray(0, v2End));
      if (!isValidBase64(v2Text)) return null;
      dk = base64ToUint8Array(v2Text);
    }
    if (dk.length < 16) return null;

    // 4. QMC v1 派生：simpleKey 与密钥头 8 字节交错 → TEA key
    const simple = qmcSimpleKey(8);
    const teaKey = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
      teaKey[i * 2] = simple[i];
      teaKey[i * 2 + 1] = dk[i];
    }
    const plain = tcTeaDecrypt(dk.subarray(8), teaKey);
    if (!plain) return null;

    const out = new Uint8Array(8 + plain.length);
    out.set(dk.subarray(0, 8), 0);
    out.set(plain, 8);
    return out;
  } catch {
    return null;
  }
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToAscii(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))) as unknown as number[]
    );
  }
  return s;
}

function isValidBase64(s: string): boolean {
  if (!s || s.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

function startsWithAscii(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}
