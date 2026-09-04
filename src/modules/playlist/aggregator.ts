/**
 * 歌单聚合器
 * 按固定分类，依次展示各个源在对应分类的结果（分源顺序展示，不是混排）
 *
 * 当前实现：由于用户文档主要覆盖榜单映射，歌单聚合采用"榜单即歌单"策略——
 * 各源在固定分类下的官方榜单作为该分类的代表歌单，分源依次展示。
 * 榜单本身即为平台官方歌单，具有封面、名称、歌曲列表等完整歌单属性。
 */
import type { SearchResult } from '@core/types';
import { sourceRegistry } from '@providers/music/registry';
import { getActiveMappings } from '@modules/chart/chartMappings';

export interface PlaylistItem {
  id: string;
  name: string;
  description?: string;
  coverUrl?: string;
  sourceId: string;
  sourceName: string;
  songCount: number;
  songs?: SearchResult[];
}

export interface SourcePlaylistResult {
  sourceId: string;
  sourceName: string;
  playlists: PlaylistItem[];
  error?: string;
}

/**
 * 按融合分类聚合歌单
 * 各源并行拉取固定榜单ID作为歌单，返回按源分组的结果
 */
export async function aggregatePlaylistsByCategory(
  categoryId: string
): Promise<SourcePlaylistResult[]> {
  const mappings = getActiveMappings(categoryId);
  if (mappings.length === 0) return [];

  const promises = mappings.map(async (m) => {
    const source = sourceRegistry.get(m.sourceId);
    if (!source || !source.getChartDetail) {
      return {
        sourceId: m.sourceId,
        sourceName: source?.name || m.sourceId,
        playlists: [],
        error: '源未启用或不支持',
      };
    }

    try {
      const detail = await source.getChartDetail(m.chartId);
      const playlist: PlaylistItem = {
        id: m.chartId,
        name: detail.name || m.chartName,
        description: detail.description || `${source.name} · ${m.chartName}`,
        coverUrl: detail.songs?.[0]?.coverUrl || '',
        sourceId: m.sourceId,
        sourceName: source.name,
        songCount: detail.songs?.length || 0,
        songs: detail.songs?.slice(0, 5), // 预览前5首
      };
      return {
        sourceId: m.sourceId,
        sourceName: source.name,
        playlists: [playlist],
      };
    } catch (err) {
      return {
        sourceId: m.sourceId,
        sourceName: source.name,
        playlists: [],
        error: err instanceof Error ? err.message : '获取失败',
      };
    }
  });

  return Promise.all(promises);
}
