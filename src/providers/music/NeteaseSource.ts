import { BaseHttpSource } from './BaseHttpSource';
import { Quality, YinliuError, ErrorCode } from '@core/types';
import type { SearchParams, SearchResult, SearchType, SongDetail, HealthStatus, PlayUrlResult, TierSizes, PlaylistSummary, QualityOption, MvQuality, MvUrlResult } from '@core/types';
import type { ResolvedCandidate } from './BaseHttpSource';
import { platformFetch } from '@shared/utils/platformFetch';
import { sizeCache } from './sizeCache';

/**
 * 网易云音乐音源Provider
 * 基于DJMusic Kotlin源码移植 + 接口文档实测
 * 
 * 搜索：music.163.com/api/search/get（明文GET，免登录）
 * 取链：官方api/song/enhance/player/url + 第三方代理并发竞速
 * 歌词：music.163.com/api/song/lyric（明文GET）
 */
export class NeteaseSource extends BaseHttpSource {
  readonly id = 'netease';
  readonly name = '网易云音乐';
  readonly maxQuality = Quality.HIRES;
  readonly supportedSearchTypes: SearchType[] = ["song", "artist", "album", "mv"];

  private readonly HOST = 'https://music.163.com';
  private readonly REF = 'https://music.163.com/';
  /**
   * B4: VIP Cookie 从构建时环境变量注入，不再硬编码在源码中。
   * 环境变量名：VITE_NETEASE_VIP_COOKIE
   * 未配置时自动降级（不使用 VIP 试听，仅用公开接口）
   */
  private readonly VIP_COOKIE = (import.meta as any).env?.VITE_NETEASE_VIP_COOKIE || '';

  // 第三方代理列表
  private readonly THIRD_PARTIES = [
    { name: 'haitang', url: 'https://musicserver.haitangw.cc/v1/music/resolve-url' },
    { name: 'gdstudio', url: 'https://music-api.gdstudio.xyz/api.php' },
    { name: 'qijieya', url: 'https://api.qijieya.cn/meting' },
    { name: 'sedet', url: 'https://music.sedet.top/api.php' },
  ];

  /**
   * accurate 竞速优先级判定：accurate !== false 视为可优先选用的结果。
   * 网易云官方源按码率精确匹配标记 accurate；试听片段或降级链标记 accurate: false。
   */
  protected isAccurateResult(result: PlayUrlResult): boolean {
    return result.accurate !== false;
  }

  // ===================== 搜索 =====================

  async search(params: SearchParams): Promise<SearchResult[]> {
    const searchType = params.type || 'song';
    const q = encodeURIComponent(params.keyword);
    const offset = (params.page || 0) * 30;

    // 网易云搜索类型映射: 1=歌曲, 10=专辑, 100=歌手, 1004=MV
    const neteaseTypeMap: Record<string, number> = {
      song: 1,
      album: 10,
      artist: 100,
      mv: 1004,
    };
    const typeNum = neteaseTypeMap[searchType];
    if (!typeNum) return []; // 不支持的类型直接跳过

    const url = `${this.HOST}/api/search/get?s=${q}&type=${typeNum}&limit=30&offset=${offset}`;
    const data = await this.httpGetJson(url);
    if (!data) return [];

    const result = data.result;
    if (!result) return [];

    switch (searchType) {
      case 'song':
        return (result.songs || []).map((o: any) => this.parseSong(o)).filter(Boolean) as SearchResult[];
      case 'artist':
        return (result.artists || []).map((o: any) => this.parseArtist(o)).filter(Boolean) as SearchResult[];
      case 'album':
        return (result.albums || []).map((o: any) => this.parseAlbum(o)).filter(Boolean) as SearchResult[];
      case 'mv':
        return (result.mvs || []).map((o: any) => this.parseMv(o)).filter(Boolean) as SearchResult[];
      default:
        return [];
    }
  }

