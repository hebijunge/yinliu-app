import type { MusicSource } from '@providers/music/types';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult } from '@core/types';
import { sourceRegistry } from '@providers/music/registry';
import {
  PLATFORM_PRIORITY,
  getPriorityRank,
  sortByPriority,
} from '@core/platformPriority';

export interface AggregatedSearchSource {
  sourceId: string;
  sourceName: string;
  maxQuality: Quality;
  available: boolean;
  /** 该源下该曲的真实 songId（不同源同曲的 id 不同，必须按源记） */
  sourceSongId: string;
}

export interface AggregatedSearchResult extends SearchResult {
  sources: AggregatedSearchSource[];
}

export interface SearchEngineOptions {
  sources?: string[];
  timeout?: number;
}

/**
 * 同曲识别：歌名+歌手归一化后做主键，时长容差用于合并同名但不同版本的曲目。
 *
 * 匹配策略：
 * 1. 归一化：去多余空白、转小写、移除常见装饰符号（括号/feat./live/remix 等）
 * 2. 主键 = 归一化title + '|' + 归一化artist
 * 3. 时长容差：±5 秒（既能把同一录音的不同平台版本合并，
 *    又不会把 cover / live / remix 版本误并入原版）
 * 4. 若原 key 已存在但时长差 > 5s，则创建带时长的二级 key
 */
const DURATION_TOLERANCE_SEC = 10;

/** 归一化歌曲标题：去空白、小写、移除常见版本/装饰标记 */
function normalizeTitle(raw: string): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/（[^）]*）/g, '')   // 全角括号内容
    .replace(/\([^)]*\)/g, '')    // 半角括号内容
    .replace(/【[^】]*】/g, '')   // 中文方括号
    .replace(/\[[^\]]*\]/g, '')   // 英文方括号
    .replace(/[-_]/g, '')
    .trim();
}

/** 归一化歌手：去「/」、「&」、「feat.」、「、」等分隔符，取主歌手 */
function normalizeArtist(raw: string): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/\s+/g, '')
    .split(/[、，,/&]|feat\.?|ft\.?|featuring/i)[0]
    .trim();
}

/** 构造主键；duration 提供时附加二级 key 用于合并不同录音时长 */
function makeKey(title: string, artist: string, duration?: number): string {
  const t = normalizeTitle(title);
  const a = normalizeArtist(artist);
  const base = `${t}|${a}`;
  if (duration && duration > 0) {
    // 以 5s 桶分组（5s 内视作同一录音）
    const bucket = Math.floor(duration / DURATION_TOLERANCE_SEC);
    return `${base}|${bucket}`;
  }
  return base;
}

/** 同曲不同条目是否可视为「同一首歌」（用于合并：先试无时长 key，再放宽） */
function isSameSong(a: SearchResult, b: SearchResult): boolean {
  const ta = normalizeTitle(a.title);
  const tb = normalizeTitle(b.title);
  if (ta !== tb) return false;
  const aa = normalizeArtist(a.artist || '');
  const ab = normalizeArtist(b.artist || '');
  if (aa !== ab) return false;
  if (a.duration && b.duration) {
    return Math.abs(a.duration - b.duration) <= DURATION_TOLERANCE_SEC;
  }
  // 任一方没有时长 → 只能靠 title+artist 匹配
  return true;
}

