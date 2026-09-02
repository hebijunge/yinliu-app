/**
 * 分类数据统一导出
 * 供 UI 子任务与榜单/歌单页面直接引用
 */

export {
  // 榜单分类
  RANK_CATEGORIES,
  RANK_CATEGORY_MAP,
  getRankPlatformMapping,
  isRankCategorySupported,
  getRankSupportedPlatforms,
} from './rankCategories';

export type {
  PlatformId,
  PlatformRankMapping,
  RankCategory,
} from './rankCategories';

export {
  PLATFORM_DISPLAY_ORDER,
  PLATFORM_META,
} from './rankCategories';

export {
  // 歌单分类
  PLAYLIST_CATEGORIES,
  PLAYLIST_CATEGORY_MAP,
  getPlaylistPlatformMapping,
  isPlaylistCategorySupported,
  getPlaylistSupportedPlatforms,
} from './playlistCategories';

export type {
  PlatformPlaylistMapping,
  PlaylistCategory,
} from './playlistCategories';
