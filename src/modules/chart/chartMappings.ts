/**
 * 榜单分类映射表
 * 数据来源：6平台音乐榜单名称与分类完整梳理.md (v2.0, 2026-09-02)
 * 规则：文档写明具体ID的以文档为准；文档未覆盖的如实留空，不得用全量再分类或搜索凑数
 *
 * 20个固定融合分类，每个分类下映射各源的固定榜单ID。
 * 榜单聚合 = 按固定分类取各源固定汇总榜单ID拉取，不再「取全量→按分类聚合」。
 */

export interface SourceChartMapping {
  /** 源ID */
  sourceId: string;
  /** 该源在此分类下的固定榜单ID；为空表示文档未覆盖 */
  chartId: string;
  /** 榜单名称（文档中的名称，用于展示） */
  chartName: string;
}

export interface ChartCategory {
  /** 融合分类标识 */
  id: string;
  /** 融合分类名称 */
  name: string;
  /** 该分类下各源的固定榜单映射 */
  mappings: SourceChartMapping[];
}

/** 20个固定融合分类，按文档 Section 4 "合并榜单分类方案" 定义 */
export const CHART_CATEGORIES: ChartCategory[] = [
  {
    id: 'hot',
    name: '热歌榜',
    mappings: [
      { sourceId: 'netease', chartId: '3778678', chartName: '热歌榜' },
      { sourceId: 'kugou', chartId: '8888', chartName: 'TOP500' },
      { sourceId: 'qq', chartId: '26', chartName: '热歌榜' },
      { sourceId: 'kuwo', chartId: '16', chartName: '酷我热歌榜' },
      { sourceId: 'migu', chartId: '27186466', chartName: '热歌榜' },
    ],
  },
  {
    id: 'new',
    name: '新歌榜',
    mappings: [
      { sourceId: 'netease', chartId: '3779629', chartName: '新歌榜' },
      { sourceId: 'qq', chartId: '27', chartName: '新歌榜' },
      { sourceId: 'kuwo', chartId: '17', chartName: '酷我新歌榜' },
      { sourceId: 'migu', chartId: '27553319', chartName: '新歌榜' },
    ],
  },
  {
    id: 'soaring',
    name: '飙升榜',
    mappings: [
      { sourceId: 'netease', chartId: '1978921795', chartName: '飙升榜' },
      { sourceId: 'kuwo', chartId: '93', chartName: '酷我飙升榜' },
    ],
  },
  {
    id: 'original',
    name: '原创榜',
    mappings: [
      { sourceId: 'netease', chartId: '2884035', chartName: '原创榜' },
      { sourceId: 'qq', chartId: '62', chartName: '由你榜' },
    ],
  },
  {
    id: 'network',
    name: '网络热歌榜',
    mappings: [
      { sourceId: 'migu', chartId: '83049014', chartName: '抖音热歌榜' },
    ],
  },
  {
    id: 'western',
    name: '欧美榜',
    mappings: [
      { sourceId: 'qq', chartId: '61', chartName: '欧美榜' },
    ],
  },
  {
    id: 'japan-korea',
    name: '日韩榜',
    mappings: [
      { sourceId: 'qq', chartId: '73', chartName: '韩国榜' },
    ],
  },
  {
    id: 'chinese',
    name: '华语榜',
    mappings: [
      { sourceId: 'qq', chartId: '5', chartName: '内地榜' },
    ],
  },
  {
    id: 'cantonese',
    name: '粤语榜',
    mappings: [
      // 文档未给出各源粤语榜的明确固定ID，如实留空
    ],
  },
  {
    id: 'guofeng',
    name: '国风榜',
    mappings: [
      { sourceId: 'migu', chartId: '83176390', chartName: '国风热歌榜' },
    ],
  },
  {
    id: 'dj',
    name: 'DJ电音榜',
    mappings: [
      { sourceId: 'kuwo', chartId: '176', chartName: '万物DJ榜' },
    ],
  },
  {
    id: 'rap',
    name: '说唱榜',
    mappings: [
      // 文档未给出各源说唱榜的明确固定ID，如实留空
    ],
  },
  {
    id: 'rock-folk',
    name: '摇滚民谣榜',
    mappings: [
      // 文档未给出各源摇滚民谣榜的明确固定ID，如实留空
    ],
  },
  {
    id: 'movie',
    name: '影视综艺榜',
    mappings: [
      { sourceId: 'qq', chartId: '58', chartName: '影视金曲榜' },
    ],
  },
  {
    id: 'acg',
    name: 'ACG游戏榜',
    mappings: [
      { sourceId: 'qq', chartId: '57', chartName: '游戏音乐榜' },
    ],
  },
  {
    id: 'global',
    name: '全球榜',
    mappings: [
      { sourceId: 'netease', chartId: '60198', chartName: '美国Billboard榜' },
    ],
  },
  {
    id: 'classic',
    name: '经典怀旧榜',
    mappings: [
      // 文档未给出各源经典怀旧榜的明确固定ID，如实留空
    ],
  },
  {
    id: 'vip',
    name: '会员榜',
    mappings: [
      { sourceId: 'kuwo', chartId: '145', chartName: '会员畅听榜' },
      { sourceId: 'migu', chartId: '76557745', chartName: '会员臻爱榜' },
    ],
  },
  {
    id: 'scene',
    name: '场景榜',
    mappings: [
      // 文档未给出各源场景榜的明确固定ID，如实留空
    ],
  },
  {
    id: 'other',
    name: '其他特色榜',
    mappings: [
      // 文档未覆盖其他特色榜的明确固定ID（该分类为兜底聚合），如实留空
    ],
  },
];

/** 按分类ID快速查找 */
export function getCategoryById(id: string): ChartCategory | undefined {
  return CHART_CATEGORIES.find((c) => c.id === id);
}

/** 获取某分类下所有有明确ID的源映射 */
export function getActiveMappings(categoryId: string): SourceChartMapping[] {
  const cat = getCategoryById(categoryId);
  if (!cat) return [];
  return cat.mappings.filter((m) => m.chartId && m.chartId.trim().length > 0);
}

/** 首页热歌榜ID快速对照表（文档 Section 5.2） */
export const HOME_HOT_CHART_IDS: Record<string, string> = {
  netease: '3778678',
  kugou: '8888',
  qq: '26',
  kuwo: '16',
  migu: '27186466',
};
