import { BaseHttpSource } from './BaseHttpSource';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult, SongDetail, HealthStatus, PlayUrlResult } from '@core/types';
import type { ResolvedCandidate } from './BaseHttpSource';

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
    // 简化为搜索缓存或占位
    return {
      id: songId,
      title: '网易云歌曲',
      artist: '',
      album: '',
      duration: 0,
      coverUrl: '',
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

    // 海棠第三方代理（POST JSON）
    candidates.push({
      url: 'https://musicserver.haitangw.cc/v1/music/resolve-url',
      method: 'POST',
      timeout: 10000,
      priority: 2,
      headers: {
        'Content-Type': 'application/json',
        Referer: 'https://musicserver.haitangw.cc/',
      },
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
    // 注意：POST body需要在fetch时传入，但这里resolve只处理response。
    // 实际POST body在linkRace的fetch调用中已经发出，但BaseHttpSource的linkRace没有支持POST body。
    // 需要改造linkRace或让NeteaseSource覆写getPlayUrl。

    // gdstudio 第三方（GET）
    candidates.push({
      url: `https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=${id}&br=${br}`,
      method: 'GET',
      timeout: 10000,
      priority: 2,
      resolve: async (resp) => {
        const data = await resp.json().catch(() => null);
        const url = data?.url || data?.data?.url;
        if (!url) return null;
        return { url, quality, bitrate: this.brToBitrate(br), format: this.detectFormat('', url) };
      },
    });

    // qijieya 第三方（GET，302直出）
    candidates.push({
      url: `https://api.qijieya.cn/meting/?type=url&id=${id}&server=netease&br=${br}`,
      method: 'GET',
      timeout: 10000,
      priority: 3,
      resolve: async (resp) => {
        // 302 redirect，最终URL在响应中
        const url = resp.url;
        if (!url || !url.startsWith('http')) return null;
        return { url, quality, bitrate: this.brToBitrate(br), format: this.detectFormat('', url) };
      },
    });

    return candidates;
  }

  // 覆写getPlayUrl，因为海棠需要POST body
  async getPlayUrl(songId: string, quality: Quality): Promise<PlayUrlResult> {
    const id = songId.replace(/^ne_/, '');
    const level = this.neteaseLevel(quality);
    const br = this.neteaseBr(quality);

    const controller = new AbortController();
    const candidates: Promise<PlayUrlResult | null>[] = [];

    // 官方v1
    candidates.push(this.fetchOfficialV1(id, level, quality, controller.signal));
    // 官方br
    candidates.push(this.fetchOfficialBr(id, br, quality, controller.signal));
    // 海棠POST
    candidates.push(this.fetchHaitang(id, level, quality, controller.signal));
    // gdstudio
    candidates.push(this.fetchGdstudio(id, br, quality, controller.signal));
    // qijieya
    candidates.push(this.fetchQijieya(id, br, quality, controller.signal));

    const results = await Promise.allSettled(candidates);
    const matched = results
      .filter((r): r is PromiseFulfilledResult<PlayUrlResult | null> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((r): r is PlayUrlResult => r !== null);

    if (matched.length > 0) {
      controller.abort(); // 取消其他
      return matched[0];
    }

    throw new Error(`网易云取链失败：所有候选均不可用 (id=${id})`);
  }

  private async fetchOfficialV1(id: string, level: string, quality: Quality, signal: AbortSignal): Promise<PlayUrlResult | null> {
    try {
      const resp = await fetch(`${this.HOST}/api/song/enhance/player/url/v1?ids=[${id}]&level=${level}&encodeType=flac`, {
        headers: { Cookie: this.VIP_COOKIE, Referer: this.REF },
        signal,
      });
      return this.resolveOfficialV1(resp, quality);
    } catch { return null; }
  }

  private async fetchOfficialBr(id: string, br: number, quality: Quality, signal: AbortSignal): Promise<PlayUrlResult | null> {
    try {
      const resp = await fetch(`${this.HOST}/api/song/enhance/player/url?ids=[${id}]&br=${br}`, {
        headers: { Cookie: this.VIP_COOKIE, Referer: this.REF },
        signal,
      });
      return this.resolveOfficialBr(resp, quality);
    } catch { return null; }
  }

  private async fetchHaitang(id: string, level: string, quality: Quality, signal: AbortSignal): Promise<PlayUrlResult | null> {
    try {
      const resp = await fetch('https://musicserver.haitangw.cc/v1/music/resolve-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://musicserver.haitangw.cc/',
        },
        body: JSON.stringify({ source: 'wy', rid: id, level }),
        signal,
      });
      const data = await resp.json().catch(() => null);
      if (!data?.url) return null;
      return {
        url: data.url,
        quality,
        bitrate: this.levelToBitrate(level),
        format: this.detectFormat('', data.url),
      };
    } catch { return null; }
  }

  private async fetchGdstudio(id: string, br: number, quality: Quality, signal: AbortSignal): Promise<PlayUrlResult | null> {
    try {
      const resp = await fetch(`https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=${id}&br=${br}`, {
        signal,
      });
      const data = await resp.json().catch(() => null);
      const url = data?.url || data?.data?.url;
      if (!url) return null;
      return { url, quality, bitrate: this.brToBitrate(br), format: this.detectFormat('', url) };
    } catch { return null; }
  }

  private async fetchQijieya(id: string, br: number, quality: Quality, signal: AbortSignal): Promise<PlayUrlResult | null> {
    try {
      const resp = await fetch(`https://api.qijieya.cn/meting/?type=url&id=${id}&server=netease&br=${br}`, {
        signal,
        redirect: 'follow',
      });
      const url = resp.url;
      if (!url || !url.startsWith('http')) return null;
      return { url, quality, bitrate: this.brToBitrate(br), format: this.detectFormat('', url) };
    } catch { return null; }
  }

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
    return { url, quality, bitrate: actualBr, format: type };
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
    return { url, quality, bitrate: actualBr, format: type };
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
      const resp = await fetch(this.HOST, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      return { healthy: resp.ok, message: resp.ok ? '网易云音乐服务正常' : '服务异常', latency: 0 };
    } catch {
      return { healthy: false, message: '网易云音乐服务不可用' };
    }
  }
}