  private parseSong(o: any): SearchResult | null {
    const id = parseInt((o.id || '0').toString(), 10);
    if (!id) return null;

    const name = (o.name || '').toString().trim();
    if (!name) return null;

    const artists = o.artists || o.ar || [];
    const artist = artists.map((a: any) => (a.name || '').toString()).filter(Boolean).join(' / ');

    const album = o.album || o.al || {};
    const albumName = (album.name || '').toString();
    const pic = (album.picUrl || album.pic || '').toString();

    const durMs = parseInt((o.duration || o.dt || '0').toString(), 10);
    const durSec = durMs > 0 ? Math.floor(durMs / 1000) : 0;

    // 音质推断：从hMusic/mMusic/lMusic（搜索）或 h/m/l（榜单详情）取码率与文件大小
    let quality = Quality.STANDARD;
    let bitrate = 128;
    const sizes: TierSizes = {};
    const musicPairs: [string, keyof TierSizes][] = [
      ['hrMusic', 'hires'], ['hr', 'hires'],
      ['sqMusic', 'lossless'], ['sq', 'lossless'],
      ['hMusic', '320k'], ['h', '320k'],
      ['mMusic', '128k'], ['m', '128k'],
    ];
    // v19.1：档位按实际码率归组（m 档实测 192kbps，此前一律归 128k 不准确）
    for (const [key] of musicPairs) {
      const m = o[key];
      const sz = parseInt((m?.size || '0').toString(), 10) || 0;
      if (sz <= 0) continue;
      const br = parseInt((m?.br || m?.bitrate || '0').toString(), 10) || 0;
      const tier = this.brToTier(br);
      if (tier && !sizes[tier]) sizes[tier] = sz;
    }
    if (o.hrMusic?.bitrate || o.hr?.br) { quality = Quality.HIRES; bitrate = parseInt((o.hrMusic?.bitrate || o.hr?.br) as any, 10); }
    else if (o.sqMusic?.bitrate || o.sq?.br) { quality = Quality.LOSSLESS; bitrate = parseInt((o.sqMusic?.bitrate || o.sq?.br) as any, 10); }
    else if (o.hMusic?.bitrate || o.h?.br) { quality = Quality.HIGH; bitrate = parseInt((o.hMusic?.bitrate || o.h?.br) as any, 10); }
    else if (o.mMusic?.bitrate || o.m?.br) { quality = Quality.STANDARD; bitrate = parseInt((o.mMusic?.bitrate || o.m?.br) as any, 10); }
    else if (o.lMusic?.bitrate || o.l?.br) { quality = Quality.LOW; bitrate = parseInt((o.lMusic?.bitrate || o.l?.br) as any, 10); }

    return {
      id: `ne_${id}`,
      type: 'song',
      title: name,
      artist,
      album: albumName,
      duration: durSec,
      coverUrl: pic,
      sourceId: this.id,
      sourceSongId: id.toString(),
      quality,
      bitrate,
      sizes: Object.keys(sizes).length > 0 ? sizes : undefined,
    };
  }

  /** v19.1 码率(kbps) → 音质档位（网易云 br 字段为 128000/192000/320000/999000/2000000） */
  private brToTier(br: number): 'hires' | 'lossless' | '320k' | '192k' | '128k' | null {
    if (!br || br <= 0) return null;
    if (br >= 1000000) return 'hires';
    if (br >= 900000) return 'lossless';
    if (br >= 320000) return '320k';
    if (br >= 192000) return '192k';
    return '128k';
  }

  /**
   * v19.1 音质弹窗实时查询：/api/v3/song/detail 返回 hr/sq/h/m/l 各档 br+size。
   * 文档：网易云音乐接口完整文档 §3 歌曲详情（明文 api，免登录）。
   */
  async getQualityOptions(songId: string): Promise<QualityOption[]> {
    const id = songId.replace(/^ne_/, '');
    if (!id || !/^\d+$/.test(id)) return [];
    try {
      const url = `${this.HOST}/api/v3/song/detail?c=${encodeURIComponent(`[{"id":${id}}]`)}`;
      const data = await this.httpGetJson(url, { Referer: this.REF });
      const song = data?.songs?.[0];
      if (!song) return [];
      const sizes: TierSizes = {};
      for (const m of [song.hr, song.sq, song.h, song.m, song.l]) {
        const sz = parseInt((m?.size || '0').toString(), 10) || 0;
        if (sz <= 0) continue;
        const br = parseInt((m?.br || '0').toString(), 10) || 0;
        const tier = this.brToTier(br);
        if (tier && !sizes[tier]) sizes[tier] = sz;
      }
      return Object.entries(sizes).map(([tier, sizeBytes]) => ({
        sourceId: this.id,
        sourceName: this.name,
        tier: tier as any,
        sizeBytes,
      }));
    } catch {
      return [];
    }
  }

