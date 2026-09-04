/**
 * MSE (MediaSource Extensions) 可用性检测模块
 * v14.4: 在 WebView 环境中验证 MSE 对 audio/mpeg 的支持情况
 *
 * 检测逻辑：
 * 1. 检查全局 MediaSource 对象是否存在
 * 2. 检查 audio/mpeg 类型是否被支持
 * 3. 记录检测结果供后续方案选择
 *
 * 注意：Capacitor Android WebView 基于系统 WebView (Chromium)，
 * Android 5.0+ (API 21+) 的 WebView 理论上支持 MSE，但实际支持度
 * 需在实际设备/模拟器上验证。
 */

export interface MSECapabilityReport {
  /** MediaSource 对象是否存在 */
  mediaSourceAvailable: boolean;
  /** audio/mpeg (MP3) 是否受支持 */
  mp3Supported: boolean;
  /** audio/mp4 (AAC/M4A) 是否受支持 */
  mp4Supported: boolean;
  /** 推荐的 MIME 类型 */
  preferredMimeType: string | null;
  /** 整体是否可用 */
  isUsable: boolean;
  /** 检测时间戳 */
  detectedAt: number;
  /** 用户代理字符串 */
  userAgent: string;
}

let cachedReport: MSECapabilityReport | null = null;

/**
 * 执行 MSE 能力检测
 * 首次调用执行检测，后续返回缓存结果
 */
export function detectMSECapability(): MSECapabilityReport {
  if (cachedReport) return cachedReport;

  const mediaSourceAvailable = typeof MediaSource !== 'undefined';
  let mp3Supported = false;
  let mp4Supported = false;
  let preferredMimeType: string | null = null;

  if (mediaSourceAvailable) {
    try {
      mp3Supported = MediaSource.isTypeSupported('audio/mpeg');
    } catch {
      mp3Supported = false;
    }

    try {
      mp4Supported = MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"');
    } catch {
      mp4Supported = false;
    }

    if (mp4Supported) {
      preferredMimeType = 'audio/mp4; codecs="mp4a.40.2"';
    } else if (mp3Supported) {
      preferredMimeType = 'audio/mpeg';
    }
  }

  cachedReport = {
    mediaSourceAvailable,
    mp3Supported,
    mp4Supported,
    preferredMimeType,
    isUsable: mediaSourceAvailable && (mp3Supported || mp4Supported),
    detectedAt: Date.now(),
    userAgent: navigator.userAgent,
  };

  console.log('[MSEDetector] Capability report:', cachedReport);
  return cachedReport;
}

/**
 * 快速判断 MSE 是否可用
 */
export function isMSEAvailable(): boolean {
  return detectMSECapability().isUsable;
}

/**
 * 获取推荐的 MIME 类型
 */
export function getPreferredMimeType(): string | null {
  return detectMSECapability().preferredMimeType;
}

/**
 * 清空缓存的检测报告（用于重新检测）
 */
export function clearMSECache(): void {
  cachedReport = null;
}
