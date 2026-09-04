/**
 * 榜单聚合器
 * 按固定分类取各源固定榜单ID拉取，不再「取全量→按分类聚合」
 */
import type { SearchResult, ChartDetail } from '@core/types';
import { sourceRegistry } from '@providers/music/registry';
import { getActiveMappings } from './chartMappings';

export interface AggregatedChartSong extends SearchResult {
  rank?: number;
  sourceName?: string;
}

export interface SourceChartResult {
  sourceId: string;
  sourceName: string;
  chartId: string;
  chartName: string;
  songs: AggregatedChartSong[];
  error?: string;
}

/**
 * 按融合分类聚合榜单
 * 各源并行拉取固定榜单ID，返回按源分组的结果（歌单聚合模式：分源依次展示）
 *
 * v22 D4: TTL 缓存——结果缓存 5 分钟，消除同分类短时间内的重复聚合请求
 * （此前 ChartPage 先 aggregate 再 merge，merge 内部又 aggregate，双倍请求）；
 * 空结果也写入短 TTL 的负缓存（2 分钟），防止源异常时每次进入页面都全量重打。
 */
const AGGREGATE_CACHE_TTL = 5 * 60 * 1000;
const AGGREGATE_EMPTY_CACHE_TTL = 2 * 60 * 1000;
const aggregateCache = new Map<string, { result: SourceChartResult[]; expiresAt: number }>();

export async function aggregateChartsByCategory(
  categoryId: string
): Promise<SourceChartResult[]> {
  const cached = aggregateCache.get(categoryId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const mappings = getActiveMappings(categoryId);
  if (mappings.length === 0) return [];

  const promises = mappings.map(async (m) => {
    const source = sourceRegistry.get(m.sourceId);
    if (!source || !source.getChartDetail) {
      return {
        sourceId: m.sourceId,
        sourceName: source?.name || m.sourceId,
        chartId: m.chartId,
        chartName: m.chartName,
        songs: [],
        error: '源未启用或不支持榜单详情',
      };
    }

    try {
      const detail = await source.getChartDetail(m.chartId);
      const songs: AggregatedChartSong[] = detail.songs.map((song, idx) => ({
        ...song,
        rank: idx + 1,
        sourceName: source.name,
      }));
      return {
        sourceId: m.sourceId,
        sourceName: source.name,
        chartId: m.chartId,
        chartName: detail.name || m.chartName,
        songs,
      };
    } catch (err) {
      return {
        sourceId: m.sourceId,
        sourceName: source.name,
        chartId: m.chartId,
        chartName: m.chartName,
        songs: [],
        error: err instanceof Error ? err.message : '获取失败',
      };
    }
  });

  const result = await Promise.all(promises);

  // v22 D4: 写缓存（空结果用短 TTL 负缓存，防失败循环重试）
  const hasData = result.some((r) => r.songs.length > 0);
  aggregateCache.set(categoryId, {
    result,
    expiresAt: Date.now() + (hasData ? AGGREGATE_CACHE_TTL : AGGREGATE_EMPTY_CACHE_TTL),
  });

  return result;
}

/**
 * 按融合分类聚合榜单歌曲并混排（榜单聚合模式：混合展示）
 * 取各源前N首，按排名交错合并
 */
export async function mergeChartSongsByCategory(
  categoryId: string,
  topNPerSource = 20
): Promise<AggregatedChartSong[]> {
  const sourceResults = await aggregateChartsByCategory(categoryId);
  const validResults = sourceResults.filter((r) => r.songs.length > 0);

  // 交错合并：各源第1名 -> 各源第2名 -> ...
  const merged: AggregatedChartSong[] = [];
  let rankIndex = 0;
  let hasMore = true;

  while (hasMore) {
    hasMore = false;
    for (const result of validResults) {
      const song = result.songs[rankIndex];
      if (song && rankIndex < topNPerSource) {
        merged.push(song);
        hasMore = true;
      }
    }
    rankIndex++;
  }

  return merged;
}
