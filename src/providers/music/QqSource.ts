import { BaseHttpSource } from './BaseHttpSource';
import type { EndpointCandidate } from './types';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult, SongDetail, HealthStatus, PlayUrlResult, PlaylistSummary, TierSizes, QualityOption, QualityTier } from '@core/types';
import { YinliuError, ErrorCode } from '@core/types';

/**
 * QQ音乐音源Provider
 * 接口：u.y.qq.com/cgi-bin/musicu.fcg (统一网关)
 * 音质：13档降级链（母带→杜比→Hi-Res→FLAC→320k→128k...）
 * 并发：官方端点 + 5个第三方代理竞速
 */
export class QqSource extends BaseHttpSource {
  readonly id = 'qq';
  readonly name = 'QQ音乐';
  readonly maxQuality = Quality.HIFI;
  private readonly baseUrl = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

  // 13档音质降级链（从高到低）
  private readonly qualityChain: Array<{ quality: Quality; format: string; bitrate: number }> = [
    { quality: Quality.HIFI, format: 'AIM0.mflac', bitrate: 3000 },    // 至臻母带
    { quality: Quality.JYEFFECT, format: 'Q0M1.mflac', bitrate: 2400 }, // 全景声
    { quality: Quality.SKY, format: 'Q0M0.mflac', bitrate: 2400 },     // 杜比
    { quality: Quality.HIRES, format: 'RSM1.mflac', bitrate: 1800 },   // Hi-Res
    { quality: Quality.LOSSLESS, format: 'F0M0.mflac', bitrate: 1000 }, // FLAC
    { quality: Quality.LOSSLESS, format: 'A000.ape', bitrate: 1000 },   // APE
    { quality: Quality.HIGH, format: 'M800.mp3', bitrate: 320 },        // 320K
    { quality: Quality.HIGH, format: 'C600.mp3', bitrate: 320 },        // 320K(备用)
    { quality: Quality.STANDARD, format: 'M500.mp3', bitrate: 128 },    // 128K
    { quality: Quality.STANDARD, format: 'C400.mp3', bitrate: 128 },    // 128K(备用)
    { quality: Quality.LOW, format: 'C200.mp3', bitrate: 48 },          // 48K
  ];

