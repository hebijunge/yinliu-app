import { BaseHttpSource } from './BaseHttpSource';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult, SongDetail, HealthStatus } from '@core/types';
import { YinliuError, ErrorCode } from '@core/types';

/**
 * 咪咕音乐音源Provider
 * 接口：app.c.nf.migu.cn / pd.musicapp.migu.cn（JSON API）
 * 特色：URL派生法（PQ→HQ/SQ/ZQ24替换目录+扩展名），免登录全音质
 * 并发：官方listen接口 + URL派生 + 第三方代理
 */
export class MiguSource extends BaseHttpSource {
  readonly id = 'migu';
  readonly name = '咪咕音乐';
  readonly maxQuality = Quality.HIRES;
  private readonly apiBase = 'https://app.c.nf.migu.cn';
  private readonly bmwBase = 'https://pd.musicapp.migu.cn/MIGU/3.0.0/v2.0/content';

  /**
   * 搜索歌曲
   */
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
    const contentId = item.contentId || item.copyrightId || item.id || '';
    const newRateFormats = item.newRateFormats || [];

    // 找出最高音质
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
      id: `migu_${contentId}`,
      type: 'song',
      title: item.title || item.songName || '未知歌曲',
      artist: item.singerName || item.singer || '未知歌手',
      album: item.album || item.albumName || '',
      duration: item.length || item.duration || 0,
      coverUrl: item.img || item.imgItems?.[0]?.img || '',
      sourceId: this.id,
      sourceSongId: contentId,
      quality: maxQuality,
      bitrate: maxBitrate,
    };
  }

  /**
   * 获取歌曲详情
   */
  async getSongDetail(songId: string): Promise<SongDetail> {
    const contentId = this.extractContentId(songId);

    try {
      const url = `${this.apiBase}/MIGU/3.0.0/v2.0/content/querySongInfo.do?contentId=${contentId}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36',
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

  /**
   * 获取歌词
   */
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

  /**
   * 获取歌单详情
   */
  async getPlaylist(playlistId: string) {
    try {
      const url = `${this.bmwBase}/queryMusiclistSongs.do?musicListId=${playlistId}&pageSize=100`;
      const response = await fetch(url);

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

  /**
   * 解析歌单URL
   */
  async parsePlaylistUrl(url: string) {
    // 咪咕歌单URL格式：
    // https://music.migu.cn/v3/music/playlist/123456789
    const match = url.match(/playlist[\/](\d+)/);
    if (!match) {
      throw new YinliuError(ErrorCode.VALIDATION_ERROR, '无法解析咪咕歌单URL', 400);
    }
    return this.getPlaylist(match[1]);
  }

  /**
   * 构建取链候选端点
   * 包含：官方listen接口 + URL派生法 + 第三方代理
   */
  protected buildEndpointCandidates(songId: string, quality: Quality) {
    const contentId = this.extractContentId(songId);
    const candidates = [];

    // 官方listen接口
    candidates.push({
      url: `${this.apiBase}/MIGU/3.0.0/v2.0/content/listenUrl.do?contentId=${contentId}&resourceType=2&purpose=1&channel=0`,
      method: 'GET' as const,
      timeout: 8000,
      priority: 1,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36',
      },
    });

    // URL派生法：通过PQ URL派生HQ/SQ/ZQ24
    const derivedUrls = this.buildDerivedUrls(contentId, quality);
    for (const url of derivedUrls) {
      candidates.push({
        url,
        method: 'GET' as const,
        timeout: 10000,
        priority: 1,
      });
    }

    // 第三方代理
    candidates.push({
      url: `https://migu-api-enhanced.example/v1/song/url?id=${contentId}&quality=${this.mapQualityToParam(quality)}`,
      method: 'GET' as const,
      timeout: 10000,
      priority: 2,
    });

    return candidates;
  }

  /**
   * URL派生法：从PQ（标准音质）URL派生HQ/SQ/ZQ24 URL
   * 原理：替换目录名和扩展名，CDN只校验Tim/Key参数
   */
  private buildDerivedUrls(contentId: string, quality: Quality): string[] {
    const urls: string[] = [];

    // 先获取PQ URL，然后替换
    const pqUrl = `https://freetyst.nf.migu.cn/${contentId}.mp3`;

    switch (quality) {
      case Quality.HIFI:
      case Quality.HIRES:
        // ZQ24
        urls.push(pqUrl.replace('.mp3', '_ZQ24.flac'));
        urls.push(pqUrl.replace('.mp3', '_SQ.flac'));
        break;
      case Quality.LOSSLESS:
        // SQ FLAC
        urls.push(pqUrl.replace('.mp3', '_SQ.flac'));
        break;
      case Quality.HIGH:
        // HQ 320K
        urls.push(pqUrl.replace('.mp3', '_HQ.mp3'));
        break;
      case Quality.STANDARD:
      default:
        // PQ 128K
        urls.push(pqUrl);
        break;
    }

    return urls;
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
    // songId可能是 migu_xxx 或纯contentId
    if (songId.startsWith('migu_')) {
      return songId.slice(5);
    }
    return songId;
  }

  /**
   * 获取歌曲音质信息
   */
  async getSongRateInfo(contentId: string) {
    try {
      const url = `${this.apiBase}/MIGU/3.0.0/v2.0/content/querySongInfo.do?contentId=${contentId}`;
      const response = await fetch(url);
      if (!response.ok) return null;

      const data = await response.json();
      return data?.data?.newRateFormats || [];
    } catch {
      return null;
    }
  }

  /**
   * 获取排行榜列表
   */
  async getCharts() {
    try {
      const url = `${this.bmwBase}/queryMusiclistByType.do?type=2&pageSize=50`;
      const response = await fetch(url);
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

  /**
   * 获取排行榜详情
   */
  async getChartDetail(chartId: string) {
    return this.getPlaylist(chartId);
  }

  /**
   * 健康检查
   */
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