  // ===================== 歌曲详情 =====================

  private parseArtist(o: any): SearchResult | null {
    const id = parseInt((o.id || '0').toString(), 10);
    if (!id) return null;
    const name = (o.name || '').toString().trim();
    if (!name) return null;
    return {
      id: `ne_artist_${id}`,
      type: 'artist',
      title: name,
      subtitle: (o.trans || '').toString(),
      artist: name,
      coverUrl: (o.picUrl || o.img1v1Url || '').toString(),
      sourceId: this.id,
      sourceSongId: id.toString(),
    };
  }

  private parseAlbum(o: any): SearchResult | null {
    const id = parseInt((o.id || '0').toString(), 10);
    if (!id) return null;
    const name = (o.name || '').toString().trim();
    if (!name) return null;
    const artist = (o.artist?.name || '').toString();
    return {
      id: `ne_album_${id}`,
      type: 'album',
      title: name,
      artist,
      subtitle: artist,
      coverUrl: (o.picUrl || '').toString(),
      sourceId: this.id,
      sourceSongId: id.toString(),
    };
  }

  private parseMv(o: any): SearchResult | null {
    const id = parseInt((o.id || '0').toString(), 10);
    if (!id) return null;
    const name = (o.name || '').toString().trim();
    if (!name) return null;
    const artistName = (o.artistName || '').toString();
    const durMs = parseInt((o.duration || '0').toString(), 10);
    return {
      id: `ne_mv_${id}`,
      type: 'mv',
      title: name,
      artist: artistName,
      subtitle: artistName,
      duration: durMs > 0 ? Math.floor(durMs / 1000) : 0,
      coverUrl: (o.cover || o.picUrl || '').toString(),
      sourceId: this.id,
      sourceSongId: id.toString(),
      mvUrl: `https://music.163.com/mv?id=${id}`,
    };
  }

  // ===================== MV 取链（v19.2）=====================

  /**
   * 获取 MV 播放地址
   * 接口: GET /api/song/enhance/play/mv/url?id={mvid}&r={quality}
   * 支持画质: 240/480/720/1080，服务端自动降级
   */
  async getMvUrl(mvId: string, quality: MvQuality): Promise<MvUrlResult | null> {
    const id = mvId.replace(/^ne_mv_/, '');
    const r = this.mvQualityToR(quality);
    const url = `${this.HOST}/api/song/enhance/play/mv/url?id=${id}&r=${r}`;
    try {
      const data = await this.httpGetJson(url);
      if (!data?.data?.url) return null;
      const actualR = data.data.r || r;
      return {
        url: data.data.url,
        quality: this.rToMvQuality(actualR),
        size: data.data.size,
      };
    } catch {
      return null;
    }
  }

  /**
   * 获取 MV 可用画质列表
   * 策略：请求 1080p，根据服务端返回的实际 r 推断最高画质，
   * 再向下探测每个档位确认可用性。
   */
  async getMvQualities(mvId: string): Promise<MvQuality[]> {
    const id = mvId.replace(/^ne_mv_/, '');
    const allQualities: MvQuality[] = ['240p', '480p', '720p', '1080p'];

    const maxResult = await this.getMvUrl(id, '1080p');
    if (!maxResult) return [];

    const maxRank = mvQualityRank(maxResult.quality);
    const available: MvQuality[] = [];

    for (const q of allQualities) {
      if (mvQualityRank(q) <= maxRank) {
        const result = await this.getMvUrl(id, q);
        if (result && result.url) {
          available.push(q);
        }
      }
    }

    return available;
  }

