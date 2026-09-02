/**
 * 歌单固定融合分类数据
 * 来源：各平台歌单分类接口文档综合梳理
 * 平台优先级（展示排序）：汽水→酷我→咪咕→网易云→QQ→酷狗
 * 平台缩写：qi=汽水, kw=酷我, mg=咪咕, wy=网易云, qq=QQ, kg=酷狗
 *
 * 设计原则：
 * 1. 融合分类基于各平台歌单分类共性提炼，优先覆盖汽水/酷我/咪咕/网易云明确支持的标签
 * 2. 参数仅写入文档中明确给出的请求参数；不明确的用 matchName 运行时匹配
 * 3. 网易云歌单分类使用 cat 字符串参数；汽水使用 sub_channel_id 数字参数
 * 4. 酷狗无明确歌单分类标签接口，该分类映射留空（运行时走推荐或搜索兜底）
 */

/** 平台缩写（与 rankCategories.ts 保持一致，避免循环依赖） */
export type PlatformId = 'qi' | 'kw' | 'mg' | 'wy' | 'qq' | 'kg';

export interface PlatformPlaylistMapping {
  /**
   * 该平台该分类的请求参数。
   * 不同平台参数形态不同：
   * - 网易云 wy: { cat: '流行' }
   * - 汽水   qi: { subChannelId: 1 }
   * - 酷我   kw: { tagId: 'xxx' }
   * - 咪咕   mg: { tagId: 'xxx' }
   * - QQ    qq: { classId: 'xxx' }
   * - 酷狗   kg: 无明确分类接口，通常为空
   */
  params?: Record<string, string | number>;
  /**
   * 运行时名称匹配关键词（用于从平台 /getPlaylistCategories API 返回中按名称匹配）
   */
  matchNames?: string[];
}

export interface PlaylistCategory {
  /** 分类唯一标识（英文，代码内使用） */
  id: string;
  /** 分类显示名称（中文） */
  name: string;
  /** 该分类明确支持的平台数（基于文档统计） */
  platformCount: number;
  /** 各平台映射：key 为平台缩写 */
  platforms: Partial<Record<PlatformId, PlatformPlaylistMapping>>;
}

// =============================================================================
// 20 个固定歌单分类（融合各平台歌单标签共性）
// =============================================================================

