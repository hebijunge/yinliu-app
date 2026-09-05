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
  /**
   * 分源到达回调：每个音源返回（或超时/失败）时立即触发一次，
   * 携带「已到达源」的聚合快照。搜索页用它做分源渐进展示，
   * 不必等最慢的源。
   */
  onPartial?: (snapshot: {
    results: AggregatedSearchResult[];
    sourceStats: Record<string, { total: number; latency: number; error?: string; errorType?: string }>;
  }) => void;
}

/**
 * 同曲识别：歌名+歌手归一化后做主键，时长容差用于合并同名但不同版本的曲目。
 *
 * 匹配策略：
 * 1. 归一化：去多余空白、转小写、移除常见装饰符号（括号/feat./live/remix 等）
 * 2. 主键 = 归一化title + '|' + 归一化artist
 * 3. 时长容差：±10 秒（DURATION_TOLERANCE_SEC，既能把同一录音的不同平台版本合并，
 *    又不会把 cover / live / remix 版本误并入原版）
 * 4. 同 base key 冲突时按 ±10s 容差做配对比较（对齐 isSameSong），不再创建带时长的二级 key
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
    // C5: 分隔符/feat 必须带词边界（\b），否则 "Daft Punk" 的 ft、"Loft" 会被误切；
    // 先按边界切出主歌手，再去空白，保证同一歌手不同空格写法归一到相同 key
    .split(/\s*(?:[、，,/&]|\bfeaturing\b|\bfeat\.?|\bft\.?)\s*/i)[0]
    .replace(/\s+/g, '')
    .trim();
}

/** 构造主键；C5: 去除时长分桶——固定桶在 ±tolerance 边界处会把同一录音切到两个 key，
 *  改为 base key 分组 + isSameSong 的 ±容差配对比较 */
export function makeKey(title: string, artist: string): string {
  return `${normalizeTitle(title)}|${normalizeArtist(artist)}`;
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

/** MV 归一化 key：歌名+歌手（C5: 同样去除时长分桶，配对交给 isSameMv 容差比较） */
function makeMvKey(title: string, artist: string): string {
  return `${normalizeTitle(title)}|${normalizeArtist(artist)}`;
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

    const searchType = params.type || 'song';

    // 非 song 类型时，过滤掉不支持该类型的源（避免源侧忽略 type 而返回歌曲结果污染列表）
    const usableSources = searchType === 'song'
      ? sources
      : sources.filter((s) => s.supportedSearchTypes?.includes(searchType));

    const fulfilled: SourceResult[] = [];

    const sourcePromises = usableSources.map(async (source) => {
      const sStart = Date.now();
      try {
        const results = await Promise.race([
          source.search(params),
          new Promise<SearchResult[]>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), options.timeout || 10000)
          ),
        ]);
        const sr: SourceResult = {
          source,
          results,
          latency: Date.now() - sStart,
          error: null as string | null,
        };
        fulfilled.push(sr);
        options.onPartial?.(this.buildSnapshot(fulfilled, searchType));
        return sr;
      } catch (err) {
        const sr: SourceResult = {
          source,
          results: [] as SearchResult[],
          latency: Date.now() - sStart,
          error: err instanceof Error ? err.message : 'Unknown error',
        };
        fulfilled.push(sr);
        options.onPartial?.(this.buildSnapshot(fulfilled, searchType));
        return sr;
      }
    });

    await Promise.allSettled(sourcePromises);
    return this.buildSnapshot(fulfilled, searchType);
  }

  /** 按已到达的源集合产出聚合快照（分源渐进展示与最终返回共用） */
  private buildSnapshot(fulfilled: SourceResult[], searchType: string): {
    results: AggregatedSearchResult[];
    sourceStats: Record<string, { total: number; latency: number; error?: string; errorType?: string }>;
  } {
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
    // C5: base key 分组 → 组内 isSameSong ±容差配对，取代旧的「分桶 key + fallbackMap 兜底」
    const groups = new Map<string, AggregatedSearchResult[]>();

    for (const sr of fulfilled) {
      for (const r of sr.results) {
        const key = makeKey(r.title, r.artist || '');
        let list = groups.get(key);
        if (!list) {
          list = [];
          groups.set(key, list);
        }

        const existing = list.find((m) => isSameSong(m, r));

        const sourceInfo: AggregatedSearchSource = {
          sourceId: sr.source.id,
          sourceName: sr.source.name,
          maxQuality: sr.source.maxQuality,
          available: true,
          sourceSongId: r.sourceSongId,
          sizes: r.sizes,
        };

        if (existing) {
          if (!existing.sources.find((s) => s.sourceId === sr.source.id)) {
            existing.sources.push(sourceInfo);
          }
          // 补全缺失的展示字段（封面/时长）
          if (!existing.coverUrl && r.coverUrl) existing.coverUrl = r.coverUrl;
          if (!existing.duration && r.duration) existing.duration = r.duration;
        } else {
          list.push({ ...r, sources: [sourceInfo] });
        }
      }
    }

    const results: AggregatedSearchResult[] = [];
    for (const list of groups.values()) {
      for (const r of list) {
        r.sources = sortByDisplayPriority(r.sources);
        const playBest = sortByPriority(r.sources)[0];
        if (playBest) {
          r.sourceId = playBest.sourceId;
          r.sourceSongId = playBest.sourceSongId;
        }
        results.push(r);
      }
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
    // C5: 与歌曲聚合一致——base key 分组 → 组内 isSameMv ±容差配对
    const groups = new Map<string, AggregatedSearchResult[]>();

    for (const sr of fulfilled) {
      for (const r of sr.results) {
        const key = makeMvKey(r.title, r.artist || '');
        let list = groups.get(key);
        if (!list) {
          list = [];
          groups.set(key, list);
        }

        const existing = list.find((m) => isSameMv(m, r));

        const sourceInfo: AggregatedSearchSource = {
          sourceId: sr.source.id,
          sourceName: sr.source.name,
          maxQuality: sr.source.maxQuality,
          available: true,
          sourceSongId: r.sourceSongId,
        };
        const mvInfo: MvSourceInfo = {
          sourceId: sr.source.id,
          sourceName: sr.source.name,
          sourceMvId: r.sourceSongId,
          availableQualities: [],
        };

        if (existing) {
          if (!existing.sources.find((s) => s.sourceId === sr.source.id)) {
            existing.sources.push(sourceInfo);
          }
          if (!existing.mvSources) existing.mvSources = [];
          if (!existing.mvSources.find((s) => s.sourceId === sr.source.id)) {
            existing.mvSources.push(mvInfo);
          }
        } else {
          list.push({
            ...r,
            sources: [sourceInfo],
            mvSources: [mvInfo],
          });
        }
      }
    }

    const results: AggregatedSearchResult[] = [];
    for (const list of groups.values()) {
      for (const r of list) {
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
