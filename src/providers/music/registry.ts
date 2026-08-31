import type { MusicSource } from './types';
import { NeteaseSource } from './NeteaseSource';
import { KuwoSource } from './KuwoSource';
import { QqSource } from './QqSource';
import { KugouSource } from './KugouSource';
import { MiguSource } from './MiguSource';

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

  getSorted(): MusicSource[] {
    return this.getEnabled().sort((a, b) => {
      const priorityMap: Record<string, number> = {
        netease: 100,
        qq: 90,
        kuwo: 80,
        kugou: 70,
        migu: 60,
        qishui: 50,
        qianqian: 40,
      };
      return (priorityMap[b.id] ?? 0) - (priorityMap[a.id] ?? 0);
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

  // 未来扩展：
  // P1: 汽水音乐(QishuiSource)、千千音乐(QianqianSource)
  // P0 DJ源：DJ串烧集、火龙DJ、Y2002、55音乐、82DJ等
}
