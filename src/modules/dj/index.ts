import { Quality } from '@core/types';
import type { SearchParams, SearchResult } from '@core/types';

/**
 * DJ源接口
 */
export interface DjSource {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  enabled: boolean;

  search(params: DjSearchParams): Promise<DjSearchResult[]>;
  getCategories(): Promise<DjCategory[]>;
  getSongsByCategory(categoryId: string): Promise<DjSearchResult[]>;
  getPlayUrl(songId: string): Promise<string | null>;
  healthCheck(): Promise<{ healthy: boolean; message: string }>;
}

export interface DjSearchParams {
  keyword: string;
  style?: string;
  bpmMin?: number;
  bpmMax?: number;
  durationMin?: number;
  durationMax?: number;
  page?: number;
  pageSize?: number;
}

export interface DjSearchResult {
  id: string;
  title: string;
  artist?: string;
  bpm?: number;
  style?: string;
  duration?: number;
  coverUrl?: string;
  bitrate?: number;
  sourceId: string;
}

export interface DjCategory {
  id: string;
  name: string;
  type: 'style' | 'bpm' | 'duration';
  description?: string;
}

/**
 * DJ板块管理器
 * 功能：DJ分类浏览、DJ搜索、DJ歌单管理
 */
export class DjModule {
  private sources = new Map<string, DjSource>();

  registerSource(source: DjSource): void {
    this.sources.set(source.id, source);
  }

  getSource(id: string): DjSource | undefined {
    return this.sources.get(id);
  }

  getAllSources(): DjSource[] {
    return Array.from(this.sources.values());
  }

  getEnabledSources(): DjSource[] {
    return this.getAllSources().filter((s) => s.enabled);
  }

  /**
   * DJ聚合搜索
   */
  async search(params: DjSearchParams): Promise<{
    results: DjSearchResult[];
    sourceStats: Record<string, { total: number; latency: number; error?: string }>;
  }> {
    const sources = this.getEnabledSources();
    const startTime = Date.now();

    const promises = sources.map(async (source) => {
      const sStart = Date.now();
      try {
        const results = await Promise.race([
          source.search(params),
          new Promise<DjSearchResult[]>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), 10000)
          ),
        ]);
        return { source, results, latency: Date.now() - sStart, error: null };
      } catch (err) {
        return {
          source,
          results: [] as DjSearchResult[],
          latency: Date.now() - sStart,
          error: err instanceof Error ? err.message : '未知错误',
        };
      }
    });

    interface SourceResult {
      source: DjSource;
      results: DjSearchResult[];
      latency: number;
      error: string | null;
    }

    const sourceResults = await Promise.allSettled(promises);
    const fulfilled = sourceResults
      .filter((r): r is PromiseFulfilledResult<SourceResult> => r.status === 'fulfilled')
      .map((r) => r.value);

    // 合并去重
    const resultMap = new Map<string, DjSearchResult>();
    for (const sr of fulfilled) {
      for (const r of sr.results) {
        const key = `${r.title}|${r.artist || ''}`;
        if (!resultMap.has(key)) {
          resultMap.set(key, r);
        }
      }
    }

    const results = Array.from(resultMap.values());

    const sourceStats: Record<string, { total: number; latency: number; error?: string }> = {};
    for (const sr of fulfilled) {
      sourceStats[sr.source.id] = {
        total: sr.results.length,
        latency: sr.latency,
        error: sr.error || undefined,
      };
    }

    return { results, sourceStats };
  }

  /**
   * 获取所有DJ分类
   */
  async getAllCategories(): Promise<DjCategory[]> {
    const categories: DjCategory[] = [
      // 风格分类
      { id: 'house', name: 'House', type: 'style', description: '浩室舞曲' },
      { id: 'trance', name: 'Trance', type: 'style', description: '迷幻舞曲' },
      { id: 'techno', name: 'Techno', type: 'style', description: '工业舞曲' },
      { id: 'edm', name: 'EDM', type: 'style', description: '电子舞曲' },
      { id: 'dubstep', name: 'Dubstep', type: 'style', description: '回响贝斯' },
      { id: 'hardstyle', name: 'Hardstyle', type: 'style', description: '硬派舞曲' },
      { id: 'bounce', name: 'Bounce', type: 'style', description: '弹跳舞曲' },
      { id: 'remix', name: 'Remix', type: 'style', description: '混音串烧' },
      // BPM分类
      { id: 'bpm_slow', name: '慢节奏 (60-100 BPM)', type: 'bpm', description: '慢节奏DJ' },
      { id: 'bpm_mid', name: '中节奏 (100-130 BPM)', type: 'bpm', description: '中节奏DJ' },
      { id: 'bpm_fast', name: '快节奏 (130-150 BPM)', type: 'bpm', description: '快节奏DJ' },
      { id: 'bpm_hard', name: '超快 (150+ BPM)', type: 'bpm', description: '超快节奏DJ' },
      // 时长分类
      { id: 'dur_short', name: '单曲 (< 5分钟)', type: 'duration', description: '单曲DJ' },
      { id: 'dur_mid', name: '中串烧 (5-15分钟)', type: 'duration', description: '中串烧DJ' },
      { id: 'dur_long', name: '长串烧 (15-30分钟)', type: 'duration', description: '长串烧DJ' },
      { id: 'dur_xlong', name: '超长串烧 (30+ 分钟)', type: 'duration', description: '超长串烧DJ' },
    ];

    return categories;
  }

  /**
   * 获取分类参数映射
   */
  getCategoryParams(categoryId: string): Partial<DjSearchParams> {
    const bpmMap: Record<string, { bpmMin: number; bpmMax: number }> = {
      bpm_slow: { bpmMin: 60, bpmMax: 100 },
      bpm_mid: { bpmMin: 100, bpmMax: 130 },
      bpm_fast: { bpmMin: 130, bpmMax: 150 },
      bpm_hard: { bpmMin: 150, bpmMax: 999 },
    };

    const durationMap: Record<string, { durationMin: number; durationMax: number }> = {
      dur_short: { durationMin: 0, durationMax: 300 },
      dur_mid: { durationMin: 300, durationMax: 900 },
      dur_long: { durationMin: 900, durationMax: 1800 },
      dur_xlong: { durationMin: 1800, durationMax: 99999 },
    };

    if (bpmMap[categoryId]) {
      return bpmMap[categoryId];
    }

    if (durationMap[categoryId]) {
      return durationMap[categoryId];
    }

    // 风格分类
    return { style: categoryId };
  }
}

export const djModule = new DjModule();
