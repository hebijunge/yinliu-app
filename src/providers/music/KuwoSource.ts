import { BaseHttpSource } from './BaseHttpSource';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult, SongDetail, HealthStatus, PlayUrlResult } from '@core/types';
import type { ResolvedCandidate } from './BaseHttpSource';
import { platformFetch } from '@shared/utils/platformFetch';

/**
 * 酷我音乐音源Provider
 * 基于DJMusic Kotlin源码移植 + 接口文档实测
 * 
 * 搜索：kuwo.cn/search/searchMusicBykeyWord（免登录标准JSON，优先）
 *       search.kuwo.cn/r.s（Python dict格式，回退）
 * 取链：nmobi.kuwo.cn/mobi.s（convert_url_with_sign，多域名并发）
 *       + antiserver.kuwo.cn/anti.s（低音质兜底）
 *       + musicapi.haitangw.net（第三方代理）
 * 歌词：kuwo.cn/openapi/v1/www/lyric/getlyric（免Cookie）
 */
export class KuwoSource extends BaseHttpSource {
  readonly id = 'kuwo';
  readonly name = '酷我音乐';
  readonly maxQuality = Quality.HIFI;

  private readonly SEARCH_V2_HOST = 'https://kuwo.cn';
  private readonly SEARCH_HOST = 'http://search.kuwo.cn';
  private readonly NMOBI_HOSTS = [
    'https://nmobi.kuwo.cn',
    'https://mobi.kuwo.cn',
    'https://nmsublist.kuwo.cn',
  ];
  private readonly ANTI_HOST = 'http://antiserver.kuwo.cn';
  private readonly HAITANG_HOST = 'https://musicapi.haitangw.net';
  private readonly COVER_BASE = 'https://img1.kuwo.cn/star/starheads/';
  private readonly NMOBI_UA = 'kwplayerhd_ar_4.3.0.8_tianbao_T1A_qirui';

  // 缓存
  private songMetaCache = new Map<string, { name: string; artist: string }>();

  // ===================== 搜索 =====================

  async search(params: SearchParams): Promise<SearchResult[]> {
    // 优先V2免登录标准JSON，失败回退r.s
    const v2Results = await this.searchV2(params.keyword, params.page || 0);
    if (v2Results.length > 0) return v2Results;

    const rsResults = await this.searchRs(params.keyword, params.page || 0);
    return rsResults;
  }

  /**
   * V2免登录标准JSON搜索（优先）
   * kuwo.cn/search/searchMusicBykeyWord
   */
  private async searchV2(keyword: string, page: number): Promise<SearchResult[]> {
    const q = encodeURIComponent(keyword);
    const pn = page;
    const url = `${this.SEARCH_V2_HOST}/search/searchMusicBykeyWord?all=${q}&pn=${pn}&rn=30&ft=music&client=kt&encoding=utf8&rformat=json&mobi=1&vipver=1&cluster=0&strategy=2012&issubtitle=1&show_copyright_off=1`;

    const data = await this.httpGetJson(url, { Referer: 'https://www.kuwo.cn/' });
    if (!data) return [];

    const abslist = data.abslist || [];
    return abslist.map((o: any) => this.parseSong(o)).filter(Boolean) as SearchResult[];
  }

