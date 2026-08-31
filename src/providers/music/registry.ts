import type { MusicSource } from './types';
import { NeteaseSource } from './NeteaseSource';
import { KuwoSource } from './KuwoSource';
import { KugouSource } from './KugouSource';

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
      // Priority order: netease > kuwo > kugou > qq > migu
      const priorityMap: Record<string, number> = {
        netease: 100, kuwo: 90, kugou: 80, qq: 70, migu: 60,
        qishui: 50, qianqian: 40,
      };
      return (priorityMap[b.id] ?? 0) - (priorityMap[a.id] ?? 0);
    });
  }
}

export const sourceRegistry = new SourceRegistry();

export function initializeProviders(): void {
  sourceRegistry.register(new NeteaseSource());
  sourceRegistry.register(new KuwoSource());
  sourceRegistry.register(new KugouSource());
  // Additional sources: QQ, Migu, Qishui, Qianqian
}
