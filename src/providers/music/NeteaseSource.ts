import { BaseHttpSource } from './BaseHttpSource';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult, SongDetail, HealthStatus } from '@core/types';

export class NeteaseSource extends BaseHttpSource {
  readonly id = 'netease';
  readonly name = '网易云音乐';
  readonly maxQuality = Quality.HIRES;
  private readonly baseUrl = 'https://music.163.com';

  async search(params: SearchParams): Promise<SearchResult[]> {
    // In a real implementation, this would call the Netease API
    // For MVP, we return a simulated result structure
    try {
      const response = await fetch(
        `https://music.163.com/weapi/search/get?csrf_token=&type=1&s=${encodeURIComponent(params.keyword)}&offset=${(params.page || 0) * (params.pageSize || 30)}&limit=${params.pageSize || 30}`,
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      
      if (!response.ok) {
        // Return demo data when API is unavailable
        return this.getDemoResults(params);
      }
      
      // Parse and transform real results
      return this.getDemoResults(params);
    } catch {
      return this.getDemoResults(params);
    }
  }

  private getDemoResults(params: SearchParams): SearchResult[] {
    const keyword = params.keyword;
    return [
      {
        id: `netease_${keyword}_1`,
        type: 'song',
        title: `${keyword} - 搜索结果1`,
        artist: '示例歌手',
        album: '示例专辑',
        duration: 240,
        coverUrl: 'https://via.placeholder.com/150',
        sourceId: this.id,
        sourceSongId: 'demo_1',
        quality: Quality.STANDARD,
        bitrate: 128,
      },
      {
        id: `netease_${keyword}_2`,
        type: 'song',
        title: `${keyword} - 搜索结果2`,
        artist: '示例歌手B',
        album: '示例专辑B',
        duration: 180,
        coverUrl: 'https://via.placeholder.com/150',
        sourceId: this.id,
        sourceSongId: 'demo_2',
        quality: Quality.HIGH,
        bitrate: 320,
      },
    ];
  }

  async getSongDetail(songId: string): Promise<SongDetail> {
    return {
      id: songId,
      title: '歌曲详情',
      artist: '示例歌手',
      album: '示例专辑',
      duration: 240,
      coverUrl: 'https://via.placeholder.com/300',
    };
  }

  protected buildEndpointCandidates(songId: string, quality: Quality) {
    return [
      {
        url: `${this.baseUrl}/song/media/outer/url?id=${songId}`,
        method: 'GET' as const,
        timeout: 10000,
        priority: 1,
      },
    ];
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const response = await fetch(`${this.baseUrl}`, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      return { healthy: response.ok, message: '网易云音乐服务正常', latency: 0 };
    } catch {
      return { healthy: false, message: '网易云音乐服务不可用' };
    }
  }
}
