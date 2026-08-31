import { BaseHttpSource } from './BaseHttpSource';
import type { SearchParams, SearchResult, SongDetail, HealthStatus, Quality, PlayUrlResult } from '@core/types';
import type { EndpointCandidate } from './types';
import { platformFetch } from '@shared/utils/platformFetch';

const NETEASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Referer': 'https://music.163.com/',
  'Cookie': 'os=pc; appver=2.9.7',
};

export class NeteaseSource extends BaseHttpSource {
  readonly id = 'netease';
  readonly name = '网易云音乐';
  readonly maxQuality = Quality.HIRES;
  private readonly baseUrl = 'https://music.163.com';

  async search(params: SearchParams): Promise<SearchResult[]> {
    const limit = params.pageSize || 30;
    const offset = (params.page || 0) * limit;
    const url = `${this.baseUrl}/api/search/get/web?s=${encodeURIComponent(params.keyword)}&type=1&limit=${limit}&offset=${offset}`;

    const response = await platformFetch(url, {
      method: 'GET',
      headers: NETEASE_HEADERS,
    });

    if (!response.ok) {
      throw new Error(`Netease search failed: ${response.status}`);
    }

    const data = await response.json();
    const songs = data?.result?.songs || [];

    return songs.map((song: Record<string, unknown>) => this.mapSearchResult(song));
  }

  private mapSearchResult(song: Record<string, unknown>): SearchResult {
    const artists = Array.isArray(song.artists)
      ? (song.artists as Array<{ name?: string }>).map((a) => a.name).filter(Boolean).join(' / ')
      : '';

    const album = song.album as Record<string, unknown> | undefined;
    const fee = typeof song.fee === 'number' ? song.fee : 0;

    // fee: 0=免费, 1=VIP, 4=付费专辑, 8=试听
    const availableQualities: Quality[] = [Quality.STANDARD];
    if (fee === 0) {
      availableQualities.push(Quality.HIGHER, Quality.HIGH);
    }

    return {
      id: `netease_${song.id}`,
      type: 'song',
      title: String(song.name || ''),
      artist: artists,
      album: String(album?.name || ''),
      duration: typeof song.duration === 'number' ? Math.round(song.duration / 1000) : undefined,
      coverUrl: String(album?.picUrl || ''),
      sourceId: this.id,
      sourceSongId: String(song.id || ''),
      quality: Quality.STANDARD,
      bitrate: 128,
      availableQualities,
    };
  }

  async getSongDetail(songId: string): Promise<SongDetail> {
    const url = `${this.baseUrl}/api/song/detail/?ids=[${songId}]`;
    const response = await platformFetch(url, {
      method: 'GET',
      headers: NETEASE_HEADERS,
    });

    if (!response.ok) {
      return { id: songId, title: '未知歌曲' };
    }

    const data = await response.json();
    const song = data?.songs?.[0] as Record<string, unknown> | undefined;
    if (!song) {
      return { id: songId, title: '未知歌曲' };
    }

    const artists = Array.isArray(song.ar)
      ? (song.ar as Array<{ name?: string }>).map((a) => a.name).filter(Boolean).join(' / ')
      : '';
    const album = song.al as Record<string, unknown> | undefined;

    return {
      id: songId,
      title: String(song.name || ''),
      artist: artists,
      album: String(album?.name || ''),
      duration: typeof song.dt === 'number' ? Math.round(song.dt / 1000) : undefined,
      coverUrl: String(album?.picUrl || ''),
    };
  }

  protected buildEndpointCandidates(songId: string, quality: Quality) {
    const brMap: Record<Quality, number> = {
      [Quality.LOW]: 96000,
      [Quality.STANDARD]: 128000,
      [Quality.HIGHER]: 192000,
      [Quality.HIGH]: 320000,
      [Quality.LOSSLESS]: 999000,
      [Quality.HIRES]: 1900000,
      [Quality.SKY]: 3000000,
      [Quality.JYEFFECT]: 3000000,
      [Quality.HIFI]: 999000,
    };
    const br = brMap[quality] ?? 128000;

    return [
      {
        url: `${this.baseUrl}/api/song/enhance/player/url?ids=[${songId}]&br=${br}`,
        method: 'GET' as const,
        headers: NETEASE_HEADERS,
        timeout: 15000,
        priority: 1,
      },
    ];
  }

  protected async linkRace(candidates: EndpointCandidate[], targetQuality: Quality): Promise<PlayUrlResult> {
    // Override to parse Netease-specific response
    const c = candidates[0];
    const response = await platformFetch(c.url, {
      method: c.method,
      headers: c.headers,
    });

    if (!response.ok) {
      throw new Error(`Netease play URL failed: ${response.status}`);
    }

    const data = await response.json();
    const item = data?.data?.[0] as Record<string, unknown> | undefined;
    if (!item || !item.url) {
      throw new Error('Netease: no play URL returned');
    }

    // Check if it's a preview (freeTrialInfo non-null means preview)
    const freeTrialInfo = item.freeTrialInfo;
    if (freeTrialInfo !== null && freeTrialInfo !== undefined) {
      // Still return the URL but mark as preview
      console.warn('[Netease] Returning preview URL (trial)');
    }

    const actualBr = typeof item.br === 'number' ? item.br : 128000;
    const format = String(item.type || 'mp3');

    return {
      url: String(item.url),
      quality: targetQuality,
      bitrate: Math.round(actualBr / 1000),
      format,
      headers: c.headers,
      expiresAt: Date.now() + 20 * 60 * 1000, // 20 min expiry
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const start = Date.now();
      const response = await platformFetch(`${this.baseUrl}/api/search/get/web?s=test&type=1&limit=1`, {
        method: 'GET',
        headers: NETEASE_HEADERS,
        signal: AbortSignal.timeout(10000),
      });
      return {
        healthy: response.ok,
        message: response.ok ? '网易云音乐服务正常' : '网易云音乐服务异常',
        latency: Date.now() - start,
      };
    } catch {
      return { healthy: false, message: '网易云音乐服务不可用' };
    }
  }
}
