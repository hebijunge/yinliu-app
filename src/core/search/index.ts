import type { MusicSource } from '@providers/music/types';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult, TierSizes, MvSourceInfo } from '@core/types';
import { sourceRegistry } from '@providers/music/registry';
import {
  PLATFORM_PRIORITY,
  getPriorityRank,
  getDisplayRank,
  sortByPriority,
  sortByDisplayPriority,
} from '@core/platformPriority';

export interface AggregatedSearchSource {
  sourceId: string;
  sourceName: string;
  maxQuality: Quality;
  available: boolean;
  /** 该源下该曲的真实 songId（不同源同曲的 id 不同，必须按源记） */
  sourceSongId: string;
  /** 该源各音质档位文件大小（字节），音质弹窗展示用 */
  sizes?: TierSizes;
}

export interface AggregatedSearchResult extends SearchResult {
  sources: AggregatedSearchSource[];
  /** MV 多源聚合信息（仅 type='mv' 时由搜索引擎填充） */
  mvSources?: MvSourceInfo[];
}

interface SourceResult {
  source: MusicSource;
  results: SearchResult[];
  latency: number;
  error: string | null;
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
export function normalizeTitle(raw: string): string {
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
export function normalizeArtist(raw: string): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/\s+/g, '')
    .split(/[、，,/&]|feat\.?|ft\.?|featuring/i)[0]
    .trim();
}

