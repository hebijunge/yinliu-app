import type { MusicSource, EndpointCandidate } from './types';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult, PlayUrlResult, SongDetail, HealthStatus } from '@core/types';
import { YinliuError, ErrorCode, qualityRank } from '@core/types';

export abstract class BaseHttpSource implements MusicSource {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly maxQuality: Quality;
  enabled = true;

  protected abstract buildEndpointCandidates(songId: string, quality: Quality): EndpointCandidate[];
  abstract search(params: SearchParams): Promise<SearchResult[]>;
  abstract getSongDetail(songId: string): Promise<SongDetail>;
  abstract healthCheck(): Promise<HealthStatus>;

  async getPlayUrl(songId: string, quality: Quality): Promise<PlayUrlResult> {
    const candidates = this.buildEndpointCandidates(songId, quality);
    if (candidates.length === 0) {
      throw new YinliuError(ErrorCode.LINK_RACE_FAILED, `No endpoints for ${this.id}`, 503);
    }
    return await this.linkRace(candidates, quality);
  }

  protected async linkRace(candidates: EndpointCandidate[], targetQuality: Quality): Promise<PlayUrlResult> {
    const controller = new AbortController();
    
    const promises = candidates.map(async (c) => {
      try {
        const response = await fetch(c.url, {
          method: c.method,
          headers: c.headers,
          signal: controller.signal,
          redirect: 'follow',
        });
        
        if (!response.ok) return null;
        
        // Check content length for quality validation
        const contentLength = response.headers.get('content-length');
        const contentType = response.headers.get('content-type') || '';
        
        const result: PlayUrlResult = {
          url: c.url,
          quality: targetQuality,
          bitrate: this.estimateBitrate(contentLength, targetQuality),
          format: this.detectFormat(contentType, c.url),
          headers: c.headers,
        };
        
        if (this.validateQuality(result, targetQuality)) {
          controller.abort(); // Cancel other requests
          return result;
        }
        return null;
      } catch {
        return null;
      }
    });

    const results = await Promise.allSettled(promises);
    const matched = results
      .filter((r): r is PromiseFulfilledResult<PlayUrlResult | null> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((r): r is PlayUrlResult => r !== null);

    if (matched.length > 0) {
      return matched[0];
    }

    throw new YinliuError(ErrorCode.LINK_RACE_FAILED, `Link race failed for ${this.id}`, 503);
  }

  protected validateQuality(result: PlayUrlResult, target: Quality): boolean {
    if (!result.url) return false;
    return qualityRank(result.quality) >= qualityRank(target);
  }

  protected estimateBitrate(contentLength: string | null, quality: Quality): number {
    const size = parseInt(contentLength || '0', 10);
    if (size === 0) return 128;
    // Rough estimate: assume 3 min song
    const kbps = Math.round((size * 8) / (3 * 60 * 1000));
    return kbps;
  }

  protected detectFormat(contentType: string, url: string): string {
    if (contentType.includes('flac')) return 'flac';
    if (contentType.includes('mpeg')) return 'mp3';
    if (contentType.includes('aac')) return 'aac';
    if (contentType.includes('ogg')) return 'ogg';
    if (contentType.includes('m4a')) return 'm4a';
    if (url.endsWith('.flac')) return 'flac';
    if (url.endsWith('.mp3')) return 'mp3';
    if (url.endsWith('.aac')) return 'aac';
    if (url.endsWith('.m4a')) return 'm4a';
    return 'mp3';
  }
}
