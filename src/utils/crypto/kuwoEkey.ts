/**
 * 酷我 KuwoEkeyDecoder
 * 算法：ekey(base64) → DES-ECB/NoPadding解密（密钥 ylzsxkwm）→ QMC原始密钥
 *
 * 依据 DJMusic Kotlin 参考实现移植：
 *  - 酷我 ekey 为「自定义 DES」——输入按 8 字节分块处理（DES/ECB/NoPadding），
 *    尾部不足一块的字节补 0。
 *  - 派生结果直接喂 Qmc2Decoder 做 QMC2 流解密。
 */

import { desEcbDecrypt } from './des';

const DES_KEY = new TextEncoder().encode('ylzsxkwm');

/**
 * 由 base64 ekey 派生 QMC 原始密钥
 * @param ekeyB64 取链响应中的 ekey 字段（约 952 字符 base64）
 * @returns QMC 原始密钥字节（直接喂 Qmc2Decoder.decrypt），失败返回 null
 */
export function deriveRawKey(ekeyB64: string): Uint8Array | null {
  if (!ekeyB64 || !ekeyB64.trim()) return null;
  try {
    const decoded = base64ToUint8Array(ekeyB64.trim());
    if (decoded.length === 0) return null;

    // 规整到 8 字节整数倍：尾部不足一块补 0（自定义 DES 容忍不定长输入）
    const paddedLen = Math.floor(decoded.length / 8) * 8;
    if (paddedLen <= 0) return null;
    const inBuf = paddedLen === decoded.length ? decoded : decoded.slice(0, paddedLen);
    return desEcbDecrypt(inBuf, DES_KEY);
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
