/**
 * 榜单固定融合分类数据
 * 来源：《6平台音乐榜单名称与分类完整梳理.md》第四章 20 个合并分类方案
 * 平台优先级（展示排序）：汽水→酷我→咪咕→网易云→QQ→酷狗
 * 平台缩写：qi=汽水, kw=酷我, mg=咪咕, wy=网易云, qq=QQ, kg=酷狗
 *
 * 设计原则：
 * 1. 分类名称与文档第四章完全一致，不自行发明分类
 * 2. chartId 仅写入文档中明确给出的真实榜单 ID
 * 3. matchKeywords 用于运行时从各平台 /getCharts API 返回的列表中按名称匹配
 * 4. 某平台某分类无明确 ID 且无法运行时匹配时，该平台该分类返回空
 */

export interface PlatformRankMapping {
  /** 榜单唯一 ID（文档明确给出的硬编码 ID） */
  chartId?: string;
  /** 运行时名称匹配关键词（文档该分类的「匹配关键词」） */
  matchKeywords?: string[];
  /** 额外请求参数（如分页大小、特殊 header 等） */
  extraParams?: Record<string, unknown>;
}

export interface RankCategory {
  /** 分类唯一标识（英文，代码内使用） */
  id: string;
  /** 分类显示名称（中文） */
  name: string;
  /** 该分类覆盖的平台数（文档统计） */
  platformCount: number;
  /** 该分类包含的榜单数量（文档统计） */
  chartCount: number;
  /** 各平台映射：key 为平台缩写 */
  platforms: Partial<Record<PlatformId, PlatformRankMapping>>;
}

/** 支持的 6 个平台缩写 */
export type PlatformId = 'qi' | 'kw' | 'mg' | 'wy' | 'qq' | 'kg';

/** 平台展示顺序（UI 列表排序用，与父任务要求的展示优先级一致） */
export const PLATFORM_DISPLAY_ORDER: PlatformId[] = ['qi', 'kw', 'mg', 'wy', 'qq', 'kg'];

/** 平台元信息 */
export const PLATFORM_META: Record<PlatformId, { name: string; maxQualityLabel: string }> = {
  qi: { name: '汽水', maxQualityLabel: '标准' },
  kw: { name: '酷我', maxQualityLabel: '无损' },
  mg: { name: '咪咕', maxQualityLabel: '无损' },
  wy: { name: '网易云', maxQualityLabel: 'Hi-Res' },
  qq: { name: 'QQ', maxQualityLabel: 'Hi-Res' },
  kg: { name: '酷狗', maxQualityLabel: 'Hi-Res' },
};

// =============================================================================
// 20 个固定榜单分类（与文档第四章完全一致）
// =============================================================================

