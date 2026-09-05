/**
 * PlaylistMatcher - 歌单导入的取链降级与匹配
 *
 * v14 核心需求：导入外部歌单后，播放时按取链优先级降级到其他平台匹配，
 * 全平台都匹配失败则标灰显示原因。
 *
 * 工作流程（每首曲目）：
 * 1. 先用曲目原始 source 试取链（成功率最高、延迟最低）
 * 2. 失败则用 searchEngine 按 title+artist 搜索其余平台，挑优先级最高且可取链的
 * 3. 全失败则标记 failed，写明失败原因（无版权 / 全平台无结果 / 网络）
 *
 * 注意：本服务只做"匹配与降级"判定，不直接持久化；
 * 持久化由 playlistImporter.importPlaylistAndPersist 统一处理。
 */

import type { SearchResult, PlaylistDetail } from '@core/types';
import { YinliuError, ErrorCode } from '@core/types';
import { sourceRegistry } from '@providers/music/registry';
import { searchEngine } from '@core/search';
import { PLATFORM_PRIORITY, isKnownPlatform, getPriorityRank } from '@core/platformPriority';
import { platformFetch } from '@shared/utils/platformFetch';

export type TrackMatchStatus =
  | 'matched' // 原平台取链成功
  | 'fallback' // 降级到其他平台匹配成功
  | 'failed'; // 全平台匹配失败

export interface MatchedTrack {
  /** 原始曲目（来自导入歌单） */
  original: SearchResult;
  /** 实际可用于播放的曲目（matched/fallback 时非空；failed 时为 null） */
  resolved: SearchResult | null;
  /** 实际命中的平台 ID（fallback 时与 original.sourceId 不同） */
  resolvedSourceId: string;
  status: TrackMatchStatus;
  /** 失败原因（仅 failed 时存在） */
  failureReason?: string;
}

export interface MatchReport {
  total: number;
  matched: number;
  fallback: number;
  failed: number;
  tracks: MatchedTrack[];
  /** 失败原因分布（统计用） */
  failureReasons: Record<string, number>;
}

export interface MatchOptions {
  /** 单首曲目的取链超时（毫秒） */
  probeTimeoutMs?: number;
  /** 是否对每首曲目都做探活（false 则仅做原平台取链，失败再搜索） */
  probeAllSources?: boolean;
  /** 单歌单最大并发搜索数（避免触发的 too many requests） */
  concurrency?: number;
}

const DEFAULT_OPTIONS: Required<MatchOptions> = {
  probeTimeoutMs: 4000,
  probeAllSources: false,
  concurrency: 4,
};

/** 把搜索结果归一化用于"同一首歌"粗判：title 去括号/空白、artist 取主歌手 */
function normalizeKey(s: SearchResult): string {
  const t = (s.title || '').toLowerCase().replace(/\s+/g, '').replace(/[\(\uff08][^\)\uff09]*[\)\uff09]/g, '');
  const a = (s.artist || '').toLowerCase().split(/[,\/\u3001&]|feat\.?|ft\.?/i)[0].trim();
  return `${t}|${a}`;
}

/** 简易 in-flight 去重：相同 key 同时只跑一次 */
const inflight = new Map<string, Promise<MatchedTrack>>();

export class PlaylistMatcher {
  /**
   * 对一首导入曲目做"原平台取链 → 失败降级到其他平台搜索"的完整流程
   */
  async matchOne(track: SearchResult, opts: MatchOptions = {}): Promise<MatchedTrack> {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    const cacheKey = `${track.id}|${track.title}|${track.artist}`;
    if (inflight.has(cacheKey)) {
      return inflight.get(cacheKey)!;
    }
    const p = this._matchOneImpl(track, options);
    inflight.set(cacheKey, p);
    // TTL 兜底：防止挂起 promise 永久残留于全局 Map
    const ttl = setTimeout(() => inflight.delete(cacheKey), 60_000);
    try {
      return await p;
    } finally {
      clearTimeout(ttl);
      inflight.delete(cacheKey);
    }
  }

  private async _matchOneImpl(track: SearchResult, opts: Required<MatchOptions>): Promise<MatchedTrack> {
    // 1. 原平台取链探活
    const originalOk = await this.probePlayUrl(track, opts.probeTimeoutMs);
    if (originalOk) {
      return {
        original: track,
        resolved: track,
        resolvedSourceId: track.sourceId,
        status: 'matched',
      };
    }

    // 2. 跨平台搜索降级
    const fallback = await this.searchFallback(track, opts);
    if (fallback) {
      return {
        original: track,
        resolved: fallback,
        resolvedSourceId: fallback.sourceId,
        status: 'fallback',
      };
    }

    // 3. 全失败
    return {
      original: track,
      resolved: null,
      resolvedSourceId: track.sourceId,
      status: 'failed',
      failureReason: this.failureReason(track),
    };
  }

