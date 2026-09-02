import { BaseHttpSource } from './BaseHttpSource';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult, SongDetail, HealthStatus, PlayUrlResult } from '@core/types';
import type { EndpointCandidate } from './types';
import { YinliuError, ErrorCode } from '@core/types';
import { decryptH5v24Response } from '@shared/audio/crypto';

/**
 * 咪咕音乐音源Provider
 * 源标识：mg
 * 接口：app.c.nf.migu.cn / pd.musicapp.migu.cn（JSON API）
 * 特色：URL派生法（PQ→HQ/SQ/ZQ24替换目录+扩展名），免登录全音质
 * 并发：官方listen接口 + URL派生 + 第三方代理竞速
 */
export class MiguSource extends BaseHttpSource {
  readonly id = 'migu';
  readonly name = '咪咕音乐';
  readonly maxQuality = Quality.HIRES;
  private readonly apiBase = 'https://app.c.nf.migu.cn';
  private readonly bmwBase = 'https://pd.musicapp.migu.cn/MIGU/3.0.0/v2.0/content';

  async search(params: SearchParams): Promise<SearchResult[]> {
    const page = params.page || 0;
    const pageSize = params.pageSize || 30;

    const searchUrl = `${this.bmwBase}/search_all.do?&text=${encodeURIComponent(params.keyword)}&pageNo=${page + 1}&pageSize=${pageSize}&searchSwitch={"song":1,"album":0,"singer":0,"tagSong":0,"mvSong":0,"songlist":0,"bestShow":1}`;

    try {
      const response = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://music.migu.cn/',
        },
      });

      if (!response.ok) {
        return this.fallbackSearch(params);
      }

      const data = await response.json();
      const songResult = data?.songResultData?.result || [];

      return songResult.map((item: any) => this.mapSearchResult(item));
    } catch {
      return this.fallbackSearch(params);
    }
  }

  private fallbackSearch(params: SearchParams): SearchResult[] {
    return [];
  }

  private mapSearchResult(item: any): SearchResult {
    const contentId = item.contentId || item.id || '';
    const copyrightId = item.copyrightId || '';
    const newRateFormats = item.newRateFormats || [];

    let maxQuality = Quality.STANDARD;
    let maxBitrate = 128;

    for (const fmt of newRateFormats) {
      const formatType = fmt.formatType || '';
      if (formatType.includes('ZQ24') || formatType.includes('Hires')) {
        maxQuality = Quality.HIRES;
        maxBitrate = 1800;
      } else if (formatType.includes('SQ') && maxQuality !== Quality.HIRES) {
        maxQuality = Quality.LOSSLESS;
        maxBitrate = 1000;
      } else if (formatType.includes('HQ') && maxQuality === Quality.STANDARD) {
        maxQuality = Quality.HIGH;
        maxBitrate = 320;
      }
    }

    return {
      id: `mg_${contentId}`,
      type: 'song',
      title: item.title || item.songName || '未知歌曲',
      artist: item.singerName || item.singer || '未知歌手',
      album: item.album || item.albumName || '',
      duration: item.length || item.duration || 0,
      coverUrl: item.img || item.imgItems?.[0]?.img || '',
      sourceId: this.id,
      sourceSongId: JSON.stringify({ contentId, copyrightId }),
      quality: maxQuality,
      bitrate: maxBitrate,
    };
  }

  async getSongDetail(songId: string): Promise<SongDetail> {
    const contentId = this.extractContentId(songId);

    try {
      const url = `${this.apiBase}/MIGU/3.0.0/v2.0/content/querySongInfo.do?contentId=${contentId}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36',
          'Referer': 'https://music.migu.cn/',
        },
      });

      if (!response.ok) {
        return this.buildDetailFromId(contentId);
      }

      const data = await response.json();
      const song = data?.data;

      if (!song) {
        return this.buildDetailFromId(contentId);
      }

      return {
        id: songId,
        title: song.title || '未知歌曲',
        artist: song.singerName || '',
        album: song.album || '',
        duration: song.length || 0,
        coverUrl: song.imgItems?.[0]?.img || '',
      };
    } catch {
      return this.buildDetailFromId(contentId);
    }
  }

  private buildDetailFromId(contentId: string): SongDetail {
    return {
      id: contentId,
      title: '咪咕音乐歌曲',
      artist: '',
      album: '',
      duration: 0,
      coverUrl: '',
    };
  }

  async getLyrics(songId: string): Promise<string | null> {
    const contentId = this.extractContentId(songId);

    try {
      const url = `${this.apiBase}/MIGU/3.0.0/v2.0/content/queryLyricInfo.do?contentId=${contentId}`;
      const response = await fetch(url);

      if (!response.ok) return null;

      const data = await response.json();
      const lyric = data?.data?.lyric;
      return lyric || null;
    } catch {
      return null;
    }
  }

  async getPlaylist(playlistId: string) {
    try {
      const url = `${this.bmwBase}/queryMusiclistSongs.do?musicListId=${playlistId}&pageSize=100`;
      const response = await fetch(url, {
        headers: { 'Referer': 'https://music.migu.cn/' },
      });

      if (!response.ok) {
        throw new YinliuError(ErrorCode.SOURCE_ERROR, '获取歌单失败', 502);
      }

      const data = await response.json();
      const list = data?.data?.items || [];

      return {
        id: playlistId,
        name: data?.data?.musicListTitle || '咪咕歌单',
        description: data?.data?.musicListSummary || '',
        coverUrl: data?.data?.img || '',
        songs: list.map((item: any) => this.mapSearchResult(item)),
        total: list.length,
      };
    } catch (err) {
      if (err instanceof YinliuError) throw err;
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '获取歌单失败', 502);
    }
  }

  async parsePlaylistUrl(url: string) {
    const match = url.match(/playlist[\/](\d+)/);
    if (!match) {
      throw new YinliuError(ErrorCode.VALIDATION_ERROR, '无法解析咪咕歌单URL', 400);
    }
    return this.getPlaylist(match[1]);
  }

  /**
   * 构建取链候选端点
   * 包含：官方listen接口 + h5v2.4加密接口 + URL派生法 + 第三方代理 并发竞速
   */
  protected buildEndpointCandidates(songId: string, quality: Quality): EndpointCandidate[] {
    const { contentId, copyrightId } = this.parseSongId(songId);
    const candidates: EndpointCandidate[] = [];

    // 官方接口1：listenUrl
    candidates.push({
      url: `${this.apiBase}/MIGU/3.0.0/v2.0/content/listenUrl.do?contentId=${contentId}&resourceType=2&purpose=1&channel=0`,
      method: 'GET',
      timeout: 8000,
      priority: 1,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36',
        'Referer': 'https://music.migu.cn/',
      },
    });

    // 官方接口2：h5v2.4（加密响应，对版权受限歌曲有效）
    if (copyrightId) {
      const toneFlag = this.mapQualityToParam(quality);
      candidates.push({
        url: `https://c.musicapp.migu.cn/strategy/listen-url/h5/v2.4?contentId=${contentId}&copyrightId=${copyrightId}&resourceType=2&netType=01&toneFlag=${toneFlag}&scene=&lowerQualityContentId=${contentId}`,
        method: 'GET',
        timeout: 15000,
        priority: 1,
        headers: {
          'birth': 'h5page',
          'channel': '014X031',
          'Referer': 'https://y.migu.cn/',
          'location-data': '30.6698676660,104.1229614820',
          'location-info': '',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
    }

    // 官方接口3：URL派生法
    const derivedUrls = this.buildDerivedUrls(contentId, quality);
    for (const url of derivedUrls) {
      candidates.push({
        url,
        method: 'GET',
        timeout: 10000,
        priority: 1,
      });
    }

    // 第三方代理
    candidates.push({
      url: `https://migu-api-enhanced.example/v1/song/url?id=${contentId}&quality=${this.mapQualityToParam(quality)}`,
      method: 'GET',
      timeout: 10000,
      priority: 2,
    });

    return candidates;
  }

  protected async parsePlayUrlResponse(
    response: Response,
    candidate: EndpointCandidate,
    targetQuality: Quality
  ): Promise<PlayUrlResult | null> {
    // 官方listenUrl接口
    if (candidate.url.includes('listenUrl.do')) {
      const data = await response.json();
      const url = data?.data?.url;
      if (!url || typeof url !== 'string') return null;
      return {
        url,
        quality: targetQuality,
        bitrate: 128,
        format: 'mp3',
        headers: candidate.headers,
      };
    }

    // h5v2.4：加密二进制响应，需先解密
    if (candidate.url.includes('h5/v2.4')) {
      try {
        const raw = new Uint8Array(await response.arrayBuffer());
        const result = decryptH5v24Response(raw);
        if (result.code !== '000000') return null;
        const data = result.data as Record<string, unknown> | undefined;
        const url = data?.url as string | undefined;
        if (!url || typeof url !== 'string') return null;
        const fmt = String(data?.audioFormatType || 'PQ');
        return {
          url,
          quality: targetQuality,
          bitrate: fmt === 'PQ' ? 128 : fmt === 'HQ' ? 320 : fmt === 'SQ' ? 1000 : 128,
          format: url.endsWith('.flac') ? 'flac' : 'mp3',
          headers: candidate.headers,
        };
      } catch {
        return null;
      }
    }

    // URL派生法：直接返回音频流
    if (candidate.url.includes('freetyst.nf.migu.cn')) {
      const ct = response.headers.get('content-type') || '';
      if (response.ok && (ct.includes('audio/') || ct.includes('application/octet-stream') || response.status === 200)) {
        return {
          url: candidate.url,
          quality: targetQuality,
          bitrate: this.estimateBitrateFromDerivedUrl(candidate.url),
          format: this.inferFormatFromDerivedUrl(candidate.url),
          headers: candidate.headers,
        };
      }
      return null;
    }

    // 第三方代理
    if (candidate.url.includes('migu-api-enhanced')) {
      try {
        const data = await response.json();
        const url = data?.url || data?.data?.url;
        if (!url || typeof url !== 'string') return null;
        return {
          url,
          quality: targetQuality,
          bitrate: 128,
          format: 'mp3',
          headers: candidate.headers,
        };
      } catch {
        return null;
      }
    }

    return null;
  }

  private buildDerivedUrls(contentId: string, quality: Quality): string[] {
    const urls: string[] = [];
    const pqUrl = `https://freetyst.nf.migu.cn/${contentId}.mp3`;

    switch (quality) {
      case Quality.HIFI:
      case Quality.HIRES:
        urls.push(pqUrl.replace('.mp3', '_ZQ24.flac'));
        urls.push(pqUrl.replace('.mp3', '_SQ.flac'));
        break;
      case Quality.LOSSLESS:
        urls.push(pqUrl.replace('.mp3', '_SQ.flac'));
        break;
      case Quality.HIGH:
        urls.push(pqUrl.replace('.mp3', '_HQ.mp3'));
        break;
      case Quality.STANDARD:
      default:
        urls.push(pqUrl);
        break;
    }

    return urls;
  }

  private estimateBitrateFromDerivedUrl(url: string): number {
    if (url.includes('_ZQ24')) return 1800;
    if (url.includes('_SQ')) return 1000;
    if (url.includes('_HQ')) return 320;
    return 128;
  }

  private inferFormatFromDerivedUrl(url: string): string {
    if (url.endsWith('.flac')) return 'flac';
    if (url.endsWith('.mp3')) return 'mp3';
    return 'mp3';
  }

  private mapQualityToParam(quality: Quality): string {
    switch (quality) {
      case Quality.HIFI:
      case Quality.HIRES:
        return 'ZQ24';
      case Quality.LOSSLESS:
        return 'SQ';
      case Quality.HIGH:
        return 'HQ';
      case Quality.STANDARD:
      default:
        return 'PQ';
    }
  }

  private extractContentId(songId: string): string {
    if (songId.startsWith('mg_')) {
      return songId.slice(3);
    }
    return songId;
  }

  private parseSongId(songId: string): { contentId: string; copyrightId: string } {
    try {
      const parsed = JSON.parse(songId);
      return {
        contentId: parsed.contentId || songId,
        copyrightId: parsed.copyrightId || '',
      };
    } catch {
      return { contentId: songId, copyrightId: '' };
    }
  }

  async getCharts() {
    try {
      const url = `${this.bmwBase}/queryMusiclistByType.do?type=2&pageSize=50`;
      const response = await fetch(url, {
        headers: { 'Referer': 'https://music.migu.cn/' },
      });
      if (!response.ok) return [];

      const data = await response.json();
      const lists = data?.data || [];

      return lists.map((item: any) => ({
        id: item.musicListId?.toString() || item.id,
        name: item.musicListTitle || item.title,
        description: item.musicListSummary || '',
      }));
    } catch {
      return [];
    }
  }

  async getChartDetail(chartId: string) {
    return this.getPlaylist(chartId);
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const response = await fetch('https://music.migu.cn', {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      return {
        healthy: response.ok,
        message: response.ok ? '咪咕音乐服务正常' : '咪咕音乐服务异常',
        latency: 0,
      };
    } catch {
      return { healthy: false, message: '咪咕音乐服务不可用' };
    }
  }
}
