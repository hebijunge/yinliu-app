import { sourceRegistry } from '@providers/music/registry';
import type { MvQuality, MvUrlResult } from '@core/types';

/**
 * MV 取链引擎
 * 负责按 sourceId 路由到对应 Provider，获取 MV 可用画质与实际播放地址
 */
export class MvEngine {
  /**
   * 获取某源某 MV 的可用画质列表
   */
  async getMvQualities(sourceId: string, mvId: string): Promise<MvQuality[]> {
    const source = sourceRegistry.get(sourceId);
    if (!source) return [];
    // Provider 可选实现 getMvQualities；未实现则返回空数组（由播放器兜底）
    if (typeof (source as any).getMvQualities === 'function') {
      try {
        return await (source as any).getMvQualities(mvId);
      } catch {
        return [];
      }
    }
    return [];
  }

  /**
   * 获取某源某 MV 在指定画质下的播放地址
   */
  async getMvUrl(sourceId: string, mvId: string, quality: MvQuality): Promise<MvUrlResult | null> {
    const source = sourceRegistry.get(sourceId);
    if (!source) return null;
    if (typeof (source as any).getMvUrl === 'function') {
      try {
        const result = await (source as any).getMvUrl(mvId, quality);
        if (result && result.url) return result;
      } catch {
        // 取链失败返回 null，由调用方处理切源
      }
    }
    return null;
  }

  /**
   * 并发获取多源画质信息
   */
  async fetchQualitiesBatch(
    entries: Array<{ sourceId: string; mvId: string }>
  ): Promise<Record<string, MvQuality[]>> {
    const results: Record<string, MvQuality[]> = {};
    await Promise.all(
      entries.map(async ({ sourceId, mvId }) => {
        const qualities = await this.getMvQualities(sourceId, mvId);
        results[sourceId] = qualities;
      })
    );
    return results;
  }
}

export const mvEngine = new MvEngine();