  /**
   * 对整张导入歌单做匹配（受限并发）
   */
  async matchAll(playlist: PlaylistDetail, opts: MatchOptions = {}): Promise<MatchReport> {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    const concurrency = Math.max(1, options.concurrency);

    const tracks: MatchedTrack[] = [];
    let cursor = 0;

    const worker = async () => {
      while (cursor < playlist.songs.length) {
        const idx = cursor++;
        const t = playlist.songs[idx];
        const m = await this.matchOne(t, opts);
        tracks[idx] = m;
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    // 统计
    const report: MatchReport = {
      total: playlist.songs.length,
      matched: 0,
      fallback: 0,
      failed: 0,
      tracks,
      failureReasons: {},
    };
    for (const t of tracks) {
      if (t.status === 'matched') report.matched++;
      else if (t.status === 'fallback') report.fallback++;
      else {
        report.failed++;
        const reason = t.failureReason || '未知原因';
        report.failureReasons[reason] = (report.failureReasons[reason] || 0) + 1;
      }
    }
    return report;
  }

  /**
   * 用原平台做一次取链探活（短超时，避免外部歌单卡住整次导入）
   * 对 local 源直接视为成功（本地曲无需远端取链）
   */
  private async probePlayUrl(track: SearchResult, timeoutMs: number): Promise<boolean> {
    if (track.sourceId === 'local') return true;
    const source = sourceRegistry.get(track.sourceId);
    if (!source) return false;
    const controller = new AbortController();
    const tm = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // 通过 baseHttpSource.linkRace 路径不直接暴露；走 getPlayUrl + short timeout
      const url = await Promise.race([
        source.getPlayUrl(track.sourceSongId, 'standard' as any),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('probe-timeout')), { once: true });
        }),
      ]);
      if (!url || !url.url) return false;
      if (url.isPreview) return false;
      // C7: HEAD 探活对 CDN 常被 403/405 误判（如酷我/部分 CDN 禁 HEAD）导致导入匹配率虚低，
      // 改用 Range: bytes=0-1 的 GET：只拉 2 字节，能确认资源真实可访问
      const probe = await platformFetch(url.url, {
        method: 'GET',
        headers: { Range: 'bytes=0-1' },
        signal: controller.signal,
      }).catch(() => null);
      // 206 Partial Content / 200 OK 均视为可访问
      if (probe) {
        await probe.body?.cancel().catch(() => {});
      }
      return Boolean(probe && (probe.status === 206 || probe.ok));
    } catch {
      return false;
    } finally {
      clearTimeout(tm);
    }
  }

  /**
   * 跨平台搜索降级：用 title+artist 搜其他源，挑优先级最高且归一化键匹配的
   */
  private async searchFallback(track: SearchResult, opts: Required<MatchOptions>): Promise<SearchResult | null> {
    const originalKey = normalizeKey(track);
    const excludedSources = new Set<string>([track.sourceId]);
    try {
      const { results } = await searchEngine.search(
        { keyword: this.buildSearchKeyword(track), pageSize: 10 },
        { timeout: opts.probeTimeoutMs * 2 }
      );
      // 按优先级过滤 + 排序 + 键匹配
      const candidates = results
        .filter((r) => !excludedSources.has(r.sourceId) && isKnownPlatform(r.sourceId))
        .map((r) => ({ r, key: normalizeKey(r), rank: getPriorityRank(r.sourceId) }))
        .filter((c) => c.key === originalKey)
        .sort((a, b) => a.rank - b.rank);

      if (candidates.length === 0) return null;

      // 取优先级最高的候选，验证其可取链
      for (const c of candidates) {
        const ok = await this.probePlayUrl(c.r, opts.probeTimeoutMs);
        if (ok) return c.r;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 构造搜索关键词：title + 第一个主要艺术家
   */
  private buildSearchKeyword(track: SearchResult): string {
    const mainArtist = (track.artist || '').split(/[,\/\u3001&]/)[0].trim();
    if (mainArtist && !track.title.includes(mainArtist)) {
      return `${mainArtist} ${track.title}`.trim();
    }
    return track.title || '';
  }

  /**
   * 失败原因归类：用于 UI 展示（"全平台无版权"/"全平台无结果"/"网络错误"）
   */
  private failureReason(track: SearchResult): string {
    if (!track.title && !track.artist) return '曲目元数据为空';
    return '全平台暂无版权或匹配';
  }
}

export const playlistMatcher = new PlaylistMatcher();