  private mvQualityToR(q: MvQuality): number {
    switch (q) {
      case '240p': return 240;
      case '480p': return 480;
      case '720p': return 720;
      case '1080p': return 1080;
      case '4k': return 1080; // 网易云暂无 4K
      default: return 480;
    }
  }

  private rToMvQuality(r: number): MvQuality {
    if (r >= 1080) return '1080p';
    if (r >= 720) return '720p';
    if (r >= 480) return '480p';
    return '240p';
  }

  async getSongDetail(songId: string): Promise<SongDetail> {
    const id = songId.replace(/^ne_/, '');
    const url = `${this.HOST}/api/song/detail?ids=[${id}]`;
    const data = await this.httpGetJson(url);
    if (!data?.songs || data.songs.length === 0) {
      throw new YinliuError(ErrorCode.SONG_NOT_FOUND, `网易云歌曲详情获取失败: ${id}`);
    }
    const s = data.songs[0];
    return {
      id: songId,
      title: s.name || '',
      artist: (s.ar || []).map((a: any) => a.name).filter(Boolean).join(' / '),
      album: s.al?.name || '',
      duration: s.dt ? Math.floor(s.dt / 1000) : 0,
      coverUrl: s.al?.picUrl || '',
    };
  }

  /**
   * v20.1-fix: 覆写期望大小获取。
   * 调用网易云歌曲详情接口，从 hMusic/mMusic/lMusic/sqMusic/hrMusic 中提取各音质文件大小。
   */
  protected async getExpectedSize(songId: string, quality: Quality): Promise<number | null> {
    // 1. 检查共享缓存
    const cached = sizeCache.get(this.id, songId, quality);
    if (cached) return cached.size;

    // 2. 调用详情接口获取各音质大小
    const id = songId.replace(/^ne_/, '');
    try {
      const url = `${this.HOST}/api/song/detail?ids=[${id}]`;
      const data = await this.httpGetJson(url);
      const s = data?.songs?.[0];
      if (!s) return null;

      const sizeMap: Partial<Record<Quality, number>> = {};
      if (s.hrMusic?.size && s.hrMusic.size > 0) {
        sizeMap[Quality.HIRES] = parseInt(s.hrMusic.size, 10);
        sizeMap[Quality.HIFI] = parseInt(s.hrMusic.size, 10); // 网易云 HIFI 与 HIRES 共用同一文件
      }
      if (s.sqMusic?.size && s.sqMusic.size > 0) {
        sizeMap[Quality.LOSSLESS] = parseInt(s.sqMusic.size, 10);
      }
      if (s.hMusic?.size && s.hMusic.size > 0) {
        sizeMap[Quality.HIGH] = parseInt(s.hMusic.size, 10);
        sizeMap[Quality.HIGHER] = parseInt(s.hMusic.size, 10);
      }
      if (s.mMusic?.size && s.mMusic.size > 0) {
        sizeMap[Quality.STANDARD] = parseInt(s.mMusic.size, 10);
      }
      if (s.lMusic?.size && s.lMusic.size > 0) {
        sizeMap[Quality.LOW] = parseInt(s.lMusic.size, 10);
      }

      // 缓存所有已知大小
      for (const [q, sz] of Object.entries(sizeMap)) {
        if (sz && sz > 0) {
          sizeCache.set(this.id, songId, q, { size: sz });
        }
      }

      return sizeMap[quality] ?? null;
    } catch {
      return null;
    }
  }

  // ===================== 取链（核心）=====================

