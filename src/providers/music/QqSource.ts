import { BaseHttpSource } from './BaseHttpSource';
import type { EndpointCandidate } from './types';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult, SongDetail, HealthStatus, PlayUrlResult } from '@core/types';
import { YinliuError, ErrorCode } from '@core/types';

/**
 * QQ音乐音源Provider
 * 源标识：qq
 * 接口：u.y.qq.com/cgi-bin/musicu.fcg (统一网关)
 * 音质：13档降级链
 * 并发：官方Vkey端点 + 海棠resolve-url + 多个第三方代理竞速
 */
export class QqSource extends BaseHttpSource {
  readonly id = 'qq';
  readonly name = 'QQ音乐';
  readonly maxQuality = Quality.HIFI;
  private readonly baseUrl = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

  // 13档音质降级链
  private readonly qualityChain: Array<{ quality: Quality; format: string; bitrate: number }> = [
    { quality: Quality.HIFI, format: 'AIM0.mflac', bitrate: 3000 },
    { quality: Quality.JYEFFECT, format: 'Q0M1.mflac', bitrate: 2400 },
    { quality: Quality.SKY, format: 'Q0M0.mflac', bitrate: 2400 },
    { quality: Quality.HIRES, format: 'RSM1.mflac', bitrate: 1800 },
    { quality: Quality.LOSSLESS, format: 'F0M0.mflac', bitrate: 1000 },
    { quality: Quality.LOSSLESS, format: 'A000.ape', bitrate: 1000 },
    { quality: Quality.HIGH, format: 'M800.mp3', bitrate: 320 },
    { quality: Quality.HIGH, format: 'C600.mp3', bitrate: 320 },
    { quality: Quality.STANDARD, format: 'M500.mp3', bitrate: 128 },
    { quality: Quality.STANDARD, format: 'C400.mp3', bitrate: 128 },
    { quality: Quality.LOW, format: 'C200.mp3', bitrate: 48 },
  ];

