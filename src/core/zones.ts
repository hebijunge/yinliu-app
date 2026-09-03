/**
 * 专区聚合中枢（v20）
 *
 * 专区 = 按固定分类聚合的榜单 + 歌单，取数链路与曲库榜单/歌单完全一致：
 * - 榜单：v21.0 起 = 按固定分类取各源固定汇总榜单ID（文档 Section 4 口径）
 * - 歌单：复用 getCategoryPlaylists（分类名 best-effort 映射各源标签），无对应分类的源返回空、如实缺省
 * 当前专区：粤语专区（榜单分类 cantonese / 歌单分类「粤语」）、DJ专区（榜单分类 dj / 歌单分类「DJ」）
 */

import type { ClassifiedChart } from './charts';
import { getActiveMappings } from '../modules/chart/chartMappings';
import { sourceRegistry } from '@providers/music/registry';
import { getCategoryPlaylists, type SourcePlaylistGroup } from './playlistCategories';

export interface Zone {
  id: string;
  name: string;
  /** chartCategories 固定分类 id */
  chartCategoryId: string;
  /** 各源 best-effort 匹配的歌单分类名 */
  playlistCategoryName: string;
}

export const ZONES: Zone[] = [
  { id: 'cantonese', name: '粤语专区', chartCategoryId: 'cantonese', playlistCategoryName: '粤语' },
  { id: 'dj', name: 'DJ专区', chartCategoryId: 'dj', playlistCategoryName: 'DJ' },
];

export function getZoneById(id: string): Zone | undefined {
  return ZONES.find((z) => z.id === id);
}

/**
 * 一次拉取全部榜单并按专区切分（取全量再聚合，避免每个专区重复拉 6 源榜单）。
 * 单源失败不影响整体（getAllChartGroups 内部 best-effort）。
 */
export async function getZoneChartGroups(): Promise<Record<string, ClassifiedChart[]>> {
  // v21.0 口径修复：专区榜单 = 按固定分类取各源固定汇总榜单ID（不再取全量再归类）
  const result: Record<string, ClassifiedChart[]> = {};
  for (const zone of ZONES) {
    result[zone.id] = getActiveMappings(zone.chartCategoryId).map((m) => ({
      sourceId: m.sourceId,
      sourceName: sourceRegistry.get(m.sourceId)?.name || m.sourceId,
      chartId: m.chartId,
      chartName: m.chartName,
    }));
  }
  return result;
}

/** 拉取某专区的各源歌单（无对应分类的源自然缺省，不编造数据） */
export async function getZonePlaylists(zone: Zone): Promise<SourcePlaylistGroup[]> {
  return getCategoryPlaylists(zone.playlistCategoryName);
}
