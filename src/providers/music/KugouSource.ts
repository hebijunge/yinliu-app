import { BaseHttpSource } from './BaseHttpSource';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult, SongDetail, HealthStatus, PlayUrlResult } from '@core/types';
import { YinliuError, ErrorCode } from '@core/types';

/**
 * 酷狗音乐音源Provider
 * 接口：mobilecdn.kugou.com/api/v3/（JSON API）
 * 特色：hash-based歌曲标识 + HashCache映射
 * 并发：官方 + 海棠resolve-url代理
 */
export class KugouSource extends BaseHttpSource {
  readonly id = 'kugou';
  readonly name = '酷狗音乐';
  readonly maxQuality = Quality.HIRES;
  private readonly searchBase = 'https://mobilecdn.kugou.com/api/v3';
  private readonly apiBase = 'https://m.kugou.com';

  // HashCache：32-bit hash到自增Int id的映射
  private hashCache = new Map<string, string>();
  private nextHashId = 1;

  /**
   * 搜索歌曲
   */
  async search(params: SearchParams): Promise<SearchResult[]> {
    const page = params.page || 0;
    const pageSize = params.pageSize || 30;

    const searchUrl = `${this.searchBase}/search/song?keyword=${encodeURIComponent(params.keyword)}&page=${page + 1}&pagesize=${pageSize}&showtype=14&filter=0`;

    try {
      const response = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      if (!response.ok) {
        return this.fallbackSearch(params);
      }

      const data = await response.json();
      const info = data?.data?.info || [];

      return info.map((item: any) => this.mapSearchResult(item));
    } catch {
      return this.fallbackSearch(params);
    }
  }

  private fallbackSearch(params: SearchParams): SearchResult[] {
    return [];
  }

  private mapSearchResult(item: any): SearchResult {
    const hash = item.hash || item.FileHash || '';
    const albumId = item.album_id || item.albumId || '';

    // 缓存hash映射
    let hashId = this.hashCache.get(hash);
    if (!hashId) {
      hashId = `kg_${this.nextHashId++}`;
      this.hashCache.set(hash, hashId);
    }

    return {
      id: hashId,
      type: 'song',
      title: item.songname || item.SongName || '未知歌曲',
      artist: item.singername || item.SingerName || '未知歌手',
      album: item.album_name || item.AlbumName || '',
      duration: item.duration || item.Duration || 0,
      coverUrl: albumId ? `https://imge.kugou.com/stdmusic/${albumId % 100}/${albumId}.jpg` : '',
      sourceId: this.id,
      sourceSongId: hash,
      quality: this.inferQuality(item),
      bitrate: item.bitrate ? parseInt(item.bitrate, 10) : 128,
    };
  }

  private inferQuality(item: any): Quality {
    if (item.sqhash || item.SQFileHash) return Quality.LOSSLESS;
    if (item['320hash'] || item.FileHash_320) return Quality.HIGH;
    return Quality.STANDARD;
  }