  /**
   * r.s老版搜索（回退）
   * 响应是Python dict字符串（单引号），需用eval风格解析
   */
  private async searchRs(keyword: string, page: number): Promise<SearchResult[]> {
    const q = encodeURIComponent(keyword);
    const pn = page;
    const url = `${this.SEARCH_HOST}/r.s?all=${q}&ft=music&itemset=web_2013&client=kt&pn=${pn}&rn=30&rformat=json&encoding=utf8`;

    const resp = await this.httpGet(url, { Referer: 'http://m.kuwo.cn/' });
    if (!resp || !resp.ok) return [];

    let text: string;
    try { text = await resp.text(); } catch { return []; }

    let data: any;
    try {
      // 尝试标准JSON解析
      data = JSON.parse(text);
    } catch {
      // Python dict风格解析（单引号转双引号，去掉末尾分号）
      try {
        const normalized = text
          .replace(/'/g, '"')
          .replace(/\bNone\b/g, 'null')
          .replace(/\bTrue\b/g, 'true')
          .replace(/\bFalse\b/g, 'false')
          .replace(/;\s*$/, '');
        data = JSON.parse(normalized);
      } catch {
        return [];
      }
    }

    const abslist = data?.abslist || [];
    return abslist.map((o: any) => this.parseSong(o)).filter(Boolean) as SearchResult[];
  }

  private parseSong(o: any): SearchResult | null {
    const ridStr = (o.MUSICRID || o.musicrid || '').toString();
    if (!ridStr) return null;
    const rid = ridStr.substringAfterLast ? ridStr.substringAfterLast('_') : ridStr.replace(/^MUSIC_/, '');
    if (!rid) return null;

    const name = (o.NAME || o.SONGNAME || o.name || o.songname || '')
      .toString().replace(/&nbsp;/g, ' ').trim();
    if (!name) return null;

    const artist = (o.ARTIST || o.artist || '').toString().replace(/&nbsp;/g, ' ').trim();
    const album = (o.ALBUM || o.album || '').toString().trim();
    const dur = parseInt((o.DURATION || o.duration || '0').toString(), 10) || 0;
    const isPoint = (o.IS_POINT || o.is_point || '').toString() === '1';
    const minfo = (o.N_MINFO || o.MINFO || o.minfo || '').toString();
    const cover = (o.web_artistpic_short || o.web_artistpic || '')
      ? `${this.COVER_BASE}${o.web_artistpic_short || o.web_artistpic}`
      : '';

    // 缓存元数据用于取链
    this.songMetaCache.set(rid, { name, artist });

    return {
      id: `kw_${rid}`,
      type: 'song',
      title: name,
      artist,
      album,
      duration: dur,
      coverUrl: cover,
      sourceId: this.id,
      sourceSongId: rid,
      quality: this.inferQuality(minfo),
      bitrate: this.inferBitrate(minfo),
    };
  }

  private inferQuality(minfo: string): Quality {
    if (!minfo) return Quality.STANDARD;
    if (minfo.includes('flac') || minfo.includes('2000')) return Quality.LOSSLESS;
    if (minfo.includes('320')) return Quality.HIGH;
    if (minfo.includes('128')) return Quality.STANDARD;
    return Quality.STANDARD;
  }

  private inferBitrate(minfo: string): number {
    if (!minfo) return 128;
    const m = minfo.match(/bitrate[:：]\s*(\d+)/);
    if (m) return parseInt(m[1], 10);
    if (minfo.includes('320')) return 320;
    if (minfo.includes('2000')) return 2000;
    return 128;
  }

  // ===================== 歌曲详情 =====================

  async getSongDetail(songId: string): Promise<SongDetail> {
    const rid = songId.replace(/^kw_/, '');
    const cached = this.songMetaCache.get(rid);

    return {
      id: songId,
      title: cached?.name || '未知歌曲',
      artist: cached?.artist || '',
      album: '',
      duration: 0,
      coverUrl: '',
    };
  }

  // ===================== 取链（核心）=====================

  protected buildEndpointCandidates(songId: string, quality: Quality): ResolvedCandidate[] {
    const rid = songId.replace(/^kw_/, '');
    const br = this.brOf(quality);

    const candidates: ResolvedCandidate[] = [];

    // nmobi三域名并发（主链路）
    for (const host of this.NMOBI_HOSTS) {
      candidates.push({
        url: `${host}/mobi.s?f=web&type=convert_url_with_sign&br=${br}&rid=${rid}&user=0&android_id=0&prod=kwplayerhd_ar_4.3.0.8&corp=kuwo&vipver=4.3.0.8&source=kwplayerhd_ar_4.3.0.8_tianbao_T1A_qirui.apk&notrace=0&sig=0&priority=bitrate&loginUid=0&network=WIFI&loginSid=0&mode=down`,
        method: 'GET',
        timeout: 10000,
        priority: 1,
        headers: {
          'User-Agent': this.NMOBI_UA,
          Referer: 'https://www.kuwo.cn/',
        },
        resolve: async (resp) => this.resolveNmobi(resp, quality),
      });
    }

    // antiserver兜底（仅128k mp3）
    candidates.push({
      url: `${this.ANTI_HOST}/anti.s?type=convert_url&rid=MUSIC_${rid}&format=mp3&response=url`,
      method: 'GET',
      timeout: 8000,
      priority: 3,
      headers: { Referer: 'http://m.kuwo.cn/' },
      resolve: async (resp) => {
        const text = await resp.text();
        const url = text.trim();
        if (!url.startsWith('http')) return null;
        return { url, quality, bitrate: 128, format: 'mp3', accurate: this.isBitrateAccurate(quality, 128) };
      },
    });

    // 海棠第三方代理
    const level = this.haitangLevel(quality);
    const expectedBitrate = this.brToBitrate(br);
    candidates.push({
      url: `${this.HAITANG_HOST}/music/kw.php?id=${rid}&level=${level}&type=mp3`,
      method: 'GET',
      timeout: 10000,
      priority: 2,
      resolve: async (resp) => {
        const ct = resp.headers.get('content-type') || '';
        if (!ct.includes('audio') && !ct.includes('octet-stream')) return null;
        const url = `${this.HAITANG_HOST}/music/kw.php?id=${rid}&level=${level}&type=mp3`;
        return { url, quality, bitrate: expectedBitrate, format: 'mp3', accurate: this.isBitrateAccurate(quality, expectedBitrate) };
      },
    });

    return candidates;
  }

  /** nmobi JSON解析 */
  private async resolveNmobi(resp: Response, quality: Quality): Promise<PlayUrlResult | null> {
    let data: any;
    try {
      data = await resp.json();
    } catch { return null; }

    if (data?.code !== 200) return null;
    const d = data.data;
    if (!d?.url) return null;

    const url = d.url as string;
    const bitrate = parseInt((d.bitrate || '0').toString(), 10) || 128;
    const format = (d.format || 'mp3').toString();

    // 防盗链占位校验
    if (this.isAntiTheft(url)) return null;

    const accurate = this.isBitrateAccurate(quality, bitrate);
    return { url, quality, bitrate, format, accurate };
  }

  /** 判断实际码率是否与请求音质匹配（容许 50% 误差） */
  private isBitrateAccurate(requestedQuality: Quality, actualBitrate: number): boolean {
    const expected = this.kuwoQualityToExpectedBitrate(requestedQuality);
    return actualBitrate >= expected * 0.5;
  }

  private kuwoQualityToExpectedBitrate(quality: Quality): number {
    switch (quality) {
      case Quality.LOW: return 48;
      case Quality.STANDARD: return 128;
      case Quality.HIGH: return 320;
      case Quality.LOSSLESS:
      case Quality.HIFI:
      case Quality.HIRES:
        return 2000;
      default: return 128;
    }
  }

  private isAntiTheft(url: string): boolean {
    if (url.endsWith('.mgg')) return true;
    if (url.includes('防盗链') || url.includes('打击')) return true;
    return false;
  }

  private brOf(quality: Quality): string {
    switch (quality) {
      case Quality.LOW: return '48kaac';
      case Quality.STANDARD: return '128kmp3';
      case Quality.HIGH: return '320kmp3';
      case Quality.LOSSLESS:
      case Quality.HIFI:
      case Quality.HIRES:
        return '2000kflac';
      default: return '128kmp3';
    }
  }

  private brToBitrate(br: string): number {
    if (br.includes('2000')) return 2000;
    if (br.includes('320')) return 320;
    if (br.includes('128')) return 128;
    if (br.includes('48')) return 48;
    return 128;
  }

  private haitangLevel(quality: Quality): string {
    switch (quality) {
      case Quality.LOW:
      case Quality.STANDARD: return 'standard';
      case Quality.HIGH: return 'exhigh';
      case Quality.LOSSLESS:
      case Quality.HIFI:
      case Quality.HIRES:
        return 'lossless';
      default: return 'standard';
    }
  }

  // ===================== 歌词 =====================

  async getLyrics(songId: string): Promise<string | null> {
    const rid = songId.replace(/^kw_/, '');

    // 优先免Cookie openapi
    const url = `${this.SEARCH_V2_HOST}/openapi/v1/www/lyric/getlyric?musicId=${rid}&httpsStatus=1&plat=web_www&from=`;
    const data = await this.httpGetJson(url, { Referer: 'https://www.kuwo.cn/' });

    if (data?.code === 200) {
      const lrc = this.buildLrc(data.data?.lrclist);
      if (lrc) return lrc;
    }

    // 回退m.kuwo.cn
    const fallbackUrl = `http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${rid}`;
    const fbData = await this.httpGetJson(fallbackUrl, { Referer: 'http://m.kuwo.cn/' });
    return this.buildLrc(fbData?.data?.lrclist);
  }

  private buildLrc(lrclist: any[] | null): string | null {
    if (!lrclist || lrclist.length === 0) return null;
    const lines: string[] = [];
    for (const line of lrclist) {
      const t = parseFloat(line.time || '0');
      const lrc = (line.lineLyric || '').toString().trim();
      if (!lrc) continue;
      const mm = Math.floor(t / 60);
      const ss = Math.floor(t % 60);
      const ms = Math.floor((t - Math.floor(t)) * 100);
      lines.push(`[${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ms).padStart(2, '0')}]${lrc}`);
    }
    return lines.length > 0 ? lines.join('\n') : null;
  }

  // ===================== 健康检查 =====================

  async healthCheck(): Promise<HealthStatus> {
    try {
      const resp = await platformFetch('https://www.kuwo.cn', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      return { healthy: resp.ok, message: resp.ok ? '酷我音乐服务正常' : '服务异常', latency: 0 };
    } catch {
      return { healthy: false, message: '酷我音乐服务不可用' };
    }
  }
}