  async search(params: SearchParams): Promise<SearchResult[]> {
    const page = params.page || 0;
    const pageSize = params.pageSize || 30;

    const reqBody = {
      req_1: {
        method: 'DoSearchForQQMusicDesktop',
        module: 'music.search.SearchCgiService',
        param: {
          num_per_page: pageSize,
          page_num: page + 1,
          query: params.keyword,
          search_type: params.type === 'song' ? 0 : 0,
        },
      },
    };

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Referer': 'https://y.qq.com',
          'Origin': 'https://y.qq.com',
        },
        body: JSON.stringify(reqBody),
      });

      if (!response.ok) {
        return this.fallbackSearch(params);
      }

      const data = await response.json();
      const list = data?.req_1?.data?.body?.song?.list || [];
      return list.map((item: any) => this.mapSearchResult(item));
    } catch {
      return this.fallbackSearch(params);
    }
  }

  private fallbackSearch(params: SearchParams): SearchResult[] {
    return [];
  }

  private mapSearchResult(item: any): SearchResult {
    return {
      id: `qq_${item.mid || item.songmid}`,
      type: 'song',
      title: item.name || item.title || item.songname || '未知歌曲',
      artist: item.singer?.map((s: any) => s.name).join('/') || item.singername || '未知歌手',
      album: item.album?.name || item.albumname || '',
      duration: item.interval || 0,
      coverUrl: item.album?.mid
        ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.album.mid}.jpg`
        : '',
      sourceId: this.id,
      sourceSongId: item.mid || item.songmid || item.id,
      quality: this.inferQuality(item),
      bitrate: item.size128 ? 128 : item.size320 ? 320 : item.sizeflac ? 1000 : 128,
    };
  }

  private inferQuality(item: any): Quality {
    if (item.sizehires || item.sizeatmos) return Quality.HIFI;
    if (item.sizeflac) return Quality.LOSSLESS;
    if (item.size320) return Quality.HIGH;
    return Quality.STANDARD;
  }

  async getSongDetail(songId: string): Promise<SongDetail> {
    const reqBody = {
      req_1: {
        method: 'GetSongInfoDetail',
        module: 'music.pf_song_detail',
        param: {
          song_mid: songId,
        },
      },
    };

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Referer': 'https://y.qq.com',
        },
        body: JSON.stringify(reqBody),
      });

      if (!response.ok) {
        return this.buildDetailFromId(songId);
      }

      const data = await response.json();
      const track = data?.req_1?.data?.track_info;

      if (!track) {
        return this.buildDetailFromId(songId);
      }

      return {
        id: songId,
        title: track.name || '未知歌曲',
        artist: track.singer?.map((s: any) => s.name).join('/') || '',
        album: track.album?.name || '',
        duration: track.interval || 0,
        coverUrl: track.album?.mid
          ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${track.album.mid}.jpg`
          : '',
      };
    } catch {
      return this.buildDetailFromId(songId);
    }
  }

  private buildDetailFromId(songId: string): SongDetail {
    return {
      id: songId,
      title: 'QQ音乐歌曲',
      artist: '',
      album: '',
      duration: 0,
      coverUrl: '',
    };
  }

  async getLyrics(songId: string): Promise<string | null> {
    const reqBody = {
      req_1: {
        method: 'GetPlayLyricInfo',
        module: 'music.musichallSongPlayLyricInfo',
        param: {
          songMID: songId,
        },
      },
    };

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Referer': 'https://y.qq.com',
        },
        body: JSON.stringify(reqBody),
      });

      if (!response.ok) return null;

      const data = await response.json();
      const lyric = data?.req_1?.data?.lyric;
      return lyric || null;
    } catch {
      return null;
    }
  }

  async getPlaylist(playlistId: string) {
    const reqBody = {
      req_1: {
        method: 'GetPlaylistDetail',
        module: 'music.srfDissInfo.DissInfo',
        param: {
          disstid: playlistId,
          dirid: 0,
          song_num: 100,
        },
      },
    };

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Referer': 'https://y.qq.com',
        },
        body: JSON.stringify(reqBody),
      });

      if (!response.ok) {
        throw new YinliuError(ErrorCode.SOURCE_ERROR, '获取歌单失败', 502);
      }

      const data = await response.json();
      const cdlist = data?.req_1?.data?.cdlist?.[0];

      return {
        id: playlistId,
        name: cdlist?.dissname || 'QQ音乐歌单',
        description: cdlist?.desc || '',
        coverUrl: cdlist?.logo || '',
        songs: (cdlist?.songlist || []).map((item: any) => this.mapSearchResult(item)),
        total: cdlist?.songlist?.length || 0,
      };
    } catch (err) {
      if (err instanceof YinliuError) throw err;
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '获取歌单失败', 502);
    }
  }

  async parsePlaylistUrl(url: string) {
    const match = url.match(/(?:playlist|id)[/=](\d+)/);
    if (!match) {
      throw new YinliuError(ErrorCode.VALIDATION_ERROR, '无法解析QQ音乐歌单URL', 400);
    }
    return this.getPlaylist(match[1]);
  }

  /**
   * 构建取链候选端点
   * 包含：官方Vkey端点 + 海棠resolve-url + 多个第三方代理 并发竞速
   */
  protected buildEndpointCandidates(songId: string, quality: Quality): EndpointCandidate[] {
    const candidates: EndpointCandidate[] = this.buildOfficialEndpoints(songId, quality);
    candidates.push(...this.buildProxyEndpoints(songId, quality));
    return candidates;
  }

  private buildOfficialEndpoints(songId: string, quality: Quality): EndpointCandidate[] {
    const endpoints: EndpointCandidate[] = [];
    const targetFormats = this.getFormatsForQuality(quality);

    for (const fmt of targetFormats) {
      const vkeyUrl = this.buildVkeyUrl(songId, fmt.format);
      endpoints.push({
        url: vkeyUrl,
        method: 'GET',
        timeout: 8000,
        priority: 1,
        headers: {
          'Referer': 'https://y.qq.com',
        },
      });
    }

    return endpoints;
  }

  private buildProxyEndpoints(songId: string, quality: Quality) {
    const level = this.mapQualityToHaitangLevel(quality);

    const proxyUrls: EndpointCandidate[] = [
      // 海棠resolve-url POST（最稳定）
      {
        url: 'https://musicserver.haitangw.cc/v1/music/resolve-url',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify({ source: 'tx', rid: songId, level }),
        timeout: 15000,
        priority: 2,
      },
      // metingapi代理
      {
        url: `https://metingapi.nanorocky.top/?server=tencent&type=url&id=${songId}`,
        method: 'GET',
        timeout: 10000,
        priority: 3,
      },
      // vkeys代理
      {
        url: `https://api.vkeys.cn/?server=tencent&type=url&id=${songId}`,
        method: 'GET',
        timeout: 10000,
        priority: 3,
      },
    ];

    return proxyUrls;
  }

  private buildVkeyUrl(songId: string, format: string): string {
    const guid = Math.floor(Math.random() * 1000000000);
    const reqBody = {
      req_1: {
        method: 'GetCdnDispatch',
        module: 'CDN.SrfCdnDispatchServer',
        param: {
          calltype: 0,
          guid: guid.toString(),
          uin: '0',
          songtype: [0],
          songmid: [songId],
        },
      },
      req_2: {
        method: 'GetVkeyServer',
        module: 'vkey.GetVkeyServer',
        param: {
          guid: guid.toString(),
          songmid: [songId],
          songtype: [0],
          uin: '0',
          loginflag: 0,
          platform: '20',
        },
      },
    };

    return `${this.baseUrl}?format=json&data=${encodeURIComponent(JSON.stringify(reqBody))}`;
  }

  protected async parsePlayUrlResponse(
    response: Response,
    candidate: EndpointCandidate,
    targetQuality: Quality
  ): Promise<PlayUrlResult | null> {
    // 官方Vkey接口
    if (candidate.url.includes('musicu.fcg') && candidate.method === 'GET') {
      const data = await response.json();
      const req2 = data?.req_2?.data;
      const midUrlInfo = req2?.midurlinfo?.[0];
      if (!midUrlInfo?.purl) return null;

      const sip = req2?.sip?.[0] || 'https://ws.stream.qqmusic.qq.com/';
      const url = `${sip}${midUrlInfo.purl}`;
      return {
        url,
        quality: targetQuality,
        bitrate: this.inferBitrateFromFormat(midUrlInfo.purl),
        format: this.inferFormatFromFilename(midUrlInfo.purl),
        headers: candidate.headers,
      };
    }

    // 海棠resolve-url POST
    if (candidate.url.includes('haitangw.cc') && candidate.method === 'POST') {
      try {
        const data = await response.json();
        const url = data?.url || data?.data?.url;
        if (!url || typeof url !== 'string') return null;
        const ct = response.headers.get('content-type') || '';
        return {
          url,
          quality: targetQuality,
          bitrate: ct.includes('flac') ? 1000 : 320,
          format: ct.includes('flac') ? 'flac' : 'mp3',
          headers: candidate.headers,
        };
      } catch {
        return null;
      }
    }

    // 其他第三方代理（metingapi/vkeys等）
    if (candidate.method === 'GET' && !candidate.url.includes('musicu.fcg')) {
      try {
        // 可能直接返回JSON {url} 或 302重定向
        const ct = response.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const data = await response.json();
          const url = data?.url || data;
          if (url && typeof url === 'string') {
            return {
              url,
              quality: targetQuality,
              bitrate: 128,
              format: 'mp3',
              headers: candidate.headers,
            };
          }
        }
        // 可能直接是音频流（302后的）
        if (ct.includes('audio/') || ct.includes('application/octet-stream')) {
          return {
            url: candidate.url,
            quality: targetQuality,
            bitrate: 128,
            format: this.detectFormat(ct, candidate.url),
            headers: candidate.headers,
          };
        }
      } catch {
        return null;
      }
    }

    return null;
  }

  private getFormatsForQuality(quality: Quality): Array<{ format: string; bitrate: number }> {
    const rank = this.getQualityRank(quality);
    return this.qualityChain.filter((q) => this.getQualityRank(q.quality) <= rank);
  }

  private getQualityRank(q: Quality): number {
    const map: Record<Quality, number> = {
      [Quality.LOW]: 1,
      [Quality.STANDARD]: 2,
      [Quality.HIGHER]: 3,
      [Quality.HIGH]: 4,
      [Quality.LOSSLESS]: 5,
      [Quality.HIRES]: 6,
      [Quality.SKY]: 7,
      [Quality.JYEFFECT]: 8,
      [Quality.HIFI]: 9,
    };
    return map[q] || 2;
  }

  private mapQualityToHaitangLevel(quality: Quality): string {
    switch (quality) {
      case Quality.HIFI:
        return 'jymaster';
      case Quality.JYEFFECT:
      case Quality.SKY:
        return 'sky';
      case Quality.HIRES:
        return 'hires';
      case Quality.LOSSLESS:
        return 'lossless';
      case Quality.HIGH:
      case Quality.HIGHER:
        return 'exhigh';
      case Quality.STANDARD:
      case Quality.LOW:
      default:
        return 'standard';
    }
  }

  private inferBitrateFromFormat(purl: string): number {
    if (purl.includes('M800') || purl.includes('C600')) return 320;
    if (purl.includes('M500') || purl.includes('C400')) return 128;
    if (purl.includes('F0M0') || purl.includes('A000')) return 1000;
    if (purl.includes('RSM1')) return 1800;
    if (purl.includes('AIM0')) return 3000;
    return 128;
  }

  private inferFormatFromFilename(purl: string): string {
    if (purl.endsWith('.mflac')) return 'mflac';
    if (purl.endsWith('.flac')) return 'flac';
    if (purl.endsWith('.ape')) return 'ape';
    if (purl.endsWith('.mp3')) return 'mp3';
    return 'mp3';
  }

  async getCharts() {
    try {
      const reqBody = {
        req_1: {
          method: 'GetToplistList',
          module: 'music.toplist.ToplistInfoServer',
          param: {},
        },
      };

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Referer': 'https://y.qq.com' },
        body: JSON.stringify(reqBody),
      });

      if (!response.ok) return [];

      const data = await response.json();
      const groups = data?.req_1?.data?.group || [];
      const charts: Array<{ id: string; name: string; description?: string }> = [];

      for (const group of groups) {
        for (const item of group.list || []) {
          charts.push({
            id: item.topId?.toString() || item.id,
            name: item.title || item.name,
            description: group.groupName,
          });
        }
      }

      return charts;
    } catch {
      return [];
    }
  }

  async getChartDetail(chartId: string) {
    const reqBody = {
      req_1: {
        method: 'GetDetail',
        module: 'music.toplist.ToplistInfoServer',
        param: {
          topId: parseInt(chartId, 10),
          offset: 0,
          num: 100,
        },
      },
    };

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Referer': 'https://y.qq.com' },
        body: JSON.stringify(reqBody),
      });

      if (!response.ok) {
        throw new YinliuError(ErrorCode.SOURCE_ERROR, '获取排行榜失败', 502);
      }

      const data = await response.json();
      const songList = data?.req_1?.data?.songInfo?.list || [];

      return {
        id: chartId,
        name: 'QQ音乐排行榜',
        songs: songList.map((item: any) => this.mapSearchResult(item)),
      };
    } catch (err) {
      if (err instanceof YinliuError) throw err;
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '获取排行榜失败', 502);
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const response = await fetch('https://y.qq.com', {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      return {
        healthy: response.ok,
        message: response.ok ? 'QQ音乐服务正常' : 'QQ音乐服务异常',
        latency: 0,
      };
    } catch {
      return { healthy: false, message: 'QQ音乐服务不可用' };
    }
  }
}
