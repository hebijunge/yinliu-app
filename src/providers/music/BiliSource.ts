import { BaseHttpSource } from './BaseHttpSource';
import { Quality, YinliuError, ErrorCode, qualityToTier } from '@core/types';
import type {
  SearchParams,
  SearchResult,
  SongDetail,
  HealthStatus,
  PlayUrlResult,
  QualityOption,
} from '@core/types';
import type { ResolvedCandidate } from './BaseHttpSource';
import { getWbiKeys, signWbi } from './BiliWbiSigner';

/**
 * 哔哩哔哩（B站）音频音源 Provider
 * 基于视频 DASH 音频流提取
 *
 * 搜索：WBI 签名版视频搜索 (/x/web-interface/wbi/search/type)
 * 取链：旧版 playurl（免登录，bvid+cid）+ 第三方 GDAPI 并发竞速
 * 音质：30280/30232/30216 AAC（免登录），30251/30250 需大会员
 */
export class BiliSource extends BaseHttpSource {
  readonly id = 'bilibili';
  readonly name = '哔哩哔哩';
  readonly maxQuality = Quality.HIRES;

  private readonly API_HOST = 'https://api.bilibili.com';
  private readonly REF = 'https://www.bilibili.com/';

  private readonly AUDIO_ID_TO_QUALITY: Record<number, Quality> = {
    30251: Quality.HIRES,
    30250: Quality.HIRES,
    30280: Quality.HIGH,
    30232: Quality.STANDARD,
    30216: Quality.LOW,
  };

  private readonly QUALITY_TO_AUDIO_ID: Record<Quality, number> = {
    [Quality.MASTER]: 30251,
    [Quality.DOLBY]: 30251,
    [Quality.ZHIZHEN]: 30251,
    [Quality.HIRES]: 30251,
    [Quality.HIFI]: 30251,
    [Quality.JYEFFECT]: 30251,
    [Quality.SKY]: 30251,
    [Quality.LOSSLESS]: 30280,
    [Quality.HIGH]: 30280,
    [Quality.HIGHER]: 30232,
    [Quality.STANDARD]: 30232,
    [Quality.LOW]: 30216,
  };

  async search(params: SearchParams): Promise<SearchResult[]> {
    const keyword = params.keyword.trim();
    if (!keyword) return [];

    try {
      const { imgKey, subKey } = await getWbiKeys();
      const signed = signWbi(
        {
          search_type: 'video',
          keyword,
          page: (params.page || 0) + 1,
          page_size: 20,
        },
        imgKey,
        subKey
      );

      const qs = new URLSearchParams(
        Object.entries(signed).map(([k, v]) => [k, String(v)])
      ).toString();
      const url = `${this.API_HOST}/x/web-interface/wbi/search/type?${qs}`;
      const data = await this.httpGetJson(url, { Referer: this.REF });

      const results: SearchResult[] = [];
      const list = data?.data?.result || [];
      for (const item of list) {
        const parsed = this.parseVideo(item);
        if (parsed) results.push(parsed);
      }
      return results;
    } catch (e) {
      console.error('[BiliSource] search error:', e);
      return [];
    }
  }

