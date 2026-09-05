/**
 * 榜单聚合中枢（v18）
 *
 * 1. getAllCharts：并发拉取 6 个源的榜单列表，按 chartCategories 的 20 个固定分类归类
 * 2. getAggregatedHotSongs：拉取 6 平台首页热歌榜详情并聚合（首页「多源聚合热歌榜」数据源）
 *    - 权重1：支持的源越多越靠前
 *    - 权重2：展示优先级 汽水 > 酷我 > 咪咕 > 网易云 > QQ > 酷狗
 *    - 播放取链仍按播放优先级 酷我 > 咪咕 > 网易云 > QQ > 酷狗 > 汽水（platformPriority）
 */

import { sourceRegistry } from '@providers/music/registry';
import { Quality } from '@core/types';
import {
  CHART_CATEGORIES,
  classifyChart,
  getChartCategoryName,
} from './chartCategories';
import {
  makeKey,
  isSameSong,
} from './search';
import type { AggregatedSearchResult, AggregatedSearchSource } from './search';
import { getDisplayRank, sortByPriority, sortByDisplayPriority } from './platformPriority';
import { PLATFORM_SHORT_NAMES } from './platformPriority';
import { debugLogger } from '@shared/utils/debugLogger';

/** 各平台首页热歌榜 ID（文档 5.2） */
export const HOT_CHART_IDS: Record<string, string> = {
  netease: '3778678',
  kugou: '8888',
  qq: '26',
  kuwo: '16',
  migu: '27186466',
  qishui: '7036274230471712007',
  bilibili: 'ranking_all',
};

/** 归类后的榜单条目（榜单广场展示用） */
export interface ClassifiedChart {
  sourceId: string;
  sourceName: string;
  chartId: string;
  chartName: string;
  description?: string;
}

/** 单个分类下的榜单集合 */
export interface ChartCategoryGroup {
  categoryId: string;
  categoryName: string;
  charts: ClassifiedChart[];
}

/**
 * 拉取全部源的榜单并按 20 个固定分类归类。
 * 单个源失败不影响整体（best-effort）。
 */
export async function getAllChartGroups(): Promise<ChartCategoryGroup[]> {
  const sources = sourceRegistry.getEnabled().filter((s) => typeof s.getCharts === 'function');

  const settled = await Promise.allSettled(
    sources.map(async (s) => {
      const charts = await s.getCharts!();
      return { source: s, charts };
    })
  );

  // 分类桶（保持 CHART_CATEGORIES 顺序）
  const buckets = new Map<string, ClassifiedChart[]>();
  for (const cat of CHART_CATEGORIES) buckets.set(cat.id, []);

  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    const { source, charts } = r.value;
    for (const chart of charts) {
      if (!chart?.name) continue;
      const categoryId = classifyChart(chart.name, chart.description);
      buckets.get(categoryId)!.push({
        sourceId: source.id,
        sourceName: PLATFORM_SHORT_NAMES[source.id] || source.name,
        chartId: chart.id,
        chartName: chart.name,
        description: chart.description,
      });
    }
  }

  return CHART_CATEGORIES.map((cat) => ({
    categoryId: cat.id,
    categoryName: getChartCategoryName(cat.id),
    charts: buckets.get(cat.id) || [],
  }));
}

/**
 * 六平台热歌榜聚合（首页热歌榜）。
 * 单个源失败/超时跳过；聚合逻辑与搜索一致（makeKey/isSameSong），双权重排序。
 */
export async function getAggregatedHotSongs(): Promise<AggregatedSearchResult[]> {
  const entries = Object.entries(HOT_CHART_IDS);

  const settled = await Promise.allSettled(
    entries.map(async ([sourceId, chartId]) => {
      const source = sourceRegistry.get(sourceId);
      if (!source || typeof source.getChartDetail !== 'function') return null;
      const detail = await source.getChartDetail!(chartId);
      return { sourceId, sourceName: source.name, songs: detail?.songs || [] };
    })
  );

  const resultMap = new Map<string, AggregatedSearchResult>();

  for (const r of settled) {
    if (r.status !== 'fulfilled' || !r.value) {
      if (r.status === 'rejected') {
        debugLogger.warn('network', '热歌榜拉取失败（跳过）', { err: String(r.reason) });
      }
      continue;
    }
    const { sourceId, sourceName, songs } = r.value;

    for (const song of songs) {
      // C5: makeKey 不再接收 duration，时长差异由 isSameSong ±10s 判定
      const key = makeKey(song.title, song.artist || '');
      let existing = resultMap.get(key);
      if (existing && !isSameSong(existing, song)) {
        // 主键冲突但严格判定不同版本 → 跳过（榜单场景宁可少并不误并）
        continue;
      }

      const sourceInfo: AggregatedSearchSource = {
        sourceId,
        sourceName,
        maxQuality: song.quality || Quality.STANDARD,
        available: true,
        sourceSongId: song.sourceSongId,
        sizes: song.sizes,
      };

      if (existing) {
        if (!existing.sources.find((s) => s.sourceId === sourceId)) {
          existing.sources.push(sourceInfo);
          // 保留信息更全的字段（封面/时长）
          if (!existing.coverUrl && song.coverUrl) existing.coverUrl = song.coverUrl;
          if (!existing.duration && song.duration) existing.duration = song.duration;
        }
      } else {
        const merged: AggregatedSearchResult = {
          ...song,
          sources: [sourceInfo],
        };
        resultMap.set(key, merged);
      }
    }
  }

  const results: AggregatedSearchResult[] = [];
  for (const r of resultMap.values()) {
    // sources 按展示序（汽水在前），取链目标按播放序（酷我在前）
    r.sources = sortByDisplayPriority(r.sources);
    const playBest = sortByPriority(r.sources)[0];
    if (playBest) {
      r.sourceId = playBest.sourceId;
      r.sourceSongId = playBest.sourceSongId;
    }
    results.push(r);
  }

  // 双权重排序：支持源数 desc → 展示优先级 asc
  results.sort((a, b) => {
    if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
    const aRank = a.sources[0] ? getDisplayRank(a.sources[0].sourceId) : Number.MAX_SAFE_INTEGER;
    const bRank = b.sources[0] ? getDisplayRank(b.sources[0].sourceId) : Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    return (b.bitrate || 0) - (a.bitrate || 0);
  });

  return results;
}
