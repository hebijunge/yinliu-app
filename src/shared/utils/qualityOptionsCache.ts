/**
 * 下载弹窗音质选项缓存 + 探测并发池
 *
 * 背景（用户反馈「下载弹窗卡的要死」）：
 * - 打开弹窗时会对全部音源并行调 getQualityOptions，一次最多并发 15~25 个请求；
 *   Android 端这些请求都走 CapacitorHttp 原生桥（每个响应整包 JSON/base64 过桥），
 *   瞬时并发洪峰会把 WebView JS 线程挤卡，表现为弹窗打开/滚动明显掉帧。
 * - 且此前每次打开都重新全量探测（fileSizeCache 从未接入），反复开弹窗反复洪峰。
 *
 * 方案：
 * - qualityOptionsCache：按「源:歌曲」缓存实时探测结果，TTL 内二次打开零请求直接命中；
 * - probeQualityOptions：跨源探测走固定并发池（默认 3），把瞬时洪峰削成平缓小队列。
 */

import type { OptionBlock } from '../../components/song/QualitySizeSheetTypes';

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 分钟，与 fileSizeCache 口径一致
const MAX_ENTRIES = 300; // 超出时淘汰最旧，防内存无限增长

interface CacheEntry {
  blocks: OptionBlock[];
  cachedAt: number;
}

class QualityOptionsCache {
  private map = new Map<string, CacheEntry>();

  get(sourceId: string, songId: string): OptionBlock[] | null {
    const key = `${sourceId}:${songId}`;
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > DEFAULT_TTL_MS) {
      this.map.delete(key);
      return null;
    }
    // 命中后重插到 Map 尾部（Map 迭代按插入序），实现 LRU 淘汰语义
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.blocks;
  }

  set(sourceId: string, songId: string, blocks: OptionBlock[]): void {
    const key = `${sourceId}:${songId}`;
    // 仅缓存探测到非空结果的源；空结果不缓存，避免源临时故障被钉死 10 分钟
    if (blocks.length === 0) return;
    this.map.set(key, { blocks, cachedAt: Date.now() });
    if (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

export const qualityOptionsCache = new QualityOptionsCache();

/**
 * 固定并发池：并发上限内依次执行任务，任何单个任务失败不影响其他任务。
 * 用于把「打开弹窗瞬时 15~25 个桥接请求」压平成 ≤N 路并发。
 */
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}
