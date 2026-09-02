/**
 * 歌单融合固定分类（v19.1）
 *
 * 用户要求：歌单与榜单一样做融合固定分类，展示顺序按 汽水 > 酷我 > 咪咕 > 网易云 > QQ > 酷狗。
 * 各源能力（接口文档实测，v19.1 全部走各源歌单广场真实接口，不用搜索凑数）：
 *  - 汽水：discover/mix 分类接口需登录态（实测免登录返回 EMPTY_RESULT），如实不提供分类歌单
 *  - 酷我：热门 getRcmPlayList + getTagList/getTagPlayList（完整分类）
 *  - 咪咕：musiclistplaza-taglist + listbytag（完整分类）
 *  - 网易云：/api/playlist/list?cat=（70 类，直接映射）
 *  - QQ：fcg_get_diss_tag_conf 分类树 + fcg_get_diss_by_tag 按分类取歌单（官方歌单广场接口）
 *  - 酷狗：仅热门歌单（plist/index），其他分类如实为空
 */

import { sourceRegistry } from '@providers/music/registry';
import type { PlaylistSummary } from './types';
import { getDisplayRank } from './platformPriority';

export interface PlaylistCategory {
  id: string;
  name: string;
}

/** 固定融合分类（歌单广场展示顺序） */
export const PLAYLIST_CATEGORIES: PlaylistCategory[] = [
  { id: 'hot', name: '热门推荐' },
  { id: 'huayu', name: '华语' },
  { id: 'oumei', name: '欧美' },
  { id: 'rihan', name: '日韩' },
  { id: 'liuxing', name: '流行' },
  { id: 'yaogun', name: '摇滚' },
  { id: 'minyao', name: '民谣' },
  { id: 'dianzi', name: '电子' },
  { id: 'shuochang', name: '说唱' },
  { id: 'gufeng', name: '古风' },
  { id: 'qingyinyue', name: '轻音乐' },
  { id: 'yingshi', name: '影视原声' },
];

export function getPlaylistCategoryName(id: string): string {
  return PLAYLIST_CATEGORIES.find((c) => c.id === id)?.name || id;
}

/** 单个源在该分类下的歌单集合 */
export interface SourcePlaylistGroup {
  sourceId: string;
  sourceName: string;
  playlists: PlaylistSummary[];
}

/**
 * 拉取指定分类下各源的歌单列表。
 * 展示顺序：汽水 > 酷我 > 咪咕 > 网易云 > QQ > 酷狗（getDisplayRank）。
 * 单个源失败不影响整体（best-effort）。
 */
export async function getCategoryPlaylists(
  categoryName: string,
  page = 0
): Promise<SourcePlaylistGroup[]> {
  const sources = sourceRegistry
    .getEnabled()
    .filter((s) => typeof s.getPlaylistsByCategory === 'function');

  const settled = await Promise.allSettled(
    sources.map(async (s) => ({
      source: s,
      playlists: await s.getPlaylistsByCategory!(categoryName, page),
    }))
  );

  const groups: SourcePlaylistGroup[] = [];
  for (const r of settled) {
    if (r.status !== 'fulfilled' || r.value.playlists.length === 0) continue;
    groups.push({
      sourceId: r.value.source.id,
      sourceName: r.value.source.name,
      playlists: r.value.playlists,
    });
  }

  groups.sort((a, b) => getDisplayRank(a.sourceId) - getDisplayRank(b.sourceId));
  return groups;
}
