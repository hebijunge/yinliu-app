import type { MusicSource, EndpointCandidate } from './types';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult, PlayUrlResult, SongDetail, HealthStatus } from '@core/types';
import { YinliuError, ErrorCode, qualityRank } from '@core/types';
import { platformFetch } from '@shared/utils/platformFetch';
import { debugLogger } from '@shared/utils/debugLogger';

export interface ResolvedCandidate extends EndpointCandidate {
  /** 自定义解析函数：fetch响应 → PlayUrlResult | null */
  resolve?: (response: Response) => Promise<PlayUrlResult | null>;
  /** 候选标识（用于成功通道记忆），默认使用 url */
  key?: string;
}

/** 成功通道记忆条目 */
interface SuccessMemoryEntry {
  candidateKey: string;
  timestamp: number;
}

export abstract class BaseHttpSource implements MusicSource {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly maxQuality: Quality;
  enabled = true;

  abstract search(params: SearchParams): Promise<SearchResult[]>;
  abstract getSongDetail(songId: string): Promise<SongDetail>;
  abstract healthCheck(): Promise<HealthStatus>;

  /**
   * 构建取链候选端点列表。
   * 子类可覆写此方法，或覆写 getPlayUrl 完全自定义取链逻辑。
   */
  protected abstract buildEndpointCandidates(songId: string, quality: Quality): ResolvedCandidate[];

  /** 全局成功通道记忆：sourceId → 上次成功的 candidateKey */
  private static successMemory = new Map<string, SuccessMemoryEntry>();
  /** 全局去重锁：sourceId_songId_quality → 正在进行的 Promise */
  private static pendingLocks = new Map<string, Promise<PlayUrlResult>>();
  /** 成功通道记忆有效期（毫秒） */
  private static readonly MEMORY_TTL = 24 * 60 * 60 * 1000; // 24小时

  async getPlayUrl(songId: string, quality: Quality): Promise<PlayUrlResult> {
    const lockKey = `${this.id}_${songId}_${quality}`;

    // 去重保护：同曲同音质正在取链中，直接等待已有请求
    const existing = BaseHttpSource.pendingLocks.get(lockKey);
    if (existing) {
      debugLogger.info('player', `取链去重复用: ${this.id} · ${songId}`, { lockKey });
      return existing;
    }

    const candidates = this.buildEndpointCandidates(songId, quality);
    if (candidates.length === 0) {
      throw new YinliuError(ErrorCode.LINK_RACE_FAILED, `No endpoints for ${this.id}`, 503);
    }

    const racePromise = this.linkRace(candidates, quality);
    BaseHttpSource.pendingLocks.set(lockKey, racePromise);

    racePromise.finally(() => {
      BaseHttpSource.pendingLocks.delete(lockKey);
    });

    return racePromise;
  }

  /**
   * 并发竞速取链（v14.5 优化版）。
   * 核心改进：
   * 1. 一成功立即返回，不再等待所有 promise settle
   * 2. 成功通道记忆：优先尝试上次成功的候选
   * 3. 每个候选独立 timeout，超时即放弃
   * 4. 支持 POST body
   */
  protected async linkRace(candidates: ResolvedCandidate[], targetQuality: Quality): Promise<PlayUrlResult> {
    if (candidates.length === 0) {
      throw new YinliuError(ErrorCode.LINK_RACE_FAILED, `No endpoints for ${this.id}`, 503);
    }

    // 读取成功通道记忆
    const memory = BaseHttpSource.successMemory.get(this.id);
    const now = Date.now();
    const hasValidMemory = memory && (now - memory.timestamp) < BaseHttpSource.MEMORY_TTL;

    // 如果有有效记忆，把对应候选排到最前面（同时保留其他候选作为并行备份）
    let ordered = candidates;
    if (hasValidMemory) {
      const prioritized = candidates.filter((c) => (c.key || c.url) === memory!.candidateKey);
      const others = candidates.filter((c) => (c.key || c.url) !== memory!.candidateKey);
      ordered = [...prioritized, ...others];
    }

    // 为每个候选创建一个带独立超时和解析的 promise
    // 一旦成功立即 resolve，失败/超时自动 reject
    const candidatePromises = ordered.map((c) =>
      this.raceOneCandidate(c, targetQuality)
    );

    // 使用 accurate-aware 竞速：accurate 候选一成功立即返回；
    // inaccurate 候选先成功时继续等待，给 accurate 候选一个竞争窗口。
    const result = await this.raceWithAccuratePriority(candidatePromises);

    if (result) {
      // 记录成功通道记忆
      const r = result as PlayUrlResult & { _candidateKey?: string };
      const winningKey = r._candidateKey;
      if (winningKey) {
        BaseHttpSource.successMemory.set(this.id, {
          candidateKey: winningKey,
          timestamp: Date.now(),
        });
        delete r._candidateKey;
      }
      return result;
    }

    throw new YinliuError(ErrorCode.LINK_RACE_FAILED, `Link race failed for ${this.id}`, 503);
  }

