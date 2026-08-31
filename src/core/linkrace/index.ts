import type { EndpointCandidate } from '@providers/music/types';
import type { PlayUrlResult } from '@core/types';
import { Quality, qualityRank, YinliuError, ErrorCode } from '@core/types';
import { platformFetch } from '@shared/utils/platformFetch';

/**
 * LinkRace 并发竞速取链引擎
 * 核心功能：多个endpoint并发请求，首个匹配成功的采用
 */

export interface LinkRaceResult {
  result: PlayUrlResult;
  candidate: EndpointCandidate;
  latency: number;
}

export interface LinkRaceOptions {
  timeout?: number;
  validateUrl?: boolean;
  fallbackQuality?: Quality;
}

/**
 * 并发竞速取链
 * @param candidates 候选端点列表
 * @param targetQuality 目标音质
 * @param options 可选配置
 */
export async function linkRace(
  candidates: EndpointCandidate[],
  targetQuality: Quality,
  options: LinkRaceOptions = {}
): Promise<LinkRaceResult> {
  const { timeout = 15000, validateUrl = true } = options;
  const controller = new AbortController();
  const startTime = Date.now();

  // 创建竞速Promise
  const promises = candidates.map(async (candidate): Promise<LinkRaceResult | null> => {
    const cStart = Date.now();
    try {
      const response = await platformFetch(candidate.url, {
        method: candidate.method,
        headers: candidate.headers,
        signal: controller.signal,
        redirect: 'follow',
      });

      if (!response.ok) return null;

      // 可选：验证URL有效性（HEAD请求检查Content-Length）
      if (validateUrl && candidate.method === 'GET') {
        const headResponse = await platformFetch(candidate.url, {
          method: 'HEAD',
          headers: candidate.headers,
          signal: controller.signal,
        });
        if (!headResponse.ok) return null;
      }

      const contentType = response.headers.get('content-type') || '';
      const contentLength = response.headers.get('content-length');

      const result: PlayUrlResult = {
        url: candidate.url,
        quality: targetQuality,
        bitrate: estimateBitrate(contentLength, targetQuality),
        format: detectFormat(contentType, candidate.url),
        headers: candidate.headers,
      };

      // 音质校验
      if (validateQuality(result, targetQuality)) {
        controller.abort(); // 取消其他请求
        return {
          result,
          candidate,
          latency: Date.now() - cStart,
        };
      }

      return null;
    } catch {
      return null;
    }
  });

  // 添加全局超时
  const timeoutPromise = new Promise<null>((_, reject) => {
    setTimeout(() => {
      controller.abort();
      reject(new Error('LinkRace timeout'));
    }, timeout);
  });

  try {
    const results = await Promise.allSettled([...promises, timeoutPromise]);

    const matched = results
      .filter((r): r is PromiseFulfilledResult<LinkRaceResult | null> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((r): r is LinkRaceResult => r !== null);

    if (matched.length > 0) {
      // 按优先级和延迟排序
      matched.sort((a, b) => {
        if (a.candidate.priority !== b.candidate.priority) {
          return a.candidate.priority - b.candidate.priority;
        }
        return a.latency - b.latency;
      });
      return matched[0];
    }

    throw new YinliuError(
      ErrorCode.LINK_RACE_FAILED,
      `所有候选端点均失败，共${candidates.length}个端点`,
      503
    );
  } catch (err) {
    if (err instanceof YinliuError) throw err;
    throw new YinliuError(ErrorCode.LINK_RACE_FAILED, '取链竞速失败', 503);
  }
}

/**
 * 音质校验
 */
function validateQuality(result: PlayUrlResult, target: Quality): boolean {
  if (!result.url) return false;
  // 校验格式
  if (!result.format || result.format === 'unknown') return false;
  // 音质等级校验
  return qualityRank(result.quality) >= qualityRank(target);
}

/**
 * 估算比特率
 */
function estimateBitrate(contentLength: string | null, quality: Quality): number {
  const size = parseInt(contentLength || '0', 10);
  if (size === 0) {
    // 根据目标音质返回典型值
    switch (quality) {
      case Quality.HIFI: return 3000;
      case Quality.HIRES: return 1800;
      case Quality.LOSSLESS: return 1000;
      case Quality.HIGH: return 320;
      case Quality.STANDARD: return 128;
      case Quality.LOW: return 48;
      default: return 128;
    }
  }
  // 粗略估算：假设3分钟歌曲
  const kbps = Math.round((size * 8) / (3 * 60 * 1000));
  return Math.min(Math.max(kbps, 48), 3000);
}

/**
 * 检测音频格式
 */
function detectFormat(contentType: string, url: string): string {
  const typeMap: Record<string, string> = {
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/aac': 'aac',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'application/octet-stream': 'mp3',
  };

  for (const [ct, fmt] of Object.entries(typeMap)) {
    if (contentType.includes(ct)) return fmt;
  }

  // 从URL扩展名推断
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  const extMap: Record<string, string> = {
    flac: 'flac',
    mp3: 'mp3',
    aac: 'aac',
    m4a: 'm4a',
    ogg: 'ogg',
    wav: 'wav',
    wma: 'wma',
    ape: 'ape',
  };

  return extMap[ext || ''] || 'mp3';
}

/**
 * 带降级链的取链
 * 当目标音质不可用时，自动降级到下一个可用音质
 */
export async function linkRaceWithFallback(
  candidateBuilder: (quality: Quality) => EndpointCandidate[],
  preferredQuality: Quality,
  qualityChain: Quality[] = [
    Quality.HIFI,
    Quality.HIRES,
    Quality.LOSSLESS,
    Quality.HIGH,
    Quality.STANDARD,
    Quality.LOW,
  ]
): Promise<LinkRaceResult> {
  // 构建音质降级链（从preferredQuality开始）
  const startIndex = qualityChain.indexOf(preferredQuality);
  const chain = startIndex >= 0 ? qualityChain.slice(startIndex) : qualityChain;

  const errors: string[] = [];

  for (const quality of chain) {
    try {
      const candidates = candidateBuilder(quality);
      if (candidates.length === 0) continue;

      return await linkRace(candidates, quality, { validateUrl: false });
    } catch (err) {
      errors.push(`${quality}: ${err instanceof Error ? err.message : '失败'}`);
    }
  }

  throw new YinliuError(
    ErrorCode.LINK_RACE_FAILED,
    `所有音质档位均失败: ${errors.join('; ')}`,
    503
  );
}