  protected buildEndpointCandidates(songId: string, quality: Quality): ResolvedCandidate[] {
    const id = songId.replace(/^ne_/, '');
    const br = this.neteaseBr(quality);
    const level = this.neteaseLevel(quality);
    const candidates: ResolvedCandidate[] = [];

    // 官方取链 v1（level参数形式）
    candidates.push({
      url: `${this.HOST}/api/song/enhance/player/url/v1?ids=[${id}]&level=${level}&encodeType=flac`,
      method: 'GET',
      timeout: 8000,
      priority: 1,
      headers: { Cookie: this.VIP_COOKIE, Referer: this.REF },
      resolve: async (resp) => this.resolveOfficialV1(resp, quality),
    });

    // 官方取链（br参数形式）
    candidates.push({
      url: `${this.HOST}/api/song/enhance/player/url?ids=[${id}]&br=${br}`,
      method: 'GET',
      timeout: 8000,
      priority: 1,
      headers: { Cookie: this.VIP_COOKIE, Referer: this.REF },
      resolve: async (resp) => this.resolveOfficialBr(resp, quality),
    });

    // 海棠第三方代理（POST JSON，超时 3 秒）
    candidates.push({
      url: 'https://musicserver.haitangw.cc/v1/music/resolve-url',
      method: 'POST',
      timeout: 3000,
      priority: 2,
      key: 'haitang',
      headers: {
        'Content-Type': 'application/json',
        Referer: 'https://musicserver.haitangw.cc/',
      },
      body: JSON.stringify({ source: 'wy', rid: id, level: this.neteaseLevel(quality) }),
      resolve: async (resp) => {
        const data = await resp.json().catch(() => null);
        if (!data?.url) return null;
        return {
          url: data.url,
          quality,
          bitrate: this.brToBitrate(br),
          format: this.detectFormat('', data.url),
        };
      },
    });

    // gdstudio 第三方（GET，超时 3 秒）
    candidates.push({
      url: `https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=${id}&br=${br}`,
      method: 'GET',
      timeout: 3000,
      priority: 2,
      key: 'gdstudio',
      resolve: async (resp) => {
        const data = await resp.json().catch(() => null);
        const url = data?.url || data?.data?.url;
        if (!url) return null;
        return { url, quality, bitrate: this.brToBitrate(br), format: this.detectFormat('', url) };
      },
    });

    // qijieya 第三方（GET，302直出，超时 3 秒）
    candidates.push({
      url: `https://api.qijieya.cn/meting/?type=url&id=${id}&server=netease&br=${br}`,
      method: 'GET',
      timeout: 3000,
      priority: 3,
      key: 'qijieya',
      resolve: async (resp) => {
        // 302 redirect，最终URL在响应中
        const url = resp.url;
        if (!url || !url.startsWith('http')) return null;
        return { url, quality, bitrate: this.brToBitrate(br), format: this.detectFormat('', url) };
      },
    });

    return candidates;
  }

  // getPlayUrl 使用 BaseHttpSource 的优化版 linkRace（并行竞速 + 成功通道记忆 + 去重锁）

  private async resolveOfficialV1(resp: Response, quality: Quality): Promise<PlayUrlResult | null> {
    const data = await resp.json().catch(() => null);
    if (!data) return null;
    const arr = data.data;
    if (!arr || arr.length === 0) return null;
    const o = arr[0];
    const url = o?.url;
    if (!url || !url.startsWith('http')) return null;
    const actualBr = o.br || 0;
    const type = o.type || 'mp3';
    const isPreview = !!o.freeTrialInfo;
    const accurate = !isPreview && this.isAccurateNetease(quality, actualBr, type);
    return { url, quality, bitrate: actualBr, format: type, isPreview, accurate };
  }

  private async resolveOfficialBr(resp: Response, quality: Quality): Promise<PlayUrlResult | null> {
    const data = await resp.json().catch(() => null);
    if (!data) return null;
    const arr = data.data;
    if (!arr || arr.length === 0) return null;
    const o = arr[0];
    const url = o?.url;
    if (!url || !url.startsWith('http')) return null;
    const actualBr = o.br || 0;
    const type = o.type || 'mp3';
    const isPreview = !!o.freeTrialInfo;
    const accurate = !isPreview && this.isAccurateNetease(quality, actualBr, type);
    return { url, quality, bitrate: actualBr, format: type, isPreview, accurate };
  }

