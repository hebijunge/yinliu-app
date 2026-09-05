/**
 * B站 WBI 签名工具
 * 依据《B站音源接入调研报告 v2.1》算法实现
 */

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

interface WbiKeyCache {
  imgKey: string;
  subKey: string;
  expiresAt: number;
}

let keyCache: WbiKeyCache | null = null;
const KEY_CACHE_TTL_MS = 10 * 60 * 1000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

export async function getWbiKeys(): Promise<{ imgKey: string; subKey: string }> {
  if (keyCache && Date.now() < keyCache.expiresAt) {
    return { imgKey: keyCache.imgKey, subKey: keyCache.subKey };
  }

  const resp = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
    },
    // C1: 裸 fetch 统一补超时
    signal: AbortSignal.timeout(10000),
  });
  const data = await resp.json().catch(() => null);
  const wbi = data?.data?.wbi_img;
  if (!wbi?.img_url || !wbi?.sub_url) {
    throw new Error('WBI keys not found in nav response');
  }

  const imgKey = wbi.img_url.split('/').pop()?.split('.')[0] ?? '';
  const subKey = wbi.sub_url.split('/').pop()?.split('.')[0] ?? '';

  keyCache = { imgKey, subKey, expiresAt: Date.now() + KEY_CACHE_TTL_MS };
  return { imgKey, subKey };
}

export function getMixinKey(imgKey: string, subKey: string): string {
  const orig = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.slice(0, 32)
    .map((i) => orig[i])
    .join('');
}

export function signWbi(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string
): Record<string, string | number> {
  const mixinKey = getMixinKey(imgKey, subKey);
  const signed = { ...params };
  signed.wts = Math.floor(Date.now() / 1000);

  const sorted = Object.entries(signed).sort(([a], [b]) => a.localeCompare(b));
  const parts = sorted.map(([k, v]) => {
    const filtered = String(v).replace(/[!'()*]/g, '');
    return `${k}=${filtered}`;
  });
  const query = parts.join('&');
  signed.w_rid = md5Hex(query + mixinKey);
  return signed;
}

function md5Hex(input: string): string {
  const utf8 = new TextEncoder().encode(input);
  const len = utf8.length;
  const padLen = (len + 72) & ~63;
  const msg = new Uint8Array(padLen);
  msg.set(utf8);
  msg[len] = 0x80;

  const bitLen = BigInt(len) * 8n;
  const view = new DataView(msg.buffer);
  view.setUint32(padLen - 8, Number(bitLen & 0xffffffffn), true);
  view.setUint32(padLen - 4, Number(bitLen >> 32n), true);

  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  }

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  const chunks = padLen / 64;
  const M = new Uint32Array(16);
  for (let chunk = 0; chunk < chunks; chunk++) {
    for (let i = 0; i < 16; i++) {
      M[i] = view.getUint32(chunk * 64 + i * 4, true);
    }
    let [A, B, C, D] = [a, b, c, d];
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) {
        f = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        f = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        f = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const temp = D;
      D = C >>> 0;
      C = B >>> 0;
      B = (B + leftRotate((A + f + K[i] + M[g]) >>> 0, s[i])) >>> 0;
      A = temp >>> 0;
    }
    a = (a + A) >>> 0;
    b = (b + B) >>> 0;
    c = (c + C) >>> 0;
    d = (d + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, a, true);
  dv.setUint32(4, b, true);
  dv.setUint32(8, c, true);
  dv.setUint32(12, d, true);
  return Array.from(out)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function leftRotate(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}
