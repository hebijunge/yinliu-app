import type { MusicSource } from './types';
import { NeteaseSource } from './NeteaseSource';
import { KuwoSource } from './KuwoSource';
import { QqSource } from './QqSource';
import { KugouSource } from './KugouSource';
import { MiguSource } from './MiguSource';
import { QishuiSource } from './QishuiSource';
import { PLATFORM_PRIORITY, getPriorityRank } from '@core/platformPriority';

class SourceRegistry {
  private sources = new Map<string, MusicSource>();

  register(source: MusicSource): void {
    this.sources.set(source.id, source);
  }

  get(id: string): MusicSource | undefined {
    return this.sources.get(id);
  }

  getAll(): MusicSource[] {
    return Array.from(this.sources.values());
  }

  getEnabled(): MusicSource[] {
    return this.getAll().filter((s) => s.enabled);
  }

  /**
   * 按 v13 取链优先级排序的 source 列表。
   * 优先级表内的源按 kuwo > migu > netease > kugou > qq 升序；
   * 优先级表外的源（P1 扩展等）排在末尾，按注册顺序稳定。
   */
  getSorted(): MusicSource[] {
    return this.getEnabled().sort((a, b) => {
      const aIn = PLATFORM_PRIORITY.indexOf(a.id as typeof PLATFORM_PRIORITY[number]);
      const bIn = PLATFORM_PRIORITY.indexOf(b.id as typeof PLATFORM_PRIORITY[number]);
      if (aIn === -1 && bIn === -1) return 0;
      if (aIn === -1) return 1;
      if (bIn === -1) return -1;
      return getPriorityRank(a.id) - getPriorityRank(b.id);
    });
  }
}

export const sourceRegistry = new SourceRegistry();

export function initializeProviders(): void {
  // P0 商业平台音源
  sourceRegistry.register(new NeteaseSource());
  sourceRegistry.register(new QqSource());
  sourceRegistry.register(new KuwoSource());
  sourceRegistry.register(new KugouSource());
  sourceRegistry.register(new MiguSource());
  sourceRegistry.register(new QishuiSource());

  // 未来扩展：
  // P1: 千千音乐(QianqianSource)
  // P0 DJ源：DJ串烧集、火龙DJ、Y2002、55音乐、82DJ等
}