  /**
   * 官方取链结果是否与请求音质精确匹配（用于竞速优先选 accurate）。
   * 参照 DJMusic NeteaseSource.kt isAccurateNetease。
   */
  private isAccurateNetease(quality: Quality, br: number, type: string): boolean {
    switch (quality) {
      case Quality.LOSSLESS: return type.toLowerCase() === 'flac' && br >= 900000;
      case Quality.HIFI: return br >= 900000;
      case Quality.HIRES: return br >= 1800000;
      case Quality.HIGH: return br >= 300000 && br <= 330000;
      case Quality.HIGHER: return br >= 180000 && br <= 210000;
      case Quality.LOW:
      case Quality.STANDARD: return br >= 120000 && br <= 135000;
      default: return true;
    }
  }

  private neteaseBr(quality: Quality): number {
    switch (quality) {
      case Quality.LOW: return 128000;
      case Quality.STANDARD: return 128000;
      case Quality.HIGH: return 320000;
      case Quality.LOSSLESS: return 999000;
      case Quality.HIFI:
      case Quality.HIRES: return 999000;
      default: return 128000;
    }
  }

  private neteaseLevel(quality: Quality): string {
    switch (quality) {
      case Quality.LOW: return 'standard';
      case Quality.STANDARD: return 'standard';
      case Quality.HIGH: return 'exhigh';
      case Quality.LOSSLESS: return 'lossless';
      case Quality.HIFI:
      case Quality.HIRES: return 'hires';
      default: return 'standard';
    }
  }

  private brToBitrate(br: number): number {
    return Math.round(br / 1000);
  }

  private levelToBitrate(level: string): number {
    switch (level) {
      case 'standard': return 128;
      case 'exhigh': return 320;
      case 'lossless': return 1000;
      case 'hires': return 2000;
      default: return 128;
    }
  }

  // ===================== 榜单（v18） =====================

  /**
   * 榜单列表：/api/toplist（63个榜单，免登录）
   */
  async getCharts() {
    const data = await this.httpGetJson(`${this.HOST}/api/toplist`, { Referer: this.REF });
    if (!data?.list) return [];
    return (data.list || []).map((o: any) => ({
      id: String(o.id),
      name: o.name || '',
      description: o.updateFrequency || o.description || '',
    }));
  }

  /**
   * 榜单详情：/api/toplist/detail?id=（一次返回榜单信息）
   * tracks 为 h/m/l {br,size} 结构，parseSong 已兼容并提取文件大小
   * v19.1：完整性校验——若 trackCount 大于返回条数（接口截断），用 v6 歌单详情（n=1000）补全
   */
  async getChartDetail(chartId: string) {
    const data = await this.httpGetJson(`${this.HOST}/api/toplist/detail?id=${chartId}`, { Referer: this.REF });
    const pl = data?.playlist;
    let tracks = pl?.tracks || [];

    // v19.1 完整性兜底：接口截断（trackCount > 返回条数）或响应形状异常（缺 playlist，
    // 部分网络环境该端点会退化为榜单列表）时，用 v6 歌单详情（n=1000）补全/替换
    const trackCount = Number(pl?.trackCount || 0);
    if (!pl || trackCount > tracks.length) {
      try {
        const full = await this.httpGetJson(
          `${this.HOST}/api/v6/playlist/detail?id=${chartId}&n=1000&s=0`,
          { Referer: this.REF }
        );
        const fullTracks = full?.playlist?.tracks || [];
        if (fullTracks.length > tracks.length) tracks = fullTracks;
      } catch {
        // 补全失败时保留 toplist 结果
      }
    }

    return {
      id: String(chartId),
      name: pl?.name || '网易榜单',
      description: pl?.description || '',
      songs: tracks.map((o: any) => this.parseSong(o)).filter(Boolean) as SearchResult[],
    };
  }

  // ===================== 歌单 =====================

