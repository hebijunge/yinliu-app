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
 * 匹配策略（C5）：
 * 1. 归一化：去空白、转小写、移除常见装饰符号（括号/方括号/横线等）
 * 2. base key = 归一化title + '|' + 归一化artist（artist 按
 *    词边界切分取主歌手，避免 "Daft Punk" 被 "feat" 误伤等）
 * 3. 聚合时按 base key 分组，组内用 isSameSong/isSameMv 做
 *    时长 ±10s（MV ±15s）容差配对，不再用 duration 分桶生成二级 key
 *    —— 分桶会把 9s/11s 这类跨桶边界的同一录音错误拆开，
 *    也会把同桶内实际相差近 20s 的不同录音错误合并
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

/** 归一化歌手：按分隔符取主歌手。C5: 分隔符按词边界匹配（feat/ft/featuring），
 * 且先切分再去空白 —— 避免旧实现先把空白删掉导致 "Daft Punk" 中
 * 出现的子串被误当分隔符、或 "Hot Chip feat. ..." 之类被切错。 */
export function normalizeArtist(raw: string): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .split(/\s*(?:[、，,/&]|\bfeaturing\b|\bfeat\.?|\bft\.?)\s*/i)[0]
    .trim();
}

/** 构造主键（归一化 title|artist）。时长配对改在聚合阶段用
 * isSameSong 做 ±10s 容差比较，不再编入 key。 */
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

/** MV 归一化 key：歌名+歌手（时长配对在聚合阶段用 isSameMv ±15s 比较） */
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
    // C5: 按 base key 分组，组内用 isSameSong 做 ±10s 容差配对，
    // 替代原先的 duration 分桶二级 key（fallbackMap）方案。
    const groups = new Map<string, AggregatedSearchResult[]>();

    for (const sr of fulfilled) {
      for (const r of sr.results) {
        const key = makeKey(r.title, r.artist || '');
        const list = groups.get(key) || [];
        const existing = list.find((m) => isSameSong(m, r));

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
          // 首条记录缺封面/时长时用后续平台的记录补齐
          if (!existing.coverUrl && r.coverUrl) existing.coverUrl = r.coverUrl;
          if (!existing.duration && r.duration) existing.duration = r.duration;
        } else {
          list.push({
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
          groups.set(key, list);
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
    // C5: 按 base key 分组，组内用 isSameMv 做 ±15s 容差配对。
    const groups = new Map<string, AggregatedSearchResult[]>();

    for (const sr of fulfilled) {
      for (const r of sr.results) {
        const key = makeMvKey(r.title, r.artist || '');
        const list = groups.get(key) || [];
        const existing = list.find((m) => isSameMv(m, r));

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
          if (!existing.coverUrl && r.coverUrl) existing.coverUrl = r.coverUrl;
          if (!existing.duration && r.duration) existing.duration = r.duration;
        } else {
          list.push({
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
          });
          groups.set(key, list);
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
