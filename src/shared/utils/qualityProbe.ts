/**
 * v29 B6 音质诚实性探测层
 *
 * 目标：取链成功后，用真实文件大小（Content-Length / Content-Range 总长）
 * 比对标称音质档位，推算真实档位（actualQuality），杜绝「选 Hi-Res 实际拿到 128k」
 * 这类名实不符在 UI 上无感知。
 *
 * 诚实性约束（产品口径）：
 * 1. 没有可靠文件大小 → 不填 actualQuality（UI 只展示标称档位，不猜）；
 * 2. 没有歌曲时长 → 只有文件大小也算不出码率，同样不填（不同时长的同码率文件大小差异巨大）；
 * 3. 推算结果可能高于或低于标称档位，如实返回，不向标称对齐。
 */

import { Quality, qualityRank } from '@core/types';
import { platformFetch } from './platformFetch';
import { Capacitor } from '@capacitor/core';

/** 探测超时（毫秒）。与单候选取链超时同量级——探测失败直接放弃，不拖慢起播主链路 */
const PROBE_TIMEOUT_MS = 1500;

/**
 * 探测直链的真实文件大小（字节）。
 * 策略：
 * 1. 优先 HEAD（零响应体，Capacitor 原生通道也安全）；
 * 2. HEAD 失败/无 Content-Length 时回退 Range GET bytes=0-0 读 Content-Range 总长——
 *    仅在非 Capacitor 原生环境执行（CapacitorHttp 会整体缓冲响应体，Range 请求可能
 *    把整个音频文件拉进内存，风险不可接受）；
 * 3. 任何失败返回 null，调用方按「探测不到」处理。
 */
export async function probeFileSize(
  url: string,
  headers?: Record<string, string>
): Promise<number | null> {
  // 1. HEAD
  try {
    const resp = await platformFetch(url, {
      method: 'HEAD',
      headers,
      timeout: PROBE_TIMEOUT_MS,
    });
    if (resp.ok) {
      const cl = resp.headers.get('content-length');
      const size = cl ? parseInt(cl, 10) : 0;
      if (size > 0) return size;
      // 某些 CDN 对 HEAD 返回 content-range
      const cr = resp.headers.get('content-range');
      const total = parseContentRangeTotal(cr);
      if (total > 0) return total;
    }
  } catch {
    /* 落到 Range 探测或放弃 */
  }

  // 2. Range GET 回退（仅浏览器/Tauri 环境）
  if (Capacitor.isNativePlatform()) return null;
  try {
    const resp = await platformFetch(url, {
      method: 'GET',
      headers: { ...(headers || {}), Range: 'bytes=0-0' },
      timeout: PROBE_TIMEOUT_MS,
    });
    if (resp.status === 206 || resp.status === 200) {
      const total = parseContentRangeTotal(resp.headers.get('content-range'));
      if (total > 0) return total;
      const cl = resp.headers.get('content-length');
      const size = cl ? parseInt(cl, 10) : 0;
      // 200 整文件响应的 content-length 即总长；206 且无 content-range 时 length=1 无意义
      if (resp.status === 200 && size > 0) return size;
    }
    resp.body?.cancel().catch(() => {});
  } catch {
    /* 放弃 */
  }
  return null;
}

/** 从 Content-Range: bytes 0-0/123456 中取总长 */
function parseContentRangeTotal(contentRange: string | null): number {
  if (!contentRange) return 0;
  const m = contentRange.match(/\/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * 按码率（kbps）划分真实音质档位。
 * 阈值取各档典型码率的中间带：
 *   ≥1400 → Hi-Res（无损 flac 通常 850~1200，Hi-Res 1800+）
 *   ≥850  → 无损
 *   ≥250  → 320K
 *   ≥160  → 192K
 *   ≥96   → 128K
 *   ≥32   → 低码率（48K/32K 归并）
 */
export function bitrateToQuality(kbps: number): Quality {
  if (kbps >= 1400) return Quality.HIRES;
  if (kbps >= 850) return Quality.LOSSLESS;
  if (kbps >= 250) return Quality.HIGH;
  if (kbps >= 160) return Quality.HIGHER;
  if (kbps >= 96) return Quality.STANDARD;
  return Quality.LOW;
}

export interface ActualQualityResult {
  /** 文件大小（字节）——探测到即返回，与档位推算解耦 */
  sizeBytes?: number;
  /** 推算真实码率（kbps）——仅 durationSec 已知时返回 */
  actualBitrate?: number;
  /** 推算真实档位——仅 durationSec 已知时返回；推算不出不填（诚实性约束） */
  actualQuality?: Quality;
}

/**
 * 由文件大小 + 歌曲时长推算真实音质档位。
 * @param sizeBytes 真实文件大小（字节）
 * @param durationSec 歌曲时长（秒）；未知传 undefined——此时不做档位推算
 */
export function classifyActualQuality(sizeBytes: number | null | undefined, durationSec?: number): ActualQualityResult {
  const out: ActualQualityResult = {};
  if (!sizeBytes || sizeBytes <= 0) return out;
  out.sizeBytes = sizeBytes;
  if (!durationSec || durationSec <= 0) return out;
  const kbps = Math.round((sizeBytes * 8) / (durationSec * 1000));
  out.actualBitrate = kbps;
  out.actualQuality = bitrateToQuality(kbps);
  return out;
}

/**
 * 判断推算档位是否与标称档位存在「值得展示」的差异。
 * 同档带内的小幅浮动（如 320k 文件算出 192k 带）不标——只在推算档位
 * 与标称档位跨越档位带时才视为名实不符。
 */
export function isQualityMismatch(actual: Quality | undefined, nominal: Quality): boolean {
  if (!actual) return false;
  return qualityRank(actual) !== qualityRank(nominal);
}
