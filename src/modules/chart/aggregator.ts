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
 */
export async function aggregateChartsByCategory(
  categoryId: string
): Promise<SourceChartResult[]> {
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

  return Promise.all(promises);
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