  /**
   * 获取歌曲详情
   */
  async getSongDetail(songId: string): Promise<SongDetail> {
    // songId可能是hash或我们生成的hashId
    const hash = this.getHashFromId(songId);

    try {
      const url = `${this.apiBase}/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      if (!response.ok) {
        return this.buildDetailFromHash(hash);
      }

      const data = await response.json();

      return {
        id: songId,
        title: data.songName || '未知歌曲',
        artist: data.singerName || '',
        album: data.albumName || '',
        duration: data.timeLength ? parseInt(data.timeLength, 10) : 0,
        coverUrl: data.cover || data.imgUrl || '',
      };
    } catch {
      return this.buildDetailFromHash(hash);
    }
  }

  private buildDetailFromHash(hash: string): SongDetail {
    return {
      id: hash,
      title: '酷狗音乐歌曲',
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
    const hash = this.getHashFromId(songId);

    try {
      // 第一步：搜索krcs
      const searchUrl = `${this.apiBase}/app/i/krc.php?cmd=100&hash=${hash}&timelength=1&d=0.1`;
      const searchResponse = await fetch(searchUrl);
      if (!searchResponse.ok) return null;

      const searchData = await searchResponse.json();
      const candidates = searchData?.candidates || [];
      if (candidates.length === 0) return null;

      // 第二步：下载歌词
      const best = candidates[0];
      const lyricUrl = `${this.apiBase}/app/i/krc.php?cmd=100&keyword=${encodeURIComponent(best.keyword || '')}&timelength=${best.duration || 1}&hash=${hash}&d=0.1`;

      const lyricResponse = await fetch(lyricUrl);
      if (!lyricResponse.ok) return null;

      const lyricData = await lyricResponse.json();
      const content = lyricData?.content;

      if (content) {
        // Base64解码LRC
        try {
          return atob(content);
        } catch {
          return content;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * 获取歌单详情
   */
  async getPlaylist(playlistId: string) {
    try {
      const url = `${this.apiBase}/plist/list/${playlistId}?json=true`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new YinliuError(ErrorCode.SOURCE_ERROR, '获取歌单失败', 502);
      }

      const data = await response.json();
      const info = data?.info?.list || {};
      const songs = data?.list?.list?.info || [];

      return {
        id: playlistId,
        name: info.specialname || '酷狗歌单',
        description: info.intro || '',
        coverUrl: info.imgurl?.replace('{size}', '400') || '',
        songs: songs.map((item: any) => this.mapSearchResult(item)),
        total: songs.length,
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
    // 酷狗歌单URL格式：
    // https://www.kugou.com/yy/special/single/123456.html
    // https://www.kugou.com/yy/special/single/123456-abc.html
    const match = url.match(/special[\/]single[\/](\d+)/);
    if (!match) {
      throw new YinliuError(ErrorCode.VALIDATION_ERROR, '无法解析酷狗歌单URL', 400);
    }
    return this.getPlaylist(match[1]);
  }

  /**
   * 构建取链候选端点
   * 包含：官方getSongInfo + 海棠代理
   */
  protected buildEndpointCandidates(songId: string, quality: Quality) {
    const hash = this.getHashFromId(songId);
    const candidates = [];

    // 官方端点
    const qualityParam = this.mapQualityToParam(quality);
    candidates.push({
      url: `${this.apiBase}/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}&quality=${qualityParam}`,
      method: 'GET' as const,
      timeout: 8000,
      priority: 1,
    });

    // 海棠代理
    candidates.push({
      url: `https://musicserver.haitangw.cc/v1/music/resolve-url?source=kg&hash=${hash}`,
      method: 'GET' as const,
      timeout: 10000,
      priority: 2,
    });

    return candidates;
  }

  private mapQualityToParam(quality: Quality): string {
    switch (quality) {
      case Quality.HIFI:
      case Quality.HIRES:
      case Quality.LOSSLESS:
        return 'flac';
      case Quality.HIGH:
        return '320';
      case Quality.STANDARD:
      default:
        return '128';
    }
  }

  private getHashFromId(songId: string): string {
    // 如果songId是hash本身（32位hex），直接返回
    if (/^[a-f0-9]{32}$/i.test(songId)) return songId;

    // 如果是我们生成的hashId（kg_数字），尝试反向查找
    for (const [hash, id] of this.hashCache.entries()) {
      if (id === songId) return hash;
    }

    return songId;
  }

  /**
   * 获取歌曲音质大小信息
   */
  async getSongSizes(hash: string) {
    try {
      const url = `${this.apiBase}/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`;
      const response = await fetch(url);
      if (!response.ok) return null;

      const data = await response.json();
      return {
        fileSize: data.fileSize || 0,
        size320: data.fileSize_320 || 0,
        sizeFlac: data.fileSize_flac || 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<HealthStatus> {
    try {
      const response = await fetch('https://www.kugou.com', {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      return {
        healthy: response.ok,
        message: response.ok ? '酷狗音乐服务正常' : '酷狗音乐服务异常',
        latency: 0,
      };
    } catch {
      return { healthy: false, message: '酷狗音乐服务不可用' };
    }
  }
}
