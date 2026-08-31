import type { MusicSource } from '@providers/music/types';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult } from '@core/types';
import { sourceRegistry } from '@providers/music/registry';

export interface AggregatedSearchResult extends SearchResult {
  sources: Array<{ sourceId: string; sourceName: string; maxQuality: Quality; available: boolean }>;
}

export interface SearchEngineOptions {
  sources?: string[];
  timeout?: number;
}

export class SearchEngine {
  async search(
    params: SearchParams,
    options: SearchEngineOptions = {}
  ): Promise<{
    results: AggregatedSearchResult[];
    sourceStats: Record<string, { total: number; latency: number; error?: string }>;
  }> {
    const sources = options.sources
      ? options.sources.map((id) => sourceRegistry.get(id)).filter(Boolean) as MusicSource[]
      : sourceRegistry.getEnabled();

    const startTime = Date.now();
    const sourcePromises = sources.map(async (source) => {
      const sStart = Date.now();
      try {
        const results = await Promise.race([
          source.search(params),
          new Promise<SearchResult[]>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), options.timeout || 10000)
          ),
        ]);
        return {
          source,
          results,
          latency: Date.now() - sStart,
          error: null as string | null,
        };
      } catch (err) {
        return {
          source,
          results: [] as SearchResult[],
          latency: Date.now() - sStart,
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      }
    });

    interface SourceResult {
      source: MusicSource;
      results: SearchResult[];
      latency: number;
      error: string | null;
    }

    const sourceResults = await Promise.allSettled(sourcePromises);
    const fulfilled = sourceResults
      .filter((r): r is PromiseFulfilledResult<SourceResult> => r.status === 'fulfilled')
      .map((r) => r.value);

    // Deduplicate and merge results by title + artist
    const resultMap = new Map<string, AggregatedSearchResult>();

    for (const sr of fulfilled) {
      for (const r of sr.results) {
        const key = `${r.title}|${r.artist || ''}`;
        const existing = resultMap.get(key);
        
        if (existing) {
          // Merge source availability
          const sourceInfo = {
            sourceId: sr.source.id,
            sourceName: sr.source.name,
            maxQuality: sr.source.maxQuality,
            available: true,
          };
          if (!existing.sources.find((s) => s.sourceId === sr.source.id)) {
            existing.sources.push(sourceInfo);
          }
        } else {
          resultMap.set(key, {
            ...r,
            sources: [{
              sourceId: sr.source.id,
              sourceName: sr.source.name,
              maxQuality: sr.source.maxQuality,
              available: true,
            }],
          });
        }
      }
    }

    const results = Array.from(resultMap.values()).sort((a, b) => {
      // Sort by: source count desc, then quality desc
      const aSources = a.sources.length;
      const bSources = b.sources.length;
      if (bSources !== aSources) return bSources - aSources;
      return (b.bitrate || 0) - (a.bitrate || 0);
    });

    const sourceStats: Record<string, { total: number; latency: number; error?: string; errorType?: string }> = {};
    for (const sr of fulfilled) {
      sourceStats[sr.source.id] = {
        total: sr.results.length,
        latency: sr.latency,
        error: sr.error || undefined,
        errorType: sr.error ? (sr.error.includes('HTTP') ? 'http' : sr.error.includes('网络') || sr.error.includes('CORS') || sr.error.includes('超时') ? 'network' : 'unknown') : undefined,
      };
    }

    return { results, sourceStats };
  }
}

export const searchEngine = new SearchEngine();