export const RANK_CATEGORIES: RankCategory[] = [
  {
    id: 'hot',
    name: '热歌榜',
    platformCount: 6,
    chartCount: 8,
    platforms: {
      wy: { chartId: '3778678', matchKeywords: ['热歌', '热度'] },
      kg: { chartId: '8888', matchKeywords: ['TOP500', '热歌'] },
      qq: { chartId: '26', matchKeywords: ['热歌'] },
      kw: { chartId: '16', matchKeywords: ['热歌'] },
      mg: { chartId: '27186466', matchKeywords: ['热歌'] },
      qi: { chartId: '7036274230471712007', matchKeywords: ['热歌'] },
    },
  },
  {
    id: 'new',
    name: '新歌榜',
    platformCount: 6,
    chartCount: 7,
    platforms: {
      wy: { chartId: '3779629', matchKeywords: ['新歌'] },
      kg: { matchKeywords: ['新歌'] },
      qq: { chartId: '27', matchKeywords: ['新歌'] },
      kw: { chartId: '17', matchKeywords: ['新歌'] },
      mg: { chartId: '27553319', matchKeywords: ['新歌'] },
      qi: { chartId: '7060812597884869927', matchKeywords: ['新歌'] },
    },
  },
  {
    id: 'rising',
    name: '飙升榜',
    platformCount: 4,
    chartCount: 5,
    platforms: {
      wy: { chartId: '1978921795', matchKeywords: ['飙升', '潜力爆款'] },
      kg: { matchKeywords: ['飙升', '上升'] },
      qq: { matchKeywords: ['飙升', '流行指数'] },
      kw: { chartId: '93', matchKeywords: ['飙升'] },
    },
  },
  {
    id: 'original',
    name: '原创榜',
    platformCount: 4,
    chartCount: 5,
    platforms: {
      wy: { chartId: '2884035', matchKeywords: ['原创'] },
      kg: { matchKeywords: ['原创', '音乐人原创'] },
      qq: { chartId: '62', matchKeywords: ['由你'] },
      mg: { matchKeywords: ['原创'] },
      qi: { chartId: '7415959718721494311', matchKeywords: ['音乐人歌曲'] },
    },
  },
  {
    id: 'viral',
    name: '网络热歌榜',
    platformCount: 5,
    chartCount: 9,
    platforms: {
      wy: { matchKeywords: ['网络热歌'] },
      kg: { matchKeywords: ['网络', '短视频', '视频号'] },
      qq: { matchKeywords: ['抖音', '网络歌曲'] },
      kw: { chartId: '158', matchKeywords: ['短视频', '网红'] },
      mg: { chartId: '83049014', matchKeywords: ['抖音'] },
    },
  },
  {
    id: 'western',
    name: '欧美榜',
    platformCount: 5,
    chartCount: 7,
    platforms: {
      wy: { matchKeywords: ['欧美'] },
      kg: { matchKeywords: ['欧美'] },
      qq: { chartId: '61', matchKeywords: ['欧美'] },
      kw: { matchKeywords: ['欧美'] },
      qi: { chartId: '7061475546400005410', matchKeywords: ['欧美', '外文'] },
    },
  },
  {
    id: 'jpkorean',
    name: '日韩榜',
    platformCount: 5,
    chartCount: 9,
    platforms: {
      wy: { matchKeywords: ['韩语', '日语'] },
      kg: { matchKeywords: ['韩国', '日本'] },
      qq: { chartId: '73', matchKeywords: ['韩国', '日本'] },
      kw: { matchKeywords: ['韩语', '日语', '日韩'] },
    },
  },
  {
    id: 'chinese',
    name: '华语榜',
    platformCount: 4,
    chartCount: 9,
    platforms: {
      kg: { matchKeywords: ['内地', '港台', '香港', '台湾', '闽南语'] },
      qq: { chartId: '5', matchKeywords: ['内地'] },
      kw: { matchKeywords: ['华语', '粤语'] },
    },
  },
  {
    id: 'cantonese',
    name: '粤语榜',
    platformCount: 3,
    chartCount: 3,
    platforms: {
      kg: { matchKeywords: ['粤语'] },
      qq: { matchKeywords: ['粤语'] },
      kw: { matchKeywords: ['粤语'] },
    },
  },
  {
    id: 'chineseStyle',
    name: '国风榜',
    platformCount: 5,
    chartCount: 7,
    platforms: {
      wy: { matchKeywords: ['国风'] },
      kg: { matchKeywords: ['国潮', '国乐'] },
      qq: { matchKeywords: ['国风', '国乐'] },
      kw: { matchKeywords: ['古风'] },
      mg: { chartId: '83176390', matchKeywords: ['国风'] },
    },
  },
  {
    id: 'dj',
    name: 'DJ电音榜',
    platformCount: 5,
    chartCount: 10,
    platforms: {
      wy: { matchKeywords: ['电音', 'DJ', '慢摇', 'BEAT'] },
      kg: { matchKeywords: ['电音', 'DJ'] },
      qq: { matchKeywords: ['电音', 'DJ舞曲'] },
      kw: { chartId: '176', matchKeywords: ['DJ', '电音', '万物'] },
    },
  },
  {
    id: 'rap',
    name: '说唱榜',
    platformCount: 4,
    chartCount: 5,
    platforms: {
      wy: { matchKeywords: ['说唱', '嘻哈'] },
      kg: { matchKeywords: ['说唱'] },
      qq: { matchKeywords: ['说唱'] },
      kw: { matchKeywords: ['说唱'] },
    },
  },
  {
    id: 'rockFolk',
    name: '摇滚民谣榜',
    platformCount: 3,
    chartCount: 5,
    platforms: {
      wy: { matchKeywords: ['摇滚', '民谣'] },
      kg: { matchKeywords: ['摇滚', '民谣'] },
      kw: { matchKeywords: ['摇滚', '民谣'] },
    },
  },
  {
    id: 'ost',
    name: '影视综艺榜',
    platformCount: 4,
    chartCount: 7,
    platforms: {
      wy: { matchKeywords: ['乐夏', '影视'] },
      kg: { matchKeywords: ['影视', '综艺'] },
      qq: { chartId: '58', matchKeywords: ['影视'] },
      kw: { matchKeywords: ['影视'] },
    },
  },
  {
    id: 'acg',
    name: 'ACG游戏榜',
    platformCount: 4,
    chartCount: 8,
    platforms: {
      wy: { matchKeywords: ['ACG', '动漫', '游戏', 'VOCALOID', '蛋仔'] },
      kg: { matchKeywords: ['ACG'] },
      qq: { chartId: '57', matchKeywords: ['游戏', '动漫'] },
    },
  },
  {
    id: 'global',
    name: '全球榜',
    platformCount: 3,
    chartCount: 17,
    platforms: {
      wy: { chartId: '60198', matchKeywords: ['Billboard', 'UK', 'Beatport', 'Oricon'] },
      kg: { matchKeywords: ['Billboard', '英国', 'Beatport', 'Melon', '公信榜'] },
      qq: { matchKeywords: ['Billboard', 'UK', '公信榜'] },
      kw: { matchKeywords: ['Billboard', 'UK', '公信榜', '百大DJ', 'YouTube', 'Space Shower'] },
    },
  },
  {
    id: 'retro',
    name: '经典怀旧榜',
    platformCount: 3,
    chartCount: 5,
    platforms: {
      kg: { matchKeywords: ['经典', '怀旧', '老歌', '80后', '90后', '00后'] },
      kw: { matchKeywords: ['经典', '怀旧'] },
    },
  },
  {
    id: 'vip',
    name: '会员榜',
    platformCount: 4,
    chartCount: 10,
    platforms: {
      wy: { matchKeywords: ['黑胶VIP', 'VIP'] },
      kg: { matchKeywords: ['会员'] },
      kw: { chartId: '145', matchKeywords: ['会员', '畅听'] },
      mg: { chartId: '76557745', matchKeywords: ['臻爱', '会员'] },
    },
  },
  {
    id: 'scene',
    name: '场景榜',
    platformCount: 3,
    chartCount: 12,
    platforms: {
      wy: { matchKeywords: ['车友', '车载', '特斯拉', '理想', '比亚迪', '蔚来', '极氪'] },
      qq: { matchKeywords: ['K歌'] },
      kw: { matchKeywords: ['车载', '健身', 'KTV', '跑步'] },
    },
  },
  {
    id: 'other',
    name: '其他特色榜',
    platformCount: 6,
    chartCount: 48,
    platforms: {
      wy: { matchKeywords: ['古典', '纯音乐', '爵士', '乡村', '儿歌', '识曲', '直播', '星云', 'AI', '小语种', '越南语', '泰语', '俄语'] },
      kg: { matchKeywords: ['古典', '纯音乐', '爵士', '乡村', '儿歌', '粤剧', '京剧', '南音', '小语种', '伤感', 'R&B'] },
      qq: { matchKeywords: ['K歌', 'MV'] },
      kw: { matchKeywords: ['儿童', '相声', '故事', '热评', '流行趋势', '极品电音'] },
      mg: { matchKeywords: ['收藏'] },
      qi: { matchKeywords: ['音乐人'] },
    },
  },
];

/** 按 ID 快速查找分类的 Map */
export const RANK_CATEGORY_MAP: Map<string, RankCategory> = new Map(
  RANK_CATEGORIES.map((c) => [c.id, c])
);

/** 获取某分类在某平台的映射信息 */
export function getRankPlatformMapping(
  categoryId: string,
  platform: PlatformId
): PlatformRankMapping | undefined {
  return RANK_CATEGORY_MAP.get(categoryId)?.platforms[platform];
}

/** 判断某平台是否支持某分类 */
export function isRankCategorySupported(categoryId: string, platform: PlatformId): boolean {
  return !!RANK_CATEGORY_MAP.get(categoryId)?.platforms[platform];
}

/** 获取某分类支持的所有平台列表（按展示顺序排序） */
export function getRankSupportedPlatforms(categoryId: string): PlatformId[] {
  const cat = RANK_CATEGORY_MAP.get(categoryId);
  if (!cat) return [];
  return PLATFORM_DISPLAY_ORDER.filter((p) => cat.platforms[p]);
}