export class SearchEngine {
  async search(
    params: SearchParams,
    options: SearchEngineOptions = {}
  ): Promise<{
    results: AggregatedSearchResult[];
    sourceStats: Record<string, { total: number; latency: number; error?: string; errorType?: string }>;
  }> {
    const sources = options.sources
      ? options.sources.map((id) => sourceRegistry.get(id)).filter(Boolean) as MusicSource[]
      : sourceRegistry.getEnabled();

    const startTime = Date.now();
    const sourcePromises = sources.map(async (source) => {
      const sStart = Date.now();
      try {
        const results = await Promise.race([
          source.search(params),
          new Promise<SearchResult[]>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), options.timeout || 10000)
          ),
        ]);
        return {
          source,
          results,
          latency: Date.now() - sStart,
          error: null as string | null,
        };
      } catch (err) {
        return {
          source,
          results: [] as SearchResult[],
          latency: Date.now() - sStart,
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      }
    });

    interface SourceResult {
      source: MusicSource;
      results: SearchResult[];
      latency: number;
      error: string | null;
    }

    const sourceResults = await Promise.allSettled(sourcePromises);
    const fulfilled = sourceResults
      .filter((r): r is PromiseFulfilledResult<SourceResult> => r.status === 'fulfilled')
      .map((r) => r.value);

    // === 同曲归并：把多平台的同一首歌合并成一条 AggregatedSearchResult ===
    // 优先按 (normalized title + artist + duration bucket) 做主键；
    // 若主键已存在但 isSameSong 判定失败，再单独建一条避免误并。
    const resultMap = new Map<string, AggregatedSearchResult>();
    const fallbackMap = new Map<string, AggregatedSearchResult>();

    for (const sr of fulfilled) {
      for (const r of sr.results) {
        const key = makeKey(r.title, r.artist || '', r.duration);
        let existing: AggregatedSearchResult | undefined = resultMap.get(key);

        // 若主键命中，但 isSameSong 严格判定不通过（典型：同名同歌手但时长差过大），
        // 则把它放进 fallbackMap，避免污染主键记录
        if (existing && !isSameSong(existing, r)) {
          existing = fallbackMap.get(key);
        }

        if (existing) {
          const sourceInfo: AggregatedSearchSource = {
            sourceId: sr.source.id,
            sourceName: sr.source.name,
            maxQuality: sr.source.maxQuality,
            available: true,
            sourceSongId: r.sourceSongId,
          };
          if (!existing.sources.find((s) => s.sourceId === sr.source.id)) {
            existing.sources.push(sourceInfo);
          }
        } else {
          const merged: AggregatedSearchResult = {
            ...r,
            sources: [{
              sourceId: sr.source.id,
              sourceName: sr.source.name,
              maxQuality: sr.source.maxQuality,
              available: true,
              sourceSongId: r.sourceSongId,
            }],
          };
          if (resultMap.has(key)) {
            fallbackMap.set(key, merged);
          } else {
            resultMap.set(key, merged);
          }
        }
      }
    }

    // 每个 result 的 sources 按优先级升序排，并把 result.sourceId / sourceSongId
    // 同步指向最高优先级平台（这样取链时无需再次选源）
    const results: AggregatedSearchResult[] = [];
    for (const r of resultMap.values()) {
      r.sources = sortByPriority(r.sources);
      const best = r.sources[0];
      if (best) {
        r.sourceId = best.sourceId;
        r.sourceSongId = best.sourceSongId;
      }
      results.push(r);
    }
    for (const r of fallbackMap.values()) {
      r.sources = sortByPriority(r.sources);
      const best = r.sources[0];
      if (best) {
        r.sourceId = best.sourceId;
        r.sourceSongId = best.sourceSongId;
      }
      results.push(r);
    }

    results.sort((a, b) => {
      // 排序：可用平台数 desc → 优先级（最高优先级的 rank）asc → 码率 desc
      const aSources = a.sources.length;
      const bSources = b.sources.length;
      if (bSources !== aSources) return bSources - aSources;
      const aRank = a.sources[0] ? getPriorityRank(a.sources[0].sourceId) : Number.MAX_SAFE_INTEGER;
      const bRank = b.sources[0] ? getPriorityRank(b.sources[0].sourceId) : Number.MAX_SAFE_INTEGER;
      if (aRank !== bRank) return aRank - bRank;
      return (b.bitrate || 0) - (a.bitrate || 0);
    });

    const sourceStats: Record<string, { total: number; latency: number; error?: string; errorType?: string }> = {};
    for (const sr of fulfilled) {
      sourceStats[sr.source.id] = {
        total: sr.results.length,
        latency: sr.latency,
        error: sr.error || undefined,
        errorType: sr.error ? (sr.error.includes('HTTP') ? 'http' : sr.error.includes('网络') || sr.error.includes('CORS') || sr.error.includes('超时') ? 'network' : 'unknown') : undefined,
      };
    }

    void startTime; // 保留时间记录（未使用仅供调试）
    // 暴露给读代码的人：优先级表当前为 PLATFORM_PRIORITY（去耦）
    void PLATFORM_PRIORITY;

    return { results, sourceStats };
  }
}

export const searchEngine = new SearchEngine();
