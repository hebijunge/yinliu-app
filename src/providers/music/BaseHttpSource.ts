import type { MusicSource, EndpointCandidate, FileSizeResult } from './types';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult, PlayUrlResult, SongDetail, HealthStatus } from '@core/types';
import { YinliuError, ErrorCode, qualityRank } from '@core/types';
import { platformFetch } from '@shared/utils/platformFetch';
import { probeFileSize, classifyActualQuality } from '@shared/utils/qualityProbe';
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
  /** 全局取链超时（毫秒）。v26 收紧：20s → 9s —— 9/3 日志实证首源慢超时串行叠加是出声延迟首要根因，
   *  单源给 9s 预算后即应让位（平台链错峰竞速会并行补位，见 player v26） */
  private static readonly LINK_RACE_TIMEOUT = 9000;
  /** 单个候选重试次数。v26 收紧：2 → 1（弱网下多轮重试叠加 8~10s 超时是 9/3 日志 ~9s 取链耗时的直接来源；
   *  快速失败后由平台链并行竞速补位，整体成功率不降） */
  private static readonly MAX_RETRIES = 1;
  /** 重试退避基数（毫秒）。v26：500 → 300 */
  private static readonly RETRY_BACKOFF_BASE = 300;
  /** 单候选超时钳制上限（毫秒）。v27(F5/P1-2)：4s → 1.5s——平台层已有胜出短路，
   *  弱网下单候选更快失败转平台链竞速，起播更快（总调度已确认收益大于风险） */
  private static readonly MAX_CANDIDATE_TIMEOUT = 1500;
  /** 候选未显式设超时时的默认值。v27(F5/P1-2)：4s → 1.5s */
  private static readonly DEFAULT_CANDIDATE_TIMEOUT = 1500;
  /** F6(v27 P2-1)：校验层同 URL single-flight —— 并发校验合并为一次在途请求 */
  private static validationInflight = new Map<string, Promise<boolean>>();
  /** F6(v27 P2-1)：校验结果 60s TTL 内存缓存 */
  private static validationCache = new Map<string, { ok: boolean; expiresAt: number }>();
  private static readonly VALIDATION_TTL = 60_000;
  /** 校验缓存最大条数（防无界增长，超出时裁剪过期项） */
  private static readonly VALIDATION_CACHE_MAX = 256;

  async getPlayUrl(songId: string, quality: Quality, signal?: AbortSignal, opts?: { durationSec?: number }): Promise<PlayUrlResult> {
    const lockKey = `${this.id}_${songId}_${quality}`;

    // 1. 缓存命中检查
    const cached = BaseHttpSource.playUrlCache.get(lockKey);
    if (cached) {
      debugLogger.info('player', `取链缓存命中: ${this.id} · ${songId}`, { lockKey, quality });
      // v29 B6：缓存结果若缺真实档位信息（如上一轮探测失败），补一次 best-effort 探测
      return this.attachActualQuality(cached, opts);
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
    // v29 B6：竞速胜出后补真实音质探测（best-effort，失败不影响取链结果），
    // 探测完成的结果再进缓存/去重通道——等待方与缓存命中的结果都带 actualQuality
    const resultPromise = racePromise
      .then((result) => this.attachActualQuality(result, opts))
      .then((result) => {
        const ttl = result.expiresAt
          ? result.expiresAt - Date.now()
          : BaseHttpSource.CACHE_TTL;
        if (ttl > 0) {
          BaseHttpSource.playUrlCache.set(lockKey, result, ttl);
        }
        return result;
      });
    BaseHttpSource.pendingLocks.set(lockKey, resultPromise);

    resultPromise
      .catch(() => {
        // 失败不缓存
      })
      .finally(() => {
        BaseHttpSource.pendingLocks.delete(lockKey);
      });

    return resultPromise;
  }

  /**
   * v29 B6 音质诚实性：竞速胜出后探测真实文件大小并推算真实档位。
   * - sizeBytes：内容校验层（doValidateContent）已从 Range 响应捕获时直接复用，否则 HEAD 回退探测；
   * - actualQuality / actualBitrate：仅 durationSec 已知时按码率推算，推算不出不填；
   * - 探测失败（超时/CDN 不支持）静默放弃，不阻塞、不改变取链结果本身。
   */
  private async attachActualQuality(result: PlayUrlResult, opts?: { durationSec?: number }): Promise<PlayUrlResult> {
    try {
      if (!result.sizeBytes && result.url && /^https?:\/\//i.test(result.url)) {
        const probed = await probeFileSize(result.url, result.headers);
        if (probed && probed > 0) result.sizeBytes = probed;
      }
      const classified = classifyActualQuality(result.sizeBytes, opts?.durationSec);
      if (classified.actualBitrate !== undefined) result.actualBitrate = classified.actualBitrate;
      if (classified.actualQuality !== undefined) result.actualQuality = classified.actualQuality;
      if (result.actualQuality && result.actualQuality !== result.quality) {
        debugLogger.info('player', `真实音质与标称不一致 [${this.id}]`, {
          nominal: result.quality,
          actual: result.actualQuality,
          bitrate: result.actualBitrate,
          sizeBytes: result.sizeBytes,
        });
      }
    } catch {
      /* 探测失败不影响取链结果 */
    }
    return result;
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
   * 5. 全局超时保护（v26 收紧为 9s）
   * 6. 单候选指数退避重试（v26 收紧为最多 1 次重试）
   * 7. v26：候选超时钳制 ≤4s（各源显式宽松超时一律钳制，防串行叠加）
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
    // F5(v27)：源内竞速独立 AbortController——外部信号联动接入；任一候选校验通过
    // 胜出（raceWithAccuratePriority 的 onWinner 回调）即 abort 其余在途候选，
    // 不再让落败请求白耗带宽（平台层 v26 已有胜出短路，F3 落地后链路全程贯通）
    const raceController = new AbortController();
    if (signal) {
      if (signal.aborted) {
        raceController.abort();
      } else {
        signal.addEventListener('abort', () => raceController.abort(), { once: true });
      }
    }
    const candidatePromises = ordered.map((c) =>
      this.raceOneCandidateWithRetry(c, targetQuality, songId, raceController.signal)
    );

    // 全局超时保护
    const timeoutPromise = new Promise<PlayUrlResult | null>((_, reject) => {
      setTimeout(() => {
        reject(new YinliuError(ErrorCode.LINK_RACE_FAILED, '取链全局超时', 504));
      }, BaseHttpSource.LINK_RACE_TIMEOUT);
    });

    // 使用 accurate-aware 竞速；F3(v27)：任一候选胜出即 abort 其余在途候选
    const racePromise = this.raceWithAccuratePriority(candidatePromises, () => raceController.abort());

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
  ): Promise<(PlayUrlResult & { _candidateKey: string; _validated?: boolean }) | null> {
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
        // F5(v27)：被胜出候选 abort 的落败请求不重试，直接退出
        if ((err instanceof DOMException && err.name === 'AbortError')
          || (err instanceof Error && err.name === 'AbortError')) {
          return null;
        }
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
  ): Promise<(PlayUrlResult & { _candidateKey: string; _validated?: boolean }) | null> {
    const candidateKey = c.key || c.url;
    // v26：候选超时统一钳制 ≤ MAX_CANDIDATE_TIMEOUT（4s）——各源显式设置的宽松超时
    // （如酷我 nmobi 10s）在弱网下会串行叠加出 20s+ 的取链耗时（9/3 日志实证）
    const timeout = Math.min(c.timeout || BaseHttpSource.DEFAULT_CANDIDATE_TIMEOUT, BaseHttpSource.MAX_CANDIDATE_TIMEOUT);

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
        // 内容级防盗校验（子类可覆写；v27 默认实现为出站内容校验，见 validateContent）
        const contentValid = await this.validateContent(result, songId || '');
        if (contentValid) {
          // F3(v27 P0-2)：内容校验通过的候选打 _validated 标记——
          // 竞速层对 validated 结果立即胜出并 abort 其余候选，
          // 不再因 accurate=false 扣住等 settle（起播正确性优先于音质严格匹配等待）
          return { ...result, _candidateKey: candidateKey, _validated: true };
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
   * v27(F3/P0-2) 裁决修复：
   * - 内容校验通过（_validated）的候选**立即胜出并 abort 其余候选**——
   *   此前酷我 nmobi 320k 直链已通过内容校验却因 accurate=false 被扣为 firstInaccurate，
   *   必须等全部候选 settle；haitang 3s 超时拖住 settle 期间，2s 后启动的 QQ 坏链
   *   「成功」抢先、酷我在途结果被 abort（裁决矛盾真相，见 v27 排查结论）。
   * - accurate 候选先完成仍立即返回（原语义保留）。
   * - 都不满足时：accurate=false 的降级结果等全部 settle 后兜底返回（原语义保留）。
   * - onWinner：胜出即 abort 其余在途候选（F5，源内 AbortController 联动）。
   */
  private async raceWithAccuratePriority(
    promises: Promise<(PlayUrlResult & { _candidateKey: string; _validated?: boolean }) | null>[],
    onWinner?: () => void
  ): Promise<PlayUrlResult | null> {
    if (promises.length === 0) return null;
    if (promises.length === 1) return await promises[0];

    return new Promise((resolve) => {
      let resolved = false;
      let firstInaccurate: (PlayUrlResult & { _candidateKey: string }) | null = null;
      let remaining = promises.length;

      const win = (result: PlayUrlResult & { _candidateKey: string }) => {
        if (resolved) return;
        resolved = true;
        try { onWinner?.(); } catch { /* abort 回调不阻塞裁决 */ }
        resolve(result);
      };

      const tryResolve = () => {
        if (!resolved && remaining === 0 && firstInaccurate) {
          // 全部候选 settle 后才放行的降级结果，同样终止竞速
          win(firstInaccurate);
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
          // F3(v27)：内容校验通过（_validated）→ 立即胜出，不再扣住等 settle
          if (result._validated) { win(result); return; }
          if (this.isAccurateResult(result)) { win(result); return; }
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
   * F2(v27 P0-1b) + F6(v27 P2-1)：默认内容级出站校验。
   * 对竞速选中/待校验的直链做 Range GET 前 4KB 检查：
   * 1. contentType 为 JSON/HTML/text → 判候选失败（QQ musicu.fcg 1395 字节 JSON 坏链即此类）；
   * 2. 标准音频魔数（ID3 / MPEG sync / fLaC / OggS / RIFF-WAVE / ftyp / APE / ADIF）命中 → 放行；
   * 3. 加密格式（mflac/mgg/ncm 等，密文无音频魔数）→ 仅要求非文本类响应，真实校验在解密链路；
   * 4. 非加密且无已知音频魔数 → 判候选失败。
   * 校验只拦「不是音频」，不做音质降级——产品口径不变；
   * 时长比对仍仅 songDuration>0 时参与（v27 排查已证实 songDuration=0 不构成误杀）。
   * F6：同 URL single-flight（并发校验并 1 次）+ 60s TTL 内存缓存。
   */
  protected async validateContent(result: PlayUrlResult, _songId: string): Promise<boolean> {
    const cacheKey = `${result.url}|${result.headers ? Object.keys(result.headers).length : 0}`;
    const cached = BaseHttpSource.validationCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.ok;
    }
    const inflight = BaseHttpSource.validationInflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const task = this.doValidateContent(result);
    BaseHttpSource.validationInflight.set(cacheKey, task);
    try {
      const ok = await task;
      BaseHttpSource.validationCache.set(cacheKey, { ok, expiresAt: Date.now() + BaseHttpSource.VALIDATION_TTL });
      if (BaseHttpSource.validationCache.size > BaseHttpSource.VALIDATION_CACHE_MAX) {
        const now = Date.now();
        for (const [k, v] of BaseHttpSource.validationCache) {
          if (v.expiresAt < now) BaseHttpSource.validationCache.delete(k);
        }
        if (BaseHttpSource.validationCache.size > BaseHttpSource.VALIDATION_CACHE_MAX) {
          // 仍超限则整体清空（极端场景，60s 后自动重建）
          BaseHttpSource.validationCache.clear();
        }
      }
      return ok;
    } catch {
      // 校验请求本身异常（网络/超时）降级放行——弱网不误杀，与其他源 HEAD 失败降级策略一致
      return true;
    } finally {
      BaseHttpSource.validationInflight.delete(cacheKey);
    }
  }

  private async doValidateContent(result: PlayUrlResult): Promise<boolean> {
    const url = result.url;
    const isEncryptedFormat =
      /\.(mflac|mflac0|mgg|mgg1|ncm|qmc0|qmc3|qmcflac|ofl)(\?|#|$)/i.test(url) || result.format === 'mflac';
    try {
      const resp = await platformFetch(url, {
        method: 'GET',
        headers: { ...(result.headers || {}), Range: 'bytes=0-4095' },
        timeout: 3000,
        responseType: 'arraybuffer',
      });
      if (!resp.ok) {
        debugLogger.warn('network', `默认内容校验未通过：直链不可达`, {
          url: url.slice(0, 120),
          status: resp.status,
        });
        return false;
      }
      const contentType = (resp.headers.get('content-type') || '').toLowerCase();
      // v29 B6：Range 响应顺手捕获文件总长，供真实音质推算复用（省一次 HEAD 探测）
      const contentRange = resp.headers.get('content-range');
      if (contentRange) {
        const m = contentRange.match(/\/(\d+)\s*$/);
        const total = m ? parseInt(m[1], 10) : 0;
        if (total > 0) result.sizeBytes = total;
      }
      if (/(application\/json|text\/html|text\/plain|text\/xml)/.test(contentType)) {
        debugLogger.warn('network', `默认内容校验未通过：contentType 非音频`, {
          url: url.slice(0, 120),
          contentType,
        });
        return false;
      }

      // 只读前 4KB，避免 Range 未生效时整文件载入内存
      let bytes = new Uint8Array(0);
      const reader = resp.body?.getReader();
      if (reader) {
        try {
          const { value } = await reader.read();
          if (value) bytes = new Uint8Array(value);
        } finally {
          reader.cancel().catch(() => {});
        }
      } else {
        const ab = await resp.arrayBuffer();
        bytes = new Uint8Array(ab.slice(0, 4096));
      }
      if (bytes.length === 0) {
        debugLogger.warn('network', `默认内容校验未通过：响应体为空`, { url: url.slice(0, 120) });
        return false;
      }

      // 标准音频魔数命中即放行（顺序在文本判定前：ID3 首字节为可打印字符）
      if (hasAudioMagic(bytes)) {
        return true;
      }

      // 文本类响应体（JSON/HTML/纯文本直链）不是音频
      const first = bytes[0];
      const isTextLike =
        first === 0x7b /* { */ ||
        first === 0x3c /* < */ ||
        first === 0x5b /* [ */ ||
        (bytes.length >= 4 &&
          bytes[0] === 0x68 /* h */ &&
          bytes[1] === 0x74 /* t */ &&
          bytes[2] === 0x74 /* t */ &&
          bytes[3] === 0x70 /* p */);
      if (isTextLike) {
        debugLogger.warn('network', `默认内容校验未通过：响应体为文本类内容`, {
          url: url.slice(0, 120),
        });
        return false;
      }

      if (isEncryptedFormat) {
        // 加密格式密文无音频魔数：非文本类即放行，真实校验在解密链路（isDecryptedMagic）
        return true;
      }

      debugLogger.warn('network', `默认内容校验未通过：无已知音频魔数且非加密格式`, {
        url: url.slice(0, 120),
        format: result.format,
      });
      return false;
    } catch (err) {
      debugLogger.warn('network', `默认内容校验请求失败，降级放行`, {
        url: url.slice(0, 120),
        error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }

  /**
   * 解析播放URL响应，子类可覆写以处理平台特定的响应格式
   */
  protected async parsePlayUrlResponse(
    response: Response,
    candidate: EndpointCandidate,
    targetQuality: Quality
  ): Promise<PlayUrlResult | null> {
    const contentType = response.headers.get('content-type') || '';
    const contentLength = response.headers.get('content-length');

    // 如果是直接返回音频流（302重定向后的响应）
    if (contentType.includes('audio/') || contentType.includes('application/octet-stream')) {
      return {
        url: candidate.url,
        quality: targetQuality,
        bitrate: this.estimateBitrate(contentLength, targetQuality),
        format: this.detectFormat(contentType, candidate.url),
        headers: candidate.headers,
      };
    }

    // 默认尝试JSON解析
    try {
      const data = await response.json();
      const url = data?.url || data?.data?.url || data?.data;
      if (url && typeof url === 'string') {
        return {
          url,
          quality: targetQuality,
          bitrate: this.estimateBitrate(contentLength, targetQuality),
          format: this.detectFormat(contentType, candidate.url),
          headers: candidate.headers,
        };
      }
    } catch {
      // 非JSON响应，尝试文本解析
      const text = await response.text();
      if (text.startsWith('http')) {
        return {
          url: text.trim(),
          quality: targetQuality,
          bitrate: this.estimateBitrate(contentLength, targetQuality),
          format: this.detectFormat(contentType, candidate.url),
          headers: candidate.headers,
        };
      }
    }

    return null;
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

/**
 * F2(v27 P0-1b)：标准音频魔数检测（前 4KB 内）。
 * 覆盖：ID3(mp3) / MPEG frame sync / fLaC / OggS / RIFF(WAV) / ftyp(M4A/MP4) / APE 'MAC ' / ADIF。
 */
function hasAudioMagic(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  // ID3（mp3 带标签头）
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return true;
  // MPEG audio frame sync（0xFF Exxxxxxx）
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return true;
  // fLaC
  if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return true;
  // OggS
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return true;
  // RIFF（WAV）
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return true;
  // ftyp（M4A/MP4，位于偏移 4）
  if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return true;
  // 'MAC '（Monkey's Audio / APE）
  if (b[0] === 0x4d && b[1] === 0x41 && b[2] === 0x43 && b[3] === 0x20) return true;
  // ADIF（AAC）
  if (b[0] === 0x41 && b[1] === 0x44 && b[2] === 0x49 && b[3] === 0x46) return true;
  return false;
}