  /**
   * 单个候选的取链尝试：带独立超时，成功返回 PlayUrlResult，失败/超时返回 null
   */
  private async raceOneCandidate(
    c: ResolvedCandidate,
    targetQuality: Quality
  ): Promise<(PlayUrlResult & { _candidateKey: string }) | null> {
    const candidateKey = c.key || c.url;
    const timeout = c.timeout || 8000;

    try {
      const response = await platformFetch(c.url, {
        method: c.method,
        headers: c.headers,
        body: c.body as string | undefined,
        redirect: 'follow',
        timeout,
      });

      if (!response.ok) return null;

      let result: PlayUrlResult | null = null;

      if (c.resolve) {
        result = await c.resolve(response);
      } else {
        const contentType = response.headers.get('content-type') || '';
        const contentLength = response.headers.get('content-length');
        result = {
          url: c.url,
          quality: targetQuality,
          bitrate: this.estimateBitrate(contentLength, targetQuality),
          format: this.detectFormat(contentType, c.url),
          headers: c.headers,
        };
      }

      if (result && this.validateQuality(result, targetQuality)) {
        return { ...result, _candidateKey: candidateKey };
      }
      return null;
    } catch (err) {
      // 超时或网络错误静默忽略，让其他候选竞争
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('timeout') || msg.includes('Timeout')) {
        debugLogger.warn('network', `取链候选超时 [${this.id}]`, { url: candidateKey.slice(0, 80), timeout });
      }
      return null;
    }
  }

  /**
   * accurate-aware 竞速：优先返回 accurate 候选，保留"一成功即返回"性能。
   *
   * 机制：
   * - 若先完成的是 accurate（isAccurateResult === true），立即返回；
   * - 若先完成的是 inaccurate，记录它并继续等待其余候选；
   * - 当所有候选都失败后，如有记录的 inaccurate 则降级返回。
   *
   * 这比旧版 Promise.allSettled 更快：accurate 候选一旦先完成即可提前返回，
   * 不需要等其余候选 settle。
   */
  private async raceWithAccuratePriority(
    promises: Promise<(PlayUrlResult & { _candidateKey: string }) | null>[]
  ): Promise<PlayUrlResult | null> {
    if (promises.length === 0) return null;
    if (promises.length === 1) return await promises[0];

    return new Promise((resolve) => {
      let resolved = false;
      let firstInaccurate: PlayUrlResult | null = null;
      let remaining = promises.length;

      const tryResolve = () => {
        if (!resolved && remaining === 0 && firstInaccurate) {
          resolved = true;
          resolve(firstInaccurate);
        } else if (!resolved && remaining === 0) {
          resolved = true;
          resolve(null);
        }
      };

      promises.forEach((p) => {
        p.then((result) => {
          remaining--;
          if (resolved) return;
          if (!result) { tryResolve(); return; }
          if (this.isAccurateResult(result)) {
            resolved = true;
            resolve(result);
            return;
          }
          if (!firstInaccurate) firstInaccurate = result;
          tryResolve();
        }).catch(() => {
          remaining--;
          tryResolve();
        });
      });
    });
  }

  /**
   * 判断结果是否属于 accurate 候选（用于竞速优先）。
   * 子类可覆写以适配各源的 accurate 语义。
   */
  protected isAccurateResult(result: PlayUrlResult): boolean {
    return result.accurate !== false;
  }

  protected validateQuality(result: PlayUrlResult, target: Quality): boolean {
    if (!result.url) return false;
    // 音质等级校验
    if (qualityRank(result.quality) < qualityRank(target)) return false;
    // 若子类已标记 accurate，直接信任；accurate === false 作为降级链保留，
    // 由 raceWithAccuratePriority 在竞速层做优先级排序，不在此处直接拒绝。
    if (result.accurate === true) return true;
    // 未标记时，做保守的码率/格式兜底校验
    return this.validateBitrateAndFormat(result.bitrate, result.format, target);
  }

  /**
   * 码率与格式兜底校验：请求音质 vs 实际响应。
   * 子类可覆写以提供更精确的源级校验。
   */
  protected validateBitrateAndFormat(bitrate: number, format: string, target: Quality): boolean {
    const expected = this.qualityExpectation(target);
    if (!expected) return true; // 无期望值时不拦截
    const [expBr, expFmt] = expected;
    const tol = this.bitrateTolerance(format);
    const fmtOk = format.toLowerCase() === expFmt.toLowerCase();
    const brOk = Math.abs(bitrate - expBr) <= tol;
    return fmtOk && brOk;
  }

  /**
   * 请求音质 → 期望 (bitrate, format)。
   * 子类覆写以适配各源的实际档位。
   */
  protected qualityExpectation(quality: Quality): [number, string] | null {
    switch (quality) {
      case Quality.LOW: return [48, 'aac'];
      case Quality.STANDARD: return [128, 'mp3'];
      case Quality.HIGH: return [320, 'mp3'];
      case Quality.LOSSLESS: return [1000, 'flac'];
      case Quality.HIFI:
      case Quality.HIRES: return [2000, 'flac'];
      default: return null;
    }
  }

  /**
   * 码率匹配容差（不同编码实测码率有小幅浮动）。
   */
  protected bitrateTolerance(format: string): number {
    const f = format.toLowerCase();
    if (f === 'flac') return 80;
    return 8;
  }

  /** 音质对应的典型码率（kbps） */
  protected qualityToExpectedBitrate(quality: Quality): number {
    switch (quality) {
      case Quality.LOW: return 48;
      case Quality.STANDARD: return 128;
      case Quality.HIGHER: return 192;
      case Quality.HIGH: return 320;
      case Quality.LOSSLESS: return 1000;
      case Quality.HIFI: return 3000;
      case Quality.HIRES: return 1800;
      case Quality.SKY: return 1000;
      case Quality.JYEFFECT: return 320;
      default: return 128;
    }
  }

  protected estimateBitrate(contentLength: string | null, quality: Quality): number {
    const size = parseInt(contentLength || '0', 10);
    if (size === 0) return 128;
    const kbps = Math.round((size * 8) / (3 * 60 * 1000));
    return kbps;
  }

  protected detectFormat(contentType: string, url: string): string {
    if (contentType.includes('flac')) return 'flac';
    if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'mp3';
    if (contentType.includes('aac')) return 'aac';
    if (contentType.includes('ogg')) return 'ogg';
    if (contentType.includes('m4a')) return 'm4a';
    const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
    const extMap: Record<string, string> = { flac: 'flac', mp3: 'mp3', aac: 'aac', m4a: 'm4a', ogg: 'ogg' };
    return extMap[ext || ''] || 'mp3';
  }

  /**
   * 通用 GET 请求辅助
   */
  protected async httpGet(url: string, headers?: Record<string, string>): Promise<Response | null> {
    try {
      return await platformFetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          ...headers,
        },
      });
    } catch {
      return null;
    }
  }

  /**
   * 通用 GET 请求并解析JSON
   */
  protected async httpGetJson(url: string, headers?: Record<string, string>): Promise<any | null> {
    const resp = await this.httpGet(url, headers);
    if (!resp || !resp.ok) return null;
    try {
      return await resp.json();
    } catch {
      return null;
    }
  }

  /**
   * 通用 POST JSON 请求
   */
  protected async httpPostJson(url: string, body: object, headers?: Record<string, string>): Promise<any | null> {
    try {
      const resp = await platformFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...headers,
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }

  /**
   * 通用 POST Form 请求
   */
  protected async httpPostForm(url: string, params: Record<string, string>, headers?: Record<string, string>): Promise<any | null> {
    try {
      const form = new URLSearchParams(params);
      const resp = await platformFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...headers,
        },
        body: form.toString(),
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }
}