  /**
   * 搜索歌曲
   */
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
    // 当官方API不可用时，尝试第三方代理搜索
    return [];
  }

  private mapSearchResult(item: any): SearchResult {
    // v19.1：各档文件大小（item.file.size_128mp3/size_320mp3/size_flac/size_hires，字节）
    const f = item.file || {};
    const sizes: TierSizes = {};
    if (parseInt(f.size_128mp3 || '0', 10) > 0) sizes['128k'] = parseInt(f.size_128mp3, 10);
    if (parseInt(f.size_320mp3 || '0', 10) > 0) sizes['320k'] = parseInt(f.size_320mp3, 10);
    if (parseInt(f.size_flac || '0', 10) > 0) sizes['lossless'] = parseInt(f.size_flac, 10);
    if (parseInt(f.size_hires || '0', 10) > 0) sizes['hires'] = parseInt(f.size_hires, 10);

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
      sizes: Object.keys(sizes).length > 0 ? sizes : undefined,
    };
  }

  /**
   * v19.1 音质弹窗实时查询：海棠 resolve-url 按 level 取直链（实测无 size 字段），
   * 再对直链 Range 探测真实文件大小；档位按 URL 文件前缀判定（防降级错归组）。
   * 前缀：M500=128K mp3，M800=320K mp3，F000/A000=无损，RS01=Hi-Res。
   * 文档：QQ音乐接口完整文档 §3.4 海棠resolve-url（实测可用）。
   */
  async getQualityOptions(songId: string): Promise<QualityOption[]> {
    const mid = songId.replace(/^qq_/, '');
    if (!mid) return [];
    const levels: Array<{ level: string; fallback: QualityTier }> = [
      { level: 'standard', fallback: '128k' },
      { level: 'exhigh', fallback: '320k' },
      { level: 'lossless', fallback: 'lossless' },
      { level: 'hires', fallback: 'hires' },
    ];

    const settled = await Promise.allSettled(
      levels.map(async ({ level, fallback }) => {
        const resp = await fetch('https://musicserver.haitangw.cc/v1/music/resolve-url', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Referer': 'https://musicserver.haitangw.cc/',
          },
          body: JSON.stringify({ source: 'tx', rid: mid, level }),
        });
        if (!resp.ok) return null;
        const body = await resp.json().catch(() => null);
        const url: string | undefined = body?.data?.url || body?.url;
        if (!url) return null;

        // 档位按直链文件前缀判定（比请求 level 更真实，能识别降级）
        let tier: QualityTier = fallback;
        const m = url.match(/\/([A-Z]?\d{4}|RS01|AIM0|Q0M1|Q0M0)[A-Za-z0-9]*\.(mp3|flac|m4a|ape|ogg|mgg|mflac)/i);
        const prefix = m?.[1]?.toUpperCase() || '';
        if (prefix === 'RS01' || prefix === 'AIM0') tier = 'hires';
        else if (prefix === 'F000' || prefix === 'A000') tier = 'lossless';
        else if (prefix === 'M800') tier = '320k';
        else if (prefix === 'M500') tier = '128k';

        // Range 探测真实大小（best-effort）
        let sizeBytes: number | undefined;
        try {
          const probe = await fetch(url, {
            method: 'GET',
            headers: { Range: 'bytes=0-1', Referer: 'https://y.qq.com' },
            signal: AbortSignal.timeout(8000),
          });
          // 仅接受 206（Range 成功）或 200（整文件）响应；404/403 等错误体不采信
          const valid = probe.status === 206 || probe.status === 200;
          const range = probe.headers.get('content-range') || probe.headers.get('content-length');
          if (valid && range?.startsWith('bytes')) {
            const total = parseInt(range.split('/')[1] || '0', 10) || 0;
            if (total > 65536) sizeBytes = total;
          } else if (valid && range) {
            const total = parseInt(range, 10) || 0;
            if (total > 65536) sizeBytes = total;
          }
          probe.body?.cancel().catch(() => {});
        } catch {
          // 大小探测失败不影响选项本身（无大小块）
        }
        return { sourceId: this.id, sourceName: this.name, tier, format: m?.[2], sizeBytes };
      })
    );

    const seen = new Set<string>();
    const options: QualityOption[] = [];
    for (const r of settled) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      if (seen.has(r.value.tier)) continue;
      seen.add(r.value.tier);
      options.push(r.value);
    }
    return options;
  }

  private inferQuality(item: any): Quality {
    const f = item.file || {};
    if (item.sizehires || item.sizeatmos || f.size_hires) return Quality.HIFI;
    if (item.sizeflac || f.size_flac) return Quality.LOSSLESS;
    if (item.size320 || f.size_320mp3) return Quality.HIGH;
    return Quality.STANDARD;
  }

  /**
   * 获取歌曲详情
   */
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

  /**
   * 获取歌词
   */
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

  /**
   * 按融合固定分类拉取歌单列表
   * QQ 仅实测了推荐歌单（PlaylistSquare.GetRecommendFeed），故仅「热门推荐」可用
   */
  async getPlaylistsByCategory(categoryName: string, page = 0): Promise<PlaylistSummary[]> {
    if (categoryName !== '热门推荐') return [];
    const reqBody = {
      req_1: {
        module: 'music.playlist.PlaylistSquare',
        method: 'GetRecommendFeed',
        param: { From: page * 10, Size: 10 },
      },
    };
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Referer: 'https://y.qq.com' },
        body: JSON.stringify(reqBody),
      });
      if (!response.ok) return [];
      const data = await response.json();
      const list = data?.req_1?.data?.List || [];
      return list
        .map((item: any) => {
          const basic = item?.Playlist?.basic || {};
          return {
            id: String(basic.tid || ''),
            title: basic.title || '未命名歌单',
            coverUrl: basic.cover?.small_url || basic.cover?.medium_url || '',
            playCount: typeof basic.play_count === 'number' ? basic.play_count : undefined,
            creator: basic.creator?.nick || undefined,
          };
        })
        .filter((p: PlaylistSummary) => p.id);
    } catch {
      return [];
    }
  }

  /**
   * 获取歌单详情
   */
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

  /**
   * 解析歌单URL
   */
  async parsePlaylistUrl(url: string) {
    // QQ音乐歌单URL格式：
    // https://y.qq.com/n/ryqq/playlist/1234567890
    // https://i.y.qq.com/n2/m/share/details/taoge.html?platform=11&appshare=android&appversion=11040008&hosteuin=...&id=1234567890
    const match = url.match(/(?:playlist|id)[/=](\d+)/);
    if (!match) {
      throw new YinliuError(ErrorCode.VALIDATION_ERROR, '无法解析QQ音乐歌单URL', 400);
    }
    return this.getPlaylist(match[1]);
  }

  /**
   * 构建取链候选端点
   * 包含：官方Vkey端点 + 5个第三方代理
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
      // GetVkeyServer 明文档取链
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
    const proxyUrls = [
      // 海棠代理
      `https://musicapi.haitangw.net/music/qq.php?id=${songId}`,
      // kgqq1代理
      `https://175.27.166.236/kgqq1/qq.php?id=${songId}`,
      // metingapi代理
      `https://metingapi.nanorocky.top/?server=tencent&type=url&id=${songId}`,
      // vkeys代理
      `https://api.vkeys.cn/?server=tencent&type=url&id=${songId}`,
      // 海棠resolve-url
      `https://musicserver.haitangw.cc/v1/music/resolve-url?source=qq&id=${songId}`,
    ];

    return proxyUrls.map((url): EndpointCandidate => ({
      url,
      method: 'GET',
      timeout: 10000,
      priority: 2,
    }));
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

  /**
   * 获取排行榜列表
   */
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

  /**
   * 获取排行榜详情
   */
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

  /**
   * 健康检查
   */
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
