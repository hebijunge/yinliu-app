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
    const page = this.extractPage(songId);
    const url = `${this.API_HOST}/x/web-interface/view?bvid=${bvid}`;
    const data = await this.httpGetJson(url, { Referer: this.REF });

    if (data?.code !== 0 || !data?.data) {
      throw new YinliuError(ErrorCode.SONG_NOT_FOUND, `B站视频详情获取失败: ${bvid}`);
    }

    const d = data.data;
    // v22 B8: 多分 P 视频返回对应分 P 的标题与时长
    let title = this.stripHtml(d.title || '');
    let durationSec: number | string = d.duration || 0;
    if (page > 1) {
      const target = (d.pages || [])[page - 1];
      if (target) {
        title = `${title} · P${page} ${this.stripHtml(target.part || '')}`;
        durationSec = target.duration || durationSec;
      }
    }
    const owner = d.owner?.name || '';
    const pic = d.pic || '';

    return {
      id: `bl_${bvid}${page > 1 ? `_p${page}` : ''}`,
      title,
      artist: owner,
      album: '',
      duration: typeof durationSec === 'number' ? durationSec : this.parseDuration(String(durationSec)),
      coverUrl: pic.startsWith('http') ? pic : `https:${pic}`,
    };
  }

  // v22 B8: prepareContext 产出的 cid（songId → cid），buildEndpointCandidates 消费后删除
  private cidContext = new Map<string, number>();

  /**
   * v22 B8: 不再覆写 getPlayUrl——cid 解析移入 prepareContext 钩子，
   * 保留基类 PlayUrlCache 缓存 + pendingLocks 去重 + 成功通道记忆。
   */
  protected async prepareContext(songId: string, _quality: Quality): Promise<void> {
    const bvid = this.extractBvid(songId);
    const page = this.extractPage(songId);
    const info = await this.getVideoInfo(bvid, page);
    const cid = info?.cid;
    if (!cid) {
      throw new YinliuError(ErrorCode.SONG_NOT_FOUND, `无法获取 B站视频 CID: ${bvid} P${page}`);
    }
    this.cidContext.set(songId, cid);
  }

  protected buildEndpointCandidates(songId: string, quality: Quality): ResolvedCandidate[] {
    // 消费 prepareContext 产出的 cid（正常链路必然已就绪；getFileSize 直连路径 cid=0 → 无候选 → 返回 null）
    const cid = this.cidContext.get(songId) || 0;
    this.cidContext.delete(songId);
    return this.buildEndpointCandidatesWithCid(songId, quality, cid);
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
          actualQuality: quality, // 第三方代理，无法校验真实档位
          bitrate: this.qualityToBitrate(quality),
          format: this.guessFormat(url),
          accurate: false,
        };
      },
    });

    return candidates;
  }

  private async resolvePlayurl(resp: Response, targetQuality: Quality): Promise<PlayUrlResult | null> {
    // v22 B8: 免登录 playurl 不保证可用（-101 需登录、-404 下架、风控限流等），
    // 一律返回 null 交给竞速链路的下一候选（GDAPI）兜底，不假设接口恒成功。
    const data = await resp.json().catch(() => null);
    if (data?.code !== 0) return null;

    const audioList = data?.data?.dash?.audio || [];
    if (!audioList.length) {
      // 仅 durl（旧版音视频混合流）不可作纯音源（会造成音画双播），同样放弃走兜底
      return null;
    }

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
      quality: targetQuality,
      actualQuality,
      bitrate,
      format: this.guessFormat(match.baseUrl),
      accurate: actualQuality === targetQuality,
    };
  }

  async getQualityOptions(songId: string): Promise<QualityOption[]> {
    const bvid = this.extractBvid(songId);
    const page = this.extractPage(songId);
    const info = await this.getVideoInfo(bvid, page);
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

  /** v22 B8: 分 P 解析——songId 形如 bl_BVxx（P1）或 bl_BVxx_p3（第 3P） */
  private extractPage(songId: string): number {
    const m = songId.match(/_p(\d+)$/);
    if (!m) return 1;
    const p = parseInt(m[1], 10);
    return Number.isFinite(p) && p >= 1 ? p : 1;
  }

  private extractBvid(songId: string): string {
    // 剥 bl_ 前缀与 _pN 分 P 后缀
    return songId.replace(/^bl_/, '').replace(/_p\d+$/, '');
  }

  /** v22 B8: page > 1 时从 pages 数组取对应分 P 的 cid 与时长（此前恒取 P1，多分 P 只能播第一集） */
  private async getVideoInfo(bvid: string, page = 1): Promise<{ cid: number; duration: number; title?: string; pages?: number } | null> {
    try {
      const url = `${this.API_HOST}/x/web-interface/view?bvid=${bvid}`;
      const data = await this.httpGetJson(url, { Referer: this.REF });
      if (data?.code !== 0 || !data?.data) return null;
      const d = data.data;
      if (page > 1) {
        const pages: any[] = d.pages || [];
        const target = pages[page - 1];
        if (!target?.cid) return null;
        return { cid: target.cid, duration: target.duration || 0, title: target.part, pages: pages.length };
      }
      return { cid: d.cid, duration: d.duration, pages: (d.pages || []).length || 1 };
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