  private parseVideo(o: any): SearchResult | null {
    const bvid = o.bvid;
    if (!bvid) return null;

    const title = this.stripHtml(o.title || '');
    if (!title) return null;

    const author = o.author || '';
    const durationStr = o.duration || '';
    const durationSec = this.parseDuration(durationStr);
    const pic = o.pic || '';

    return {
      id: `bl_${bvid}`,
      type: 'song',
      title,
      artist: author,
      album: '',
      duration: durationSec,
      coverUrl: pic.startsWith('http') ? pic : `https:${pic}`,
      sourceId: this.id,
      sourceSongId: bvid,
      quality: Quality.HIGH,
      bitrate: 169,
    };
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]+>/g, '');
  }

  private parseDuration(dur: string): number {
    if (!dur) return 0;
    const parts = dur.split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }

  async getSongDetail(songId: string): Promise<SongDetail> {
    const bvid = this.extractBvid(songId);
    const url = `${this.API_HOST}/x/web-interface/view?bvid=${bvid}`;
    const data = await this.httpGetJson(url, { Referer: this.REF });

    if (data?.code !== 0 || !data?.data) {
      throw new YinliuError(ErrorCode.SONG_NOT_FOUND, `B站视频详情获取失败: ${bvid}`);
    }

    const d = data.data;
    const title = this.stripHtml(d.title || '');
    const owner = d.owner?.name || '';
    const pic = d.pic || '';
    const durationSec = d.duration || 0;

    return {
      id: `bl_${bvid}`,
      title,
      artist: owner,
      album: '',
      duration: typeof durationSec === 'number' ? durationSec : this.parseDuration(String(durationSec)),
      coverUrl: pic.startsWith('http') ? pic : `https:${pic}`,
    };
  }

  async getPlayUrl(songId: string, quality: Quality, signal?: AbortSignal): Promise<PlayUrlResult> {
    const bvid = this.extractBvid(songId);
    const info = await this.getVideoInfo(bvid);
    const cid = info?.cid;
    if (!cid) {
      throw new YinliuError(ErrorCode.SONG_NOT_FOUND, `无法获取 B站视频 CID: ${bvid}`);
    }

    const candidates = this.buildEndpointCandidatesWithCid(songId, quality, cid);
    if (candidates.length === 0) {
      throw new YinliuError(ErrorCode.LINK_RACE_FAILED, `No endpoints for ${this.id}`, 503);
    }

    return this.linkRace(candidates, quality, songId, signal);
  }

  protected buildEndpointCandidates(songId: string, quality: Quality): ResolvedCandidate[] {
    return this.buildEndpointCandidatesWithCid(songId, quality, 0);
  }

  private buildEndpointCandidatesWithCid(
    songId: string,
    quality: Quality,
    cid: number
  ): ResolvedCandidate[] {
    const bvid = this.extractBvid(songId);
    const candidates: ResolvedCandidate[] = [];

    if (cid > 0) {
      candidates.push({
        url: `${this.API_HOST}/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=16&fnval=16`,
        method: 'GET',
        timeout: 10000,
        priority: 1,
        headers: { Referer: this.REF },
        resolve: async (resp) => this.resolvePlayurl(resp, quality),
      });
    }

    candidates.push({
      url: `https://music-api.gdstudio.xyz/api.php?types=url&source=bilibili&id=${bvid}&br=320`,
      method: 'GET',
      timeout: 5000,
      priority: 2,
      key: 'gdstudio',
      resolve: async (resp) => {
        const data = await resp.json().catch(() => null);
        const url = data?.url || data?.data?.url;
        if (!url) return null;
        return {
          url,
          quality,
          bitrate: this.qualityToBitrate(quality),
          format: this.guessFormat(url),
        };
      },
    });

    return candidates;
  }

  private async resolvePlayurl(resp: Response, targetQuality: Quality): Promise<PlayUrlResult | null> {
    const data = await resp.json().catch(() => null);
    if (data?.code !== 0) return null;

    const audioList = data?.data?.dash?.audio || [];
    if (!audioList.length) return null;

    const sorted = [...audioList].sort(
      (a: any, b: any) => (b.bandwidth || 0) - (a.bandwidth || 0)
    );

    const targetId = this.QUALITY_TO_AUDIO_ID[targetQuality] || 30280;

    let match = sorted.find((a: any) => a.id === targetId);

    if (!match) {
      const fallbackOrder = [30251, 30250, 30280, 30232, 30216];
      for (const id of fallbackOrder) {
        match = sorted.find((a: any) => a.id === id);
        if (match) break;
      }
    }

    if (!match?.baseUrl) return null;

    const actualQuality = this.AUDIO_ID_TO_QUALITY[match.id] || Quality.HIGH;
    const bitrate = Math.round((match.bandwidth || 0) / 1000);

    return {
      url: match.baseUrl,
      quality: actualQuality,
      bitrate,
      format: this.guessFormat(match.baseUrl),
      accurate: actualQuality === targetQuality,
    };
  }

  async getQualityOptions(songId: string): Promise<QualityOption[]> {
    const bvid = this.extractBvid(songId);
    const info = await this.getVideoInfo(bvid);
    const cid = info?.cid;
    if (!cid) return [];

    try {
      const url = `${this.API_HOST}/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=16&fnval=16`;
      const data = await this.httpGetJson(url, { Referer: this.REF });
      const audioList = data?.data?.dash?.audio || [];
      if (!audioList.length) return [];

      const sorted = [...audioList].sort(
        (a: any, b: any) => (b.bandwidth || 0) - (a.bandwidth || 0)
      );

      return sorted.map((a: any) => {
        const q = this.AUDIO_ID_TO_QUALITY[a.id] || Quality.HIGH;
        const tier = qualityToTier(q);
        return {
          sourceId: this.id,
          sourceName: this.name,
          tier: tier || '128k',
          format: this.guessFormat(a.baseUrl || ''),
        };
      });
    } catch {
      return [];
    }
  }

  private extractBvid(songId: string): string {
    return songId.replace(/^bl_/, '');
  }

  private async getVideoInfo(bvid: string): Promise<{ cid: number; duration: number } | null> {
    try {
      const url = `${this.API_HOST}/x/web-interface/view?bvid=${bvid}`;
      const data = await this.httpGetJson(url, { Referer: this.REF });
      if (data?.code !== 0 || !data?.data) return null;
      return {
        cid: data.data.cid,
        duration: data.data.duration,
      };
    } catch {
      return null;
    }
  }

  private qualityToBitrate(quality: Quality): number {
    switch (quality) {
      case Quality.HIRES:
      case Quality.HIFI:
      case Quality.SKY:
      case Quality.JYEFFECT:
        return 999;
      case Quality.LOSSLESS:
        return 320;
      case Quality.HIGH:
        return 169;
      case Quality.HIGHER:
        return 85;
      case Quality.STANDARD:
        return 85;
      case Quality.LOW:
        return 38;
      default:
        return 128;
    }
  }

  private guessFormat(url: string): string {
    if (url.includes('.m4a')) return 'm4a';
    if (url.includes('.mp4')) return 'mp4';
    if (url.includes('.flac')) return 'flac';
    return 'm4a';
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const url = `${this.API_HOST}/x/web-interface/view?bvid=BV1d4411N7zD`;
      const data = await this.httpGetJson(url, { Referer: this.REF });
      if (data?.code === 0) {
        return { healthy: true, latency: 0, message: 'B站接口正常' };
      }
      return { healthy: false, latency: 0, message: `B站接口异常: code=${data?.code}` };
    } catch (e) {
      return { healthy: false, latency: 0, message: `B站接口请求失败: ${e}` };
    }
  }

  async getLyrics(songId: string): Promise<string | null> {
    return null;
  }
}