export const PLAYLIST_CATEGORIES: PlaylistCategory[] = [
  {
    id: 'pop',
    name: '流行',
    platformCount: 5,
    platforms: {
      qi: { params: { subChannelId: 1 }, matchNames: ['流行'] },
      wy: { params: { cat: '流行' }, matchNames: ['流行'] },
      kw: { matchNames: ['流行'] },
      mg: { matchNames: ['流行'] },
      qq: { matchNames: ['流行'] },
    },
  },
  {
    id: 'rock',
    name: '摇滚',
    platformCount: 4,
    platforms: {
      qi: { params: { subChannelId: 2 }, matchNames: ['摇滚'] },
      wy: { params: { cat: '摇滚' }, matchNames: ['摇滚'] },
      kw: { matchNames: ['摇滚'] },
      qq: { matchNames: ['摇滚'] },
    },
  },
  {
    id: 'folk',
    name: '民谣',
    platformCount: 4,
    platforms: {
      qi: { params: { subChannelId: 3 }, matchNames: ['民谣'] },
      wy: { params: { cat: '民谣' }, matchNames: ['民谣'] },
      kw: { matchNames: ['民谣'] },
      qq: { matchNames: ['民谣'] },
    },
  },
  {
    id: 'electronic',
    name: '电子',
    platformCount: 4,
    platforms: {
      qi: { params: { subChannelId: 4 }, matchNames: ['电子'] },
      wy: { params: { cat: '电子' }, matchNames: ['电子'] },
      kw: { matchNames: ['电子', '电音'] },
      qq: { matchNames: ['电子', '电音'] },
    },
  },
  {
    id: 'rap',
    name: '说唱',
    platformCount: 4,
    platforms: {
      qi: { params: { subChannelId: 5 }, matchNames: ['说唱'] },
      wy: { params: { cat: '说唱' }, matchNames: ['说唱'] },
      kw: { matchNames: ['说唱'] },
      qq: { matchNames: ['说唱'] },
    },
  },
  {
    id: 'rnb',
    name: 'R&B',
    platformCount: 3,
    platforms: {
      qi: { params: { subChannelId: 6 }, matchNames: ['R&B', 'RNB'] },
      wy: { params: { cat: 'R&B' }, matchNames: ['R&B', 'RNB'] },
      qq: { matchNames: ['R&B', 'RNB'] },
    },
  },
  {
    id: 'chineseStyle',
    name: '国风',
    platformCount: 4,
    platforms: {
      wy: { params: { cat: '国风' }, matchNames: ['国风', '古风'] },
      kw: { matchNames: ['古风', '国风'] },
      mg: { matchNames: ['国风'] },
      qq: { matchNames: ['国风', '古风'] },
    },
  },
  {
    id: 'western',
    name: '欧美',
    platformCount: 4,
    platforms: {
      wy: { params: { cat: '欧美' }, matchNames: ['欧美'] },
      kw: { matchNames: ['欧美'] },
      mg: { matchNames: ['欧美'] },
      qq: { matchNames: ['欧美'] },
    },
  },
  {
    id: 'jpkorean',
    name: '日韩',
    platformCount: 3,
    platforms: {
      wy: { params: { cat: '日语' }, matchNames: ['日语', '韩语', '日韩'] },
      kw: { matchNames: ['日韩', '日语', '韩语'] },
      qq: { matchNames: ['日本', '韩国', '日韩'] },
    },
  },
  {
    id: 'chinese',
    name: '华语',
    platformCount: 4,
    platforms: {
      wy: { params: { cat: '华语' }, matchNames: ['华语'] },
      kw: { matchNames: ['华语'] },
      mg: { matchNames: ['华语'] },
      qq: { matchNames: ['华语', '内地', '港台'] },
    },
  },
  {
    id: 'dj',
    name: 'DJ舞曲',
    platformCount: 3,
    platforms: {
      wy: { params: { cat: 'DJ' }, matchNames: ['DJ', '舞曲'] },
      kw: { matchNames: ['DJ', '电音', '万物DJ'] },
      qq: { matchNames: ['DJ', '舞曲'] },
    },
  },
  {
    id: 'ost',
    name: '影视综艺',
    platformCount: 3,
    platforms: {
      wy: { params: { cat: '影视原声' }, matchNames: ['影视', '综艺', '原声', 'OST'] },
      kw: { matchNames: ['影视'] },
      qq: { matchNames: ['影视', '综艺'] },
    },
  },
  {
    id: 'acg',
    name: 'ACG动漫',
    platformCount: 3,
    platforms: {
      wy: { params: { cat: 'ACG' }, matchNames: ['ACG', '动漫', '游戏', '二次元'] },
      kg: { matchNames: ['ACG'] },
      qq: { matchNames: ['动漫', '游戏'] },
    },
  },
  {
    id: 'retro',
    name: '经典怀旧',
    platformCount: 3,
    platforms: {
      wy: { params: { cat: '怀旧' }, matchNames: ['怀旧', '经典', '老歌'] },
      kw: { matchNames: ['经典', '怀旧'] },
      qq: { matchNames: ['经典', '怀旧'] },
    },
  },
  {
    id: 'light',
    name: '轻音乐',
    platformCount: 3,
    platforms: {
      wy: { params: { cat: '轻音乐' }, matchNames: ['轻音乐', '纯音乐'] },
      kg: { matchNames: ['纯音乐'] },
      qq: { matchNames: ['轻音乐', '纯音乐'] },
    },
  },
  {
    id: 'healing',
    name: '治愈',
    platformCount: 3,
    platforms: {
      qi: { params: { subChannelId: 69 }, matchNames: ['治愈'] },
      wy: { params: { cat: '治愈' }, matchNames: ['治愈'] },
      qq: { matchNames: ['治愈'] },
    },
  },
  {
    id: 'study',
    name: '学习',
    platformCount: 2,
    platforms: {
      qi: { params: { subChannelId: 40 }, matchNames: ['学习'] },
      wy: { params: { cat: '学习' }, matchNames: ['学习', '工作'] },
    },
  },
  {
    id: 'workout',
    name: '运动',
    platformCount: 2,
    platforms: {
      wy: { params: { cat: '运动' }, matchNames: ['运动', '健身', '跑步'] },
      kw: { matchNames: ['运动', '健身', '跑步'] },
    },
  },
  {
    id: 'sleep',
    name: '睡前',
    platformCount: 2,
    platforms: {
      qi: { params: { subChannelId: 45 }, matchNames: ['睡前'] },
      wy: { params: { cat: '睡前' }, matchNames: ['睡前', '助眠'] },
    },
  },
  {
    id: 'other',
    name: '其他',
    platformCount: 4,
    platforms: {
      wy: { params: { cat: '其他' }, matchNames: ['其他', '儿童', '儿歌', '爵士', '乡村', '古典', '戏曲'] },
      kg: { matchNames: ['儿童', '儿歌', '爵士', '乡村', '古典', '戏曲'] },
      kw: { matchNames: ['儿童', '儿歌', '爵士', '乡村', '古典', '相声'] },
      qq: { matchNames: ['儿童', '儿歌', '爵士', '乡村', '古典'] },
    },
  },
];

/** 按 ID 快速查找分类的 Map */
export const PLAYLIST_CATEGORY_MAP: Map<string, PlaylistCategory> = new Map(
  PLAYLIST_CATEGORIES.map((c) => [c.id, c])
);

/** 获取某分类在某平台的映射信息 */
export function getPlaylistPlatformMapping(
  categoryId: string,
  platform: PlatformId
): PlatformPlaylistMapping | undefined {
  return PLAYLIST_CATEGORY_MAP.get(categoryId)?.platforms[platform];
}

/** 判断某平台是否支持某分类 */
export function isPlaylistCategorySupported(categoryId: string, platform: PlatformId): boolean {
  return !!PLAYLIST_CATEGORY_MAP.get(categoryId)?.platforms[platform];
}

/** 平台展示顺序（UI 列表排序用） */
const PLATFORM_DISPLAY_ORDER: PlatformId[] = ['qi', 'kw', 'mg', 'wy', 'qq', 'kg'];

/** 获取某分类支持的所有平台列表（按展示顺序排序） */
export function getPlaylistSupportedPlatforms(categoryId: string): PlatformId[] {
  const cat = PLAYLIST_CATEGORY_MAP.get(categoryId);
  if (!cat) return [];
  return PLATFORM_DISPLAY_ORDER.filter((p) => cat.platforms[p]);
}
