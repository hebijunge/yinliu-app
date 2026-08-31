import { BaseHttpSource } from './BaseHttpSource';
import { Quality, YinliuError, ErrorCode } from '@core/types';
import type { SearchParams, SearchResult, SongDetail, HealthStatus, PlayUrlResult } from '@core/types';
import type { ResolvedCandidate } from './BaseHttpSource';
import { platformFetch } from '@shared/utils/platformFetch';

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

  private readonly HOST = 'https://music.163.com';
  private readonly REF = 'https://music.163.com/';
  /** 内置VIP Cookie（非登录态共享账号），用于VIP歌试听片段取链 */
  private readonly VIP_COOKIE = 'MUSIC_U=5d5843ce6bfe31ce7e8657ca39441fbe99f997601ba68c44d62e3734d5f5ccec519e07624a9f005374ebfa3006384e39dcfdf1652d53fd3f9dd917fbc052e791cf92cf76d152e608d4dbf082a8813684';

  // 第三方代理列表
  private readonly THIRD_PARTIES = [
    { name: 'haitang', url: 'https://musicserver.haitangw.cc/v1/music/resolve-url' },
    { name: 'gdstudio', url: 'https://music-api.gdstudio.xyz/api.php' },
    { name: 'qijieya', url: 'https://api.qijieya.cn/meting' },
    { name: 'sedet', url: 'https://music.sedet.top/api.php' },
  ];

  // ===================== 搜索 =====================

  async search(params: SearchParams): Promise<SearchResult[]> {
    const q = encodeURIComponent(params.keyword);
    const offset = (params.page || 0) * 30;
    const url = `${this.HOST}/api/search/get?s=${q}&type=1&limit=30&offset=${offset}`;

    const data = await this.httpGetJson(url);
    if (!data) return [];

    const result = data.result;
    if (!result) return [];

    const songs = result.songs || [];
    return songs.map((o: any) => this.parseSong(o)).filter(Boolean) as SearchResult[];
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

    // 音质推断：从hMusic/mMusic/lMusic
    let quality = Quality.STANDARD;
    let bitrate = 128;
    if (o.hMusic?.bitrate) { quality = Quality.HIGH; bitrate = parseInt(o.hMusic.bitrate, 10); }
    else if (o.mMusic?.bitrate) { quality = Quality.STANDARD; bitrate = parseInt(o.mMusic.bitrate, 10); }
    else if (o.lMusic?.bitrate) { quality = Quality.LOW; bitrate = parseInt(o.lMusic.bitrate, 10); }
    if (o.sqMusic?.bitrate) { quality = Quality.LOSSLESS; bitrate = parseInt(o.sqMusic.bitrate, 10); }
    if (o.hrMusic?.bitrate) { quality = Quality.HIRES; bitrate = parseInt(o.hrMusic.bitrate, 10); }

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
    };
  }

  // ===================== 歌曲详情 =====================

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

  // ===================== 歌单 =====================

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