/** 构造主键；duration 提供时附加二级 key 用于合并不同录音时长 */
export function makeKey(title: string, artist: string, duration?: number): string {
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
export function isSameSong(a: SearchResult, b: SearchResult): boolean {
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

/** MV 归一化 key：歌名+歌手（MV 时长容差放宽到 15s） */
function makeMvKey(title: string, artist: string, duration?: number): string {
  const t = normalizeTitle(title);
  const a = normalizeArtist(artist);
  const base = `${t}|${a}`;
  if (duration && duration > 0) {
    const bucket = Math.floor(duration / 15);
    return `${base}|${bucket}`;
  }
  return base;
}

/** 判断两个 MV 结果是否为同一支 MV */
function isSameMv(a: SearchResult, b: SearchResult): boolean {
  const ta = normalizeTitle(a.title);
  const tb = normalizeTitle(b.title);
  if (ta !== tb) return false;
  const aa = normalizeArtist(a.artist || '');
  const ab = normalizeArtist(b.artist || '');
  if (aa !== ab) return false;
  if (a.duration && b.duration) {
    return Math.abs(a.duration - b.duration) <= 15;
  }
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

    const sourceResults = await Promise.allSettled(sourcePromises);
    const fulfilled = sourceResults
      .filter((r): r is PromiseFulfilledResult<SourceResult> => r.status === 'fulfilled')
      .map((r) => r.value);

    const searchType = params.type || 'song';

    if (searchType === 'song') {
      return this.mergeSongResults(fulfilled);
    }

    if (searchType === 'mv') {
      return this.mergeMvResults(fulfilled);
    }

    // 歌手/专辑搜索：直接聚合，不归并
    return this.mergeGenericResults(fulfilled, searchType);
  }

  private mergeSongResults(fulfilled: SourceResult[]): {
    results: AggregatedSearchResult[];
    sourceStats: Record<string, { total: number; latency: number; error?: string; errorType?: string }>;
  } {
    const resultMap = new Map<string, AggregatedSearchResult>();
    const fallbackMap = new Map<string, AggregatedSearchResult>();

    for (const sr of fulfilled) {
      for (const r of sr.results) {
        const key = makeKey(r.title, r.artist || '', r.duration);
        let existing: AggregatedSearchResult | undefined = resultMap.get(key);

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
            sizes: r.sizes,
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
              sizes: r.sizes,
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

    const results: AggregatedSearchResult[] = [];
    for (const r of resultMap.values()) {
      r.sources = sortByDisplayPriority(r.sources);
      const playBest = sortByPriority(r.sources)[0];
      if (playBest) {
        r.sourceId = playBest.sourceId;
        r.sourceSongId = playBest.sourceSongId;
      }
      results.push(r);
    }
    for (const r of fallbackMap.values()) {
      r.sources = sortByDisplayPriority(r.sources);
      const playBest = sortByPriority(r.sources)[0];
      if (playBest) {
        r.sourceId = playBest.sourceId;
        r.sourceSongId = playBest.sourceSongId;
      }
      results.push(r);
    }

    results.sort((a, b) => {
      const aSources = a.sources.length;
      const bSources = b.sources.length;
      if (bSources !== aSources) return bSources - aSources;
      const aRank = a.sources[0] ? getDisplayRank(a.sources[0].sourceId) : Number.MAX_SAFE_INTEGER;
      const bRank = b.sources[0] ? getDisplayRank(b.sources[0].sourceId) : Number.MAX_SAFE_INTEGER;
      if (aRank !== bRank) return aRank - bRank;
      return (b.bitrate || 0) - (a.bitrate || 0);
    });

    const sourceStats = this.buildSourceStats(fulfilled);
    return { results, sourceStats };
  }

  /**
   * MV 多源聚合：同名同歌手的 MV 合并为一条，携带多源信息。
   * 与歌曲聚合的区别：
   * 1. 使用 makeMvKey（时长容差 15s）
   * 2. 填充 mvSources 供播放器切源使用
   * 3. 不排序码率，按平台数 + 展示优先级排序
   */
  private mergeMvResults(fulfilled: SourceResult[]): {
    results: AggregatedSearchResult[];
    sourceStats: Record<string, { total: number; latency: number; error?: string; errorType?: string }>;
  } {
    const resultMap = new Map<string, AggregatedSearchResult>();
    const fallbackMap = new Map<string, AggregatedSearchResult>();

    for (const sr of fulfilled) {
      for (const r of sr.results) {
        const key = makeMvKey(r.title, r.artist || '', r.duration);
        let existing: AggregatedSearchResult | undefined = resultMap.get(key);

        if (existing && !isSameMv(existing, r)) {
          existing = fallbackMap.get(key);
        }

        if (existing) {
          // 合并音频源信息（保持兼容）
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
          // 合并 MV 源信息
          const mvInfo: MvSourceInfo = {
            sourceId: sr.source.id,
            sourceName: sr.source.name,
            sourceMvId: r.sourceSongId,
            availableQualities: [],
          };
          if (!existing.mvSources) existing.mvSources = [];
          if (!existing.mvSources.find((s) => s.sourceId === sr.source.id)) {
            existing.mvSources.push(mvInfo);
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
            mvSources: [{
              sourceId: sr.source.id,
              sourceName: sr.source.name,
              sourceMvId: r.sourceSongId,
              availableQualities: [],
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

    const results: AggregatedSearchResult[] = [];
    for (const r of resultMap.values()) {
      r.sources = sortByDisplayPriority(r.sources);
      if (r.mvSources) {
        r.mvSources = sortByDisplayPriority(r.mvSources.map((s) => ({
          ...s,
          // 兼容 sortByDisplayPriority 需要的字段
          maxQuality: Quality.STANDARD,
          available: true,
          sourceSongId: s.sourceMvId,
        }))).map((s) => ({
          sourceId: s.sourceId,
          sourceName: s.sourceName,
          sourceMvId: s.sourceMvId,
          availableQualities: (s as any).availableQualities || [],
        }));
      }
      // 播放默认指向展示优先级最高的源
      const playBest = r.sources[0];
      if (playBest) {
        r.sourceId = playBest.sourceId;
        r.sourceSongId = playBest.sourceSongId;
      }
      results.push(r);
    }
    for (const r of fallbackMap.values()) {
      r.sources = sortByDisplayPriority(r.sources);
      if (r.mvSources) {
        r.mvSources = sortByDisplayPriority(r.mvSources.map((s) => ({
          ...s,
          maxQuality: Quality.STANDARD,
          available: true,
          sourceSongId: s.sourceMvId,
        }))).map((s) => ({
          sourceId: s.sourceId,
          sourceName: s.sourceName,
          sourceMvId: s.sourceMvId,
          availableQualities: (s as any).availableQualities || [],
        }));
      }
      const playBest = r.sources[0];
      if (playBest) {
        r.sourceId = playBest.sourceId;
        r.sourceSongId = playBest.sourceSongId;
      }
      results.push(r);
    }

    // MV 排序：平台数 desc → 展示优先级 asc
    results.sort((a, b) => {
      const aSources = a.mvSources?.length || a.sources.length;
      const bSources = b.mvSources?.length || b.sources.length;
      if (bSources !== aSources) return bSources - aSources;
      const aRank = a.sources[0] ? getDisplayRank(a.sources[0].sourceId) : Number.MAX_SAFE_INTEGER;
      const bRank = b.sources[0] ? getDisplayRank(b.sources[0].sourceId) : Number.MAX_SAFE_INTEGER;
      return aRank - bRank;
    });

    const sourceStats = this.buildSourceStats(fulfilled);
    return { results, sourceStats };
  }

  private mergeGenericResults(fulfilled: SourceResult[], _searchType: string): {
    results: AggregatedSearchResult[];
    sourceStats: Record<string, { total: number; latency: number; error?: string; errorType?: string }>;
  } {
    const results: AggregatedSearchResult[] = [];

    for (const sr of fulfilled) {
      for (const r of sr.results) {
        results.push({
          ...r,
          sources: [{
            sourceId: sr.source.id,
            sourceName: sr.source.name,
            maxQuality: sr.source.maxQuality,
            available: true,
            sourceSongId: r.sourceSongId,
            sizes: r.sizes,
          }],
        });
      }
    }

    const sourceStats = this.buildSourceStats(fulfilled);
    return { results, sourceStats };
  }

  private buildSourceStats(fulfilled: SourceResult[]): Record<string, { total: number; latency: number; error?: string; errorType?: string }> {
    const sourceStats: Record<string, { total: number; latency: number; error?: string; errorType?: string }> = {};
    for (const sr of fulfilled) {
      sourceStats[sr.source.id] = {
        total: sr.results.length,
        latency: sr.latency,
        error: sr.error || undefined,
        errorType: sr.error ? (sr.error.includes('HTTP') ? 'http' : sr.error.includes('网络') || sr.error.includes('CORS') || sr.error.includes('超时') ? 'network' : 'unknown') : undefined,
      };
    }
    return sourceStats;
  }
}

export const searchEngine = new SearchEngine();
