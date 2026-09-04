/**
 * 榜单固定融合分类（v18）
 *
 * 依据《6平台音乐榜单名称与分类完整梳理》第四章「合并榜单分类方案（推荐20个固定分类）」，
 * 不自行发明分类。分类逻辑为两级匹配：
 * 1. 先查各分类的特异关键词（distinctive，避免「抖音热歌」被「热歌」抢先归入热歌榜）
 * 2. 再按表序匹配通用关键词；全部未命中归入「其他特色榜」
 */

export interface ChartCategory {
  id: string;
  name: string;
  /** 通用匹配关键词（按文档第四章表格） */
  keywords: string[];
  /** 特异关键词：优先于所有通用关键词匹配 */
  distinctive: string[];
}

export const CHART_CATEGORIES: ChartCategory[] = [
  { id: 'hot',       name: '热歌榜',     keywords: ['热歌', 'TOP500', '全网热歌', '免费热歌', '热度'], distinctive: [] },
  { id: 'new',       name: '新歌榜',     keywords: ['新歌'], distinctive: [] },
  { id: 'surge',     name: '飙升榜',     keywords: ['飙升', '上升', '潜力爆款'], distinctive: [] },
  { id: 'original',  name: '原创榜',     keywords: ['原创', '由你', '音乐人原创', '音乐人歌曲'], distinctive: [] },
  { id: 'viral',     name: '网络热歌榜', keywords: ['网络', '短视频', '抖音', '视频号', '网红'], distinctive: ['抖音', '短视频', '视频号', '网红'] },
  { id: 'western',   name: '欧美榜',     keywords: ['欧美'], distinctive: [] },
  { id: 'jkkpop',    name: '日韩榜',     keywords: ['韩语', '日语', '韩国', '日本'], distinctive: [] },
  { id: 'chinese',   name: '华语榜',     keywords: ['华语', '内地', '港台', '香港', '台湾', '闽南语'], distinctive: [] },
  { id: 'cantonese', name: '粤语榜',     keywords: ['粤语', '粤语金曲', 'Cantonese'], distinctive: ['Cantonese'] },
  { id: 'guofeng',   name: '国风榜',     keywords: ['国风', '古风', '国乐', '国潮'], distinctive: [] },
  { id: 'dj',        name: 'DJ电音榜',   keywords: ['DJ', '电音', '电子', '慢摇', '百大DJ', 'BEAT', '万物'], distinctive: [] },
  { id: 'rap',       name: '说唱榜',     keywords: ['说唱', '嘻哈'], distinctive: [] },
  { id: 'rockfolk',  name: '摇滚民谣榜', keywords: ['摇滚', '民谣'], distinctive: [] },
  { id: 'ost',       name: '影视综艺榜', keywords: ['影视', '综艺', '乐夏'], distinctive: [] },
  { id: 'acg',       name: 'ACG游戏榜',  keywords: ['ACG', '动漫', '游戏', 'VOCALOID', '蛋仔'], distinctive: [] },
  { id: 'global',    name: '全球榜',     keywords: ['Billboard', 'UK', 'Beatport', 'Oricon', 'Melon', '公信榜', '法国', '俄罗斯', 'YouTube', 'Space Shower', '英国单曲'], distinctive: ['Billboard', 'Beatport', 'Oricon', '公信榜', 'Space Shower', '英国单曲', 'YouTube'] },
  { id: 'nostalgia', name: '经典怀旧榜', keywords: ['经典', '怀旧', '老歌', '80后', '90后', '00后'], distinctive: [] },
  { id: 'vip',       name: '会员榜',     keywords: ['VIP', '会员', '黑胶', '臻爱', '畅听'], distinctive: [] },
  { id: 'scene',     name: '场景榜',     keywords: ['车载', '健身', 'KTV', 'K歌', '车友', '跑步'], distinctive: [] },
  {
    id: 'other',
    name: '其他特色榜',
    keywords: [
      // 纯音乐/古典簇
      '古典', '纯音乐', '爵士', '乡村', 'R&B', '轻音乐',
      // 儿歌/故事簇
      '儿歌', '儿童', '儿童故事', '爆笑相声', '相声',
      // 戏曲·国粹簇
      '粤剧', '京剧', '南音',
      // 小语种/方言簇
      '小语种', '越南语', '泰语', '俄语', 'JOOX', 'KKBOX',
      // 电台/识曲/直播/其它簇
      '识曲', '星云', '赏音', 'AI', 'LOOK直播', '直播', '有声', '名品堂', '百万收藏', '收藏', '热评', '分享', '潮流', 'MV', '流行趋势', '音乐合伙人', '听书',
    ],
    distinctive: [
      '识曲', '星云', '赏音', '蛋仔派对听歌', 'AI歌曲', '实时分享', '潮流风向', '名品堂', '百万收藏', '短视频收藏',
      'KKBOX', 'JOOX', '粤剧', '京剧', '南音', '儿歌', '儿童', '相声', '爆笑',
      '古典', '纯音乐', '爵士', '乡村', 'R&B', '轻音乐',
      '俄语', '越南语', '泰语', '小语种',
      '听书', '有声', 'MV', '直播', '热评', '流行趋势',
    ],
  },
];

/** 分类 id → 名称 的快捷映射 */
export const CHART_CATEGORY_NAME: Record<string, string> = Object.fromEntries(
  CHART_CATEGORIES.map((c) => [c.id, c.name])
);

/**
 * 把一个榜单（按名称+可选描述）归入 20 个固定分类之一。
 * 两级匹配：先全表特异关键词，再按表序通用关键词；未命中归「其他特色榜」。
 */
export function classifyChart(chartName: string, description?: string): string {
  const text = `${chartName || ''} ${description || ''}`;
  const lower = text.toLowerCase();

  // 第一遍：特异关键词（含大小写不敏感的英文词）
  for (const cat of CHART_CATEGORIES) {
    for (const kw of cat.distinctive) {
      if (lower.includes(kw.toLowerCase())) return cat.id;
    }
  }

  // 第二遍：通用关键词按表序（其他特色榜的通用关键词也参与，保证未命中特异词的特色榜仍能归类）
  for (const cat of CHART_CATEGORIES) {
    for (const kw of cat.keywords) {
      if (lower.includes(kw.toLowerCase())) return cat.id;
    }
  }

  return 'other';
}

/** 按 CHART_CATEGORIES 顺序取分类名 */
export function getChartCategoryName(id: string): string {
  return CHART_CATEGORY_NAME[id] || id;
}
