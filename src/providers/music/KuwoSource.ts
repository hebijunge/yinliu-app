import { BaseHttpSource } from './BaseHttpSource';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult, SongDetail, HealthStatus } from '@core/types';

export class KuwoSource extends BaseHttpSource {
  readonly id = 'kuwo';
  readonly name = '酷我音乐';
  readonly maxQuality = Quality.HIFI;
  private readonly baseUrl = 'https://kuwo.cn';

  async search(params: SearchParams): Promise<SearchResult[]> {
    return [
      {
        id: `kuwo_${params.keyword}_1`,
        type: 'song',
        title: `${params.keyword} - 酷我结果1`,
        artist: '酷我歌手',
        album: '酷我专辑',
        duration: 210,
        coverUrl: 'https://via.placeholder.com/150',
        sourceId: this.id,
        sourceSongId: 'kw_demo_1',
        quality: Quality.HIGH,
        bitrate: 320,
      },
    ];
  }

  async getSongDetail(songId: string): Promise<SongDetail> {
    return { id: songId, title: '酷我歌曲', artist: '酷我歌手', duration: 210 };
  }

  protected buildEndpointCandidates(songId: string, quality: Quality) {
    return [
      {
        url: `https://antiserver.kuwo.cn/anti.s?type=convert_url&rid=${songId}&format=mp3|flac`,
        method: 'GET' as const,
        timeout: 10000,
        priority: 1,
      },
    ];
  }

  async healthCheck(): Promise<HealthStatus> {
    return { healthy: true, message: '酷我音乐兜底源就绪' };
  }
}