  /**
   * 按融合固定分类拉取歌单列表（v19.1）：
   * /api/playlist/list 即网易云官方歌单广场接口（cat=分类名）。
   * 热门推荐不带 cat 参数（order=hot 即官方热门歌单）；
   * 融合「日韩」在网易云对应「日语」分类。
   */
  async getPlaylistsByCategory(categoryName: string, page = 0): Promise<PlaylistSummary[]> {
    const offset = page * 30;
    const catParam =
      categoryName === '热门推荐' ? '' : `cat=${encodeURIComponent(categoryName === '日韩' ? '日语' : categoryName)}&`;
    const url = `${this.HOST}/api/playlist/list?${catParam}order=hot&limit=30&offset=${offset}`;
    const data = await this.httpGetJson(url, { Referer: this.REF });
    const list = data?.playlists || [];
    return list.map((o: any) => ({
      id: String(o.id),
      title: o.name || '未命名歌单',
      coverUrl: o.coverImgUrl || '',
      playCount: typeof o.playCount === 'number' ? o.playCount : undefined,
      trackCount: typeof o.trackCount === 'number' ? o.trackCount : undefined,
      creator: o.creator?.nickname || undefined,
    }));
  }

  /**
   * 获取网易云歌单详情
   * 公开接口：/api/v6/playlist/detail（免登录可访问公开歌单）
   * 隐私歌单需要登录态，本实现不处理
   */
  async getPlaylist(playlistId: string) {
    const id = String(playlistId).replace(/[^\d]/g, '');
    if (!id) {
      throw new YinliuError(ErrorCode.VALIDATION_ERROR, '无效的网易云歌单ID', 400);
    }
    // v6 接口返回结构更稳定；包含 playlist + privileges
    const url = `${this.HOST}/api/v6/playlist/detail?id=${id}&n=1000&s=0`;
    const data = await this.httpGetJson(url, { Referer: this.REF });
    if (!data?.playlist) {
      throw new YinliuError(ErrorCode.SOURCE_ERROR, `网易云歌单不存在或无权限: ${id}`, 404);
    }
    const pl = data.playlist;
    const tracks = pl.tracks || [];
    return {
      id,
      name: pl.name || '网易云歌单',
      description: pl.description || '',
      coverUrl: pl.coverImgUrl || '',
      songs: tracks.map((o: any) => this.parseSong(o)).filter(Boolean) as SearchResult[],
      total: tracks.length,
    };
  }

  /**
   * 解析歌单URL
   * 网易云歌单URL格式：
   *   https://music.163.com/playlist?id=12345
   *   https://music.163.com/#/playlist?id=12345
   *   https://music.163.com/playlist/12345
   *   https://163cn.tv/XXXXX (短链，目前不做解析兜底)
   */
  async parsePlaylistUrl(url: string) {
    const match = url.match(/(?:music\.163\.com|163\.cn)[/#]?(?:playlist)?[/?#&]id=(\d+)/)
      || url.match(/music\.163\.com\/playlist\/(\d+)/);
    if (!match || !match[1]) {
      throw new YinliuError(ErrorCode.VALIDATION_ERROR, '无法解析网易云歌单URL', 400);
    }
    return this.getPlaylist(match[1]);
  }

  // ===================== 歌词 =====================

  async getLyrics(songId: string): Promise<string | null> {
    const id = songId.replace(/^ne_/, '');
    const url = `${this.HOST}/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`;
    const data = await this.httpGetJson(url);
    if (!data) return null;

    // 优先原词，无则译词
    const lrc = data.lrc?.lyric || data.tlyric?.lyric || data.klyric?.lyric;
    return lrc || null;
  }

  // ===================== 健康检查 =====================

  async healthCheck(): Promise<HealthStatus> {
    try {
      const resp = await platformFetch(this.HOST, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      return { healthy: resp.ok, message: resp.ok ? '网易云音乐服务正常' : '服务异常', latency: 0 };
    } catch {
      return { healthy: false, message: '网易云音乐服务不可用' };
    }
  }
}

function mvQualityRank(q: MvQuality): number {
  const map: Record<MvQuality, number> = { '240p': 1, '480p': 2, '720p': 3, '1080p': 4, '4k': 5 };
  return map[q] || 0;
}
