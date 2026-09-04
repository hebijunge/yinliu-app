import type { MusicSource, EndpointCandidate, FileSizeResult } from './types';
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

/** 取链缓存条目 */
interface CacheEntry {
  result: PlayUrlResult;
  expiresAt: number;
}

/** 简易 LRU 缓存（取链结果缓存） */
class PlayUrlCache {
  private map = new Map<string, CacheEntry>();
  private readonly maxSize: number;

  constructor(maxSize = 128) {
    this.maxSize = maxSize;
  }

  get(key: string): PlayUrlResult | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    // 过期检查
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    // LRU：移到末尾表示最近使用
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.result;
  }

  set(key: string, result: PlayUrlResult, ttlMs: number): void {
    if (this.map.size >= this.maxSize) {
      // 淘汰最久未使用的
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
    this.map.set(key, { result, expiresAt: Date.now() + ttlMs });
  }

  clear(): void {
    this.map.clear();
  }
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
  /** 全局取链缓存 */
  private static playUrlCache = new PlayUrlCache(128);
  /** 成功通道记忆有效期（毫秒） */
  private static readonly MEMORY_TTL = 24 * 60 * 60 * 1000; // 24小时
  /** 缓存默认 TTL（毫秒）：25 分钟（略低于各源 URL 实际有效期） */
  private static readonly CACHE_TTL = 25 * 60 * 1000;
  /** 全局取链超时（毫秒） */
  private static readonly LINK_RACE_TIMEOUT = 20000;
  /** 单个候选重试次数 */
  private static readonly MAX_RETRIES = 2;
  /** 重试退避基数（毫秒） */
  private static readonly RETRY_BACKOFF_BASE = 500;

  async getPlayUrl(songId: string, quality: Quality, signal?: AbortSignal): Promise<PlayUrlResult> {
    const lockKey = `${this.id}_${songId}_${quality}`;

    // 1. 缓存命中检查
    const cached = BaseHttpSource.playUrlCache.get(lockKey);
    if (cached) {
      debugLogger.info('player', `取链缓存命中: ${this.id} · ${songId}`, { lockKey, quality });
      return cached;
    }

    // 2. 去重保护：同曲同音质正在取链中，直接等待已有请求
    const existing = BaseHttpSource.pendingLocks.get(lockKey);
    if (existing) {
      debugLogger.info('player', `取链去重复用: ${this.id} · ${songId}`, { lockKey });
      return existing;
    }

    // 外部取消信号优先：已 abort 则直接失败
    if (signal?.aborted) {
      throw new YinliuError(ErrorCode.LINK_RACE_FAILED, '取链已取消', 499);
    }

    const candidates = this.buildEndpointCandidates(songId, quality);
    if (candidates.length === 0) {
      throw new YinliuError(ErrorCode.LINK_RACE_FAILED, `No endpoints for ${this.id}`, 503);
    }

    const racePromise = this.linkRace(candidates, quality, songId, signal);
    BaseHttpSource.pendingLocks.set(lockKey, racePromise);

    racePromise
      .then((result) => {
        // 写入缓存（使用 result.expiresAt 或默认 TTL）
        const ttl = result.expiresAt
          ? result.expiresAt - Date.now()
          : BaseHttpSource.CACHE_TTL;
        if (ttl > 0) {
          BaseHttpSource.playUrlCache.set(lockKey, result, ttl);
        }
      })
      .catch(() => {
        // 失败不缓存
      })
      .finally(() => {
        BaseHttpSource.pendingLocks.delete(lockKey);
      });

    return racePromise;
  }

  /**
   * 预检该源该音质档的文件大小。
   * 基于 buildEndpointCandidates 构造的候选端点，对每个候选并发发 HEAD 请求（3秒超时），
   * 取第一个成功响应的 Content-Length 返回。子类可覆写以提供更精确的大小接口。
   */
  async getFileSize(songId: string, quality: Quality, signal?: AbortSignal): Promise<FileSizeResult | null> {
    try {
      const candidates = this.buildEndpointCandidates(songId, quality);
      if (candidates.length === 0) return null;

      const controller = new AbortController();
      // 外部信号与内部控制器联动
      if (signal) {
        signal.addEventListener('abort', () => controller.abort());
      }

      const promises = candidates.map(async (c): Promise<FileSizeResult | null> => {
        try {
          const resp = await platformFetch(c.url, {
            method: 'HEAD',
            headers: c.headers,
            signal: controller.signal,
            timeout: 3000,
          });
          if (!resp.ok) return null;
          const cl = resp.headers.get('content-length');
          const size = cl ? parseInt(cl, 10) : 0;
          if (size > 0) {
            controller.abort(); // 一成功即取消其余
            return { size, url: c.url };
          }
          return null;
        } catch {
          return null;
        }
      });

      const results = await Promise.allSettled(promises);
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          return r.value;
        }
      }
      return null;
    } catch (err) {
      debugLogger.warn('network', `文件大小预检失败 [${this.id}]`, {
        songId,
        quality,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * 并发竞速取链（v14.5 优化版）。
   * 核心改进：
   * 1. 一成功立即返回，不再等待所有 promise settle
   * 2. 成功通道记忆：优先尝试上次成功的候选
   * 3. 每个候选独立 timeout，超时即放弃
   * 4. 支持 POST body
   * 5. 全局超时保护（20s）
   * 6. 单候选指数退避重试（最多2次）
   */
  protected async linkRace(candidates: ResolvedCandidate[], targetQuality: Quality, songId?: string, signal?: AbortSignal): Promise<PlayUrlResult> {
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

    // 为每个候选创建一个带独立超时、解析和重试的 promise
    const candidatePromises = ordered.map((c) =>
      this.raceOneCandidateWithRetry(c, targetQuality, songId, signal)
    );

    // 全局超时保护
    const timeoutPromise = new Promise<PlayUrlResult | null>((_, reject) => {
      setTimeout(() => {
        reject(new YinliuError(ErrorCode.LINK_RACE_FAILED, '取链全局超时', 504));
      }, BaseHttpSource.LINK_RACE_TIMEOUT);
    });

    // 使用 accurate-aware 竞速
    const racePromise = this.raceWithAccuratePriority(candidatePromises);

    let result: PlayUrlResult | null = null;
    try {
      result = await Promise.race([racePromise, timeoutPromise]);
    } catch (err) {
      // 全局超时或竞速全部失败
      if (err instanceof YinliuError) throw err;
      throw new YinliuError(ErrorCode.LINK_RACE_FAILED, `Link race failed for ${this.id}`, 503);
    }

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
   * 带重试的单个候选取链：指数退避，最多 MAX_RETRIES 次
   */
  private async raceOneCandidateWithRetry(
    c: ResolvedCandidate,
    targetQuality: Quality,
    songId?: string,
    signal?: AbortSignal
  ): Promise<(PlayUrlResult & { _candidateKey: string }) | null> {
    const candidateKey = c.key || c.url;
    let lastErr: unknown = null;

    for (let attempt = 0; attempt <= BaseHttpSource.MAX_RETRIES; attempt++) {
      if (signal?.aborted) {
        debugLogger.info('network', `取链重试取消 [${this.id}]`, { url: candidateKey.slice(0, 80) });
        return null;
      }

      if (attempt > 0) {
        const delay = BaseHttpSource.RETRY_BACKOFF_BASE * Math.pow(2, attempt - 1);
        debugLogger.info('network', `取链重试 [${this.id}] 第${attempt}次`, {
          url: candidateKey.slice(0, 80),
          delay,
        });
        await new Promise((res) => setTimeout(res, delay));
      }

      try {
        const result = await this.raceOneCandidate(c, targetQuality, songId, signal);
        if (result) return result;
      } catch (err) {
        lastErr = err;
        // 非网络错误（如 JSON 解析失败）不重试
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('timeout') && !msg.includes('Timeout') && !msg.includes('fetch')) {
          break;
        }
      }
    }

    if (lastErr) {
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      debugLogger.warn('network', `取链候选最终失败 [${this.id}]`, {
        url: candidateKey.slice(0, 80),
        error: msg,
      });
    }
    return null;
  }

  /**
   * 单个候选的取链尝试：带独立超时，成功返回 PlayUrlResult，失败/超时返回 null
   */
  private async raceOneCandidate(
    c: ResolvedCandidate,
    targetQuality: Quality,
    songId?: string,
    signal?: AbortSignal
  ): Promise<(PlayUrlResult & { _candidateKey: string }) | null> {
    const candidateKey = c.key || c.url;
    const timeout = c.timeout || 8000;

    try {
      const response = await platformFetch(c.url, {
        method: c.method,
        headers: c.headers,
        body: c.body as string | undefined,
        redirect: 'follow',
        signal,
        timeout,
      });

      if (!response.ok) return null;

      let result: PlayUrlResult | null = null;

      if (c.resolve) {
        result = await c.resolve(response);
      } else {
        const contentType = response.headers.get('content-type') || '';
        const contentLength = response.headers.get('content-length');
        const size = parseInt(contentLength || '0', 10);
        const inferredBitrate = this.estimateBitrate(contentLength, targetQuality);
        const inferredQuality = this.inferQualityFromResponse(size, inferredBitrate, contentType, targetQuality);
        const format = this.detectFormat(contentType, c.url);

        result = {
          url: c.url,
          quality: inferredQuality,
          bitrate: inferredBitrate,
          format,
          headers: c.headers,
          // 当推断音质低于目标音质时，标记为降级结果（accurate: false）
          accurate: qualityRank(inferredQuality) >= qualityRank(targetQuality) ? true : false,
        };
      }

      if (result && this.validateQuality(result, targetQuality)) {
        // 内容级防盗校验（子类可覆写）
        const contentValid = await this.validateContent(result, songId || '');
        if (contentValid) {
          return { ...result, _candidateKey: candidateKey };
        }
        debugLogger.warn('network', `内容级校验未通过 [${this.id}]`, { url: result.url.slice(0, 120), songId });
      }
      return null;
    } catch (err) {
      // 超时或网络错误静默忽略，让其他候选竞争
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('timeout') || msg.includes('Timeout')) {
        debugLogger.warn('network', `取链候选超时 [${this.id}]`, { url: candidateKey.slice(0, 80), timeout });
      }
      throw err; // 向上抛出让重试逻辑捕获
    }
  }

  /**
   * 从响应推断实际音质：基于文件大小、码率和 Content-Type。
   * 当无法准确推断时，回退到目标音质（保守策略）。
   */
  protected inferQualityFromResponse(
    contentLength: number,
    bitrate: number,
    contentType: string,
    targetQuality: Quality
  ): Quality {
    // 无损格式优先判定
    const isLossless = contentType.includes('flac') || contentType.includes('x-flac') || contentType.includes('ape');
    if (isLossless) {
      if (bitrate >= 1500) return Quality.LOSSLESS;
      // 小体积 flac 可能是降级或试听
      return Quality.HIGH;
    }

    // 按码率推断
    if (bitrate >= 800) return Quality.LOSSLESS;
    if (bitrate >= 250) return Quality.HIGH;
    if (bitrate >= 96) return Quality.STANDARD;
    if (bitrate >= 32) return Quality.LOW;

    // 按文件大小推断（3分钟歌曲）
    if (contentLength > 0) {
      if (contentLength > 15_000_000) return Quality.LOSSLESS; // > 15MB
      if (contentLength > 5_000_000) return Quality.HIGH;      // > 5MB
      if (contentLength > 1_500_000) return Quality.STANDARD;  // > 1.5MB
      if (contentLength > 500_000) return Quality.LOW;         // > 500KB
    }

    // 无法推断时保守回退到目标音质（避免误杀）
    return targetQuality;
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

  /**
   * 内容级防盗校验：对竞速选中的直链做 Range GET 魔数校验 / 时长估算等。
   * 子类覆写以提供源级内容校验。默认返回 true（信任）。
   */
  protected async validateContent(_result: PlayUrlResult, _songId: string): Promise<boolean> {
    return true;
  }


  protected validateQuality(result: PlayUrlResult, target: Quality): boolean {
    if (!result.url) return false;
    // 若子类已标记 accurate=true，直接信任
    if (result.accurate === true) return true;
    // accurate === false 表示降级结果，保留给竞速层做 fallback，不做严格拦截
    if (result.accurate === false) return true;
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
   * 子类可覆写以适配各源的实际档位。
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
      // 酷我 mflac 加密档（真实码率来自花海实测 ffprobe：898/2298/5390 kbps）
      case Quality.ZHIZHEN: return 900;
      case Quality.DOLBY: return 2300;
      case Quality.MASTER: return 5400;
      default: return 128;
    }
  }

  protected estimateBitrate(contentLength: string | null, quality: Quality): number {
    const size = parseInt(contentLength || '0', 10);
    if (size === 0) return this.qualityToExpectedBitrate(quality);
    const kbps = Math.round((size * 8) / (3 * 60 * 1000));
    return kbps;
  }

  protected detectFormat(contentType: string, url: string): string {
    if (contentType.includes('flac')) return 'flac';
    if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'mp3';
    if (contentType.includes('aac')) return 'aac';
    if (contentType.includes('ogg')) return 'ogg';
    if (contentType.includes('m4a')) return 'm4a';
    if (contentType.includes('mp4')) return 'mp4';
    const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
    const extMap: Record<string, string> = { flac: 'flac', mp3: 'mp3', aac: 'aac', m4a: 'm4a', ogg: 'ogg', mp4: 'mp4' };
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
