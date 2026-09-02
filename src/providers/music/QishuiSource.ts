import { BaseHttpSource } from './BaseHttpSource';
import { Quality } from '@core/types';
import type {
  SearchParams,
  SearchResult,
  PlayUrlResult,
  SongDetail,
  PlaylistDetail,
  Chart,
  ChartDetail,
  HealthStatus,
  QualityOption,
  TierSizes,
  PlaylistSummary,
} from '@core/types';
import { debugLogger } from '@shared/utils/debugLogger';

/**
 * 汽水音乐音源Provider（v18 新增）
 *
 * 接口依据《汽水音乐接口完整文档_实测整合版》：
 * - 搜索：GET api.qishui.com/luna/search/track（免登录，PC客户端公共参数）
 * - 榜单：GET api.qishui.com/luna/pc/charts/{chart_id}（4大官方榜单）
 * - 歌单：GET api.qishui.com/luna/playlist/detail（歌单详情）
 *   分类歌单：discover/mix 需登录态，实测免登录返回 EMPTY_RESULT，故不提供分类歌单（见下方说明）
 * - 取链：分享页 _ROUTER_DATA 明文直链（music.douyin.com/qishui/share/track）
 * - 歌词：分享页逐字歌词 sentences[] → LRC
 */
export class QishuiSource extends BaseHttpSource {
  readonly id = 'qishui';
  readonly name = '汽水音乐';
  /** 分享页直链音质档位不明确（文档5.6），按最高 320K 档注册 */
  readonly maxQuality = Quality.HIGH;

  private readonly apiBase = 'https://api.qishui.com';
  private readonly apiBackupBase = 'https://api5-lf.qishui.com';
  private readonly shareBase = 'https://music.douyin.com/qishui/share/track';

  /** PC客户端公共参数（文档 2.1） */
  private readonly commParams: Record<string, string> = {
    aid: '386088',
    app_name: 'luna_pc',
    device_id: '2170852561392692',
    version_name: '1.7.0',
    version_code: '10070000',
    ac: 'wifi',
    tz_name: 'Asia/Shanghai',
    device_platform: 'windows',
    device_type: 'Windows',
    os_version: 'Windows',
  };

  private readonly apiHeaders: Record<string, string> = {
    'User-Agent': 'LunaPC/3.0.0(290101097)',
    Referer: 'https://api.qishui.com/',
    Accept: 'application/json',
  };

  /** 官方4大榜单（文档 9.2） */
  private static readonly CHARTS: { id: string; name: string; description: string; cover: string }[] = [
    {
      id: '7036274230471712007',
      name: '热歌榜',
      description: '汽水音乐内每周热度最高的50首歌',
      cover: 'https://p3-luna.douyinpic.com/img/tos-cn-i-b829550vbb/d0d8d48461a62748e84689cdf049b19a.png~tplv-b829550vbb-resize:960:960.png',
    },
    {
      id: '7060812597884869927',
      name: '新歌榜',
      description: '近期发行的热度最高的50首新歌',
      cover: 'https://p3-luna.douyinpic.com/img/tos-cn-i-b829550vbb/f12f7eb5b54d0899c7c724df009668a8.png~tplv-b829550vbb-resize:960:960.png',
    },
    {
      id: '7061475546400005410',
      name: '欧美榜',
      description: '每周热度最高的50首外文歌曲',
      cover: 'https://p3-luna.douyinpic.com/img/tos-cn-i-b829550vbb/33747550ed5499b58feda42a21748637.png~tplv-b829550vbb-resize:960:960.png',
    },
    {
      id: '7415959718721494311',
      name: '音乐人歌曲榜',
      description: '抖音音乐人开放平台上传歌曲，综合站内热度',
      cover: 'https://p3-luna.douyinpic.com/img/tos-cn-v-2774c002/o8FQKiQQBxHWa2hzsBNAgYOX6iEHEAibADAbfB~tplv-b829550vbb-resize:960:960.png',
    },
  ];

  /** 分享页数据缓存：trackId → { url, lrc, fetchedAt }（URL 短时效，10分钟过期） */
  private shareCache = new Map<string, { url: string; lrc: string | null; fetchedAt: number }>();
  private static readonly SHARE_CACHE_TTL = 5 * 60 * 1000; // 直链时效约3分钟，缓存5分钟

  /**
   * 搜索歌曲（文档 3.1）
   */
  async search(params: SearchParams): Promise<SearchResult[]> {
    const page = params.page || 0;
    const pageSize = params.pageSize || 30;
    const count = Math.min(pageSize, 20);
    const cursor = page * count;

    const qs = new URLSearchParams({
      ...this.commParams,
      q: params.keyword,
      count: String(count),
      cursor: String(cursor),
      search_method: 'history',
    });

    const data = await this.httpGetJson(`${this.apiBase}/luna/search/track?${qs.toString()}`, this.apiHeaders);
    if (!data) return [];

    const group = (data?.result_groups || []).find((g: any) => g?.id === 'tracks') || data?.result_groups?.[0];
    const items = group?.data || [];

    return items
      .map((item: any) => item?.entity?.track)
      .filter(Boolean)
      .map((track: any) => this.mapTrack(track));
  }

  /**
   * 汽水歌单分类说明（v19.1）：
   * 汽水的分类-歌单接口为 POST /luna/pc/discover/mix（sub_channel_id 标签），
   * 实测免登录态返回 ERR_DISCOVER_PLAYLIST_MIX_EMPTY_RESULT（文档 8.5 亦标注"可能需要登录态"），
   * 因此不提供按分类取歌单能力，也不再用歌单搜索结果冒充分类数据。
   * 若未来拿到登录态，可在此实现 getPlaylistsByCategory。
   */


  /**
   * 官方4大榜单（文档 9）
   */
  async getCharts(): Promise<Chart[]> {
    return QishuiSource.CHARTS.map((c) => ({ id: c.id, name: c.name, description: c.description }));
  }

  async getChartDetail(chartId: string): Promise<ChartDetail> {
    const meta = QishuiSource.CHARTS.find((c) => c.id === chartId);
    const songs = await this.fetchChartTracks(chartId);
    return {
      id: chartId,
      name: meta?.name || '汽水榜单',
      description: meta?.description,
      songs,
    };
  }

  private async fetchChartTracks(chartId: string): Promise<SearchResult[]> {
    // 主域名 + 备用域名（文档 9.1）
    const urls = [
      `${this.apiBase}/luna/pc/charts/${chartId}?${new URLSearchParams(this.commParams).toString()}`,
      `${this.apiBackupBase}/luna/charts/${chartId}?charge=0&${new URLSearchParams(this.commParams).toString()}`,
    ];

    for (const url of urls) {
      const data = await this.httpGetJson(url, this.apiHeaders);
      const ranks = data?.chart?.track_ranks || data?.track_ranks || [];
      if (ranks.length > 0) {
        return ranks
          .map((r: any) => r?.track)
          .filter(Boolean)
          .map((track: any) => this.mapTrack(track));
      }
    }
    return [];
  }

  /**
   * 歌单详情（文档 3.5；注意 track 多一层 track_wrapper）
   */
  async getPlaylist(playlistId: string): Promise<PlaylistDetail> {
    const qs = new URLSearchParams({
      ...this.commParams,
      playlist_id: playlistId,
      count: '30',
      cursor: '0',
    });
    const data = await this.httpGetJson(`${this.apiBase}/luna/playlist/detail?${qs.toString()}`, this.apiHeaders);

    const tracks: any[] = [];
    const resources = data?.media_resources || [];
    for (const res of resources) {
      const t = res?.entity?.track_wrapper?.track || res?.entity?.track;
      if (t) tracks.push(t);
    }

    return {
      id: playlistId,
      name: data?.playlist?.title || '汽水歌单',
      description: data?.playlist?.desc || '',
      coverUrl: this.buildCoverUrl(data?.playlist?.url_cover) || '',
      songs: tracks.map((t) => this.mapTrack(t)),
      total: data?.playlist?.count_tracks || tracks.length,
    };
  }

  /**
   * 歌曲详情：官方无 track/detail 接口（文档 3.6），用 SEO/H5 接口（文档 10）
   */
  async getSongDetail(songId: string): Promise<SongDetail> {
    const trackId = this.extractTrackId(songId);

    try {
      const data = await this.httpGetJson(
        `https://beta-luna.douyin.com/luna/h5/seo_track?track_id=${trackId}&device_platform=web`,
        { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      );
      const track = data?.seo_track?.track;
      if (track) {
        return {
          id: songId,
          title: track.name || '未知歌曲',
          artist: (track.artists || []).map((a: any) => a?.name).filter(Boolean).join('/') || '未知歌手',
          album: track.album?.name || '',
          duration: track.duration ? Math.round(track.duration / 1000) : 0,
          coverUrl: this.buildCoverUrl(track.album?.url_cover) || '',
        };
      }
    } catch {
      // ignore, 回退
    }

    return { id: songId, title: '未知歌曲', artist: '', album: '', duration: 0 };
  }

  /**
   * 取链：分享页 _ROUTER_DATA 明文直链（文档 5）
   */
  protected buildEndpointCandidates(songId: string, _quality: Quality) {
    const trackId = this.extractTrackId(songId);
    const shareUrl = `${this.shareBase}?track_id=${trackId}`;
    return [
      {
        url: shareUrl,
        method: 'GET' as const,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: 10000,
        priority: 1,
        resolve: async (response: Response): Promise<PlayUrlResult | null> => {
          try {
            const html = await response.text();
            const parsed = this.parseSharePage(html);
            if (!parsed?.url) return null;

            // 缓存分享页数据（歌词复用）
            this.shareCache.set(trackId, {
              url: parsed.url,
              lrc: parsed.lrc,
              fetchedAt: Date.now(),
            });

            return {
              url: parsed.url,
              quality: Quality.HIGH,
              bitrate: 320,
              format: 'aac',
              headers: {},
              accurate: false, // 音质档位不明确（文档5.6）
            };
          } catch (err) {
            debugLogger.warn('network', '汽水分享页解析失败', { err: String(err) });
            return null;
          }
        },
      },
    ];
  }

  /**
   * 分享页直链音质档位不明确，跳过基类码率校验，只要有 URL 即可。
   * 汽水在播放优先级表中排最后，不会抢其他源的高音质请求。
   */
  protected validateQuality(result: PlayUrlResult, _target: Quality): boolean {
    return !!result.url;
  }

  /**
   * 歌词：优先复用分享页缓存；否则单独请求分享页
   */
  async getLyrics(songId: string): Promise<string | null> {
    const trackId = this.extractTrackId(songId);

    const cached = this.shareCache.get(trackId);
    if (cached && Date.now() - cached.fetchedAt < QishuiSource.SHARE_CACHE_TTL) {
      return cached.lrc;
    }

    try {
      const shareUrl = `${this.shareBase}?track_id=${trackId}`;
      const resp = await fetch(shareUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          Accept: 'text/html',
        },
      });
      if (!resp.ok) return null;
      const html = await resp.text();
      const parsed = this.parseSharePage(html);
      if (parsed?.url) {
        this.shareCache.set(trackId, { url: parsed.url, lrc: parsed.lrc, fetchedAt: Date.now() });
      }
      return parsed?.lrc ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 音质选项：分享页直链仅一档（音质不明确，按 320K 档归组），大小通过 Range 探测
   */
  async getQualityOptions(songId: string): Promise<QualityOption[]> {
    const trackId = this.extractTrackId(songId);
    const option: QualityOption = {
      sourceId: this.id,
      sourceName: '汽水',
      tier: '320k',
      format: 'aac',
      isPreview: false,
    };

    // best-effort 探测文件大小
    try {
      const cached = this.shareCache.get(trackId);
      let url = cached?.url;
      if (!url || Date.now() - cached!.fetchedAt >= QishuiSource.SHARE_CACHE_TTL) {
        const lrc = await this.getLyrics(songId);
        url = this.shareCache.get(trackId)?.url;
        if (lrc === null && !url) return [option];
      }
      if (url) {
        const resp = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-1' } });
        const range = resp.headers.get('content-range'); // bytes 0-1/12345678
        if (range) {
          const total = parseInt(range.split('/')[1] || '0', 10);
          if (total > 0) option.sizeBytes = total;
        }
      }
    } catch {
      // 大小探测失败不影响选项本身
    }

    return [option];
  }

  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const qs = new URLSearchParams({
        ...this.commParams,
        q: '音乐',
        count: '1',
        cursor: '0',
      });
      const resp = await fetch(`${this.apiBase}/luna/search/track?${qs.toString()}`, {
        headers: this.apiHeaders,
      });
      const latency = Date.now() - start;
      if (resp.ok) {
        return { healthy: true, message: '汽水音乐连接正常', latency };
      }
      return { healthy: false, message: `汽水音乐响应异常 (${resp.status})`, latency };
    } catch (err) {
      return { healthy: false, message: `汽水音乐连接失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ===== 内部工具 =====

  /**
   * 解析分享页 HTML → { url, lrc }（文档 5.2 / 5.5）
   */
  private parseSharePage(html: string): { url: string; lrc: string | null } | null {
    const m = html.match(/_ROUTER_DATA\s*=\s*({[\s\S]*?});\s*<\/script>/) || html.match(/_ROUTER_DATA\s*=\s*({[\s\S]*?});/);
    if (!m) return null;

    let data: any;
    try {
      data = JSON.parse(m[1]);
    } catch {
      return null;
    }

    const audio = data?.loaderData?.track_page?.audioWithLyricsOption || {};
    const url: string = audio?.url || '';

    // 逐字歌词 → LRC
    let lrc: string | null = null;
    const sentences = audio?.lyrics?.sentences;
    if (Array.isArray(sentences) && sentences.length > 0) {
      const lines: string[] = [];
      for (const s of sentences) {
        const startMs = s?.startMs || 0;
        const words = (s?.words || []).map((w: any) => w?.text || '').join('');
        if (!words) continue;
        const mm = Math.floor(startMs / 60000);
        const ss = Math.floor((startMs % 60000) / 1000);
        const cs = startMs % 1000;
        lines.push(`[${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(3, '0')}]${words}`);
      }
      if (lines.length > 0) lrc = lines.join('\n');
    }

    return url ? { url, lrc } : null;
  }

  /**
   * 搜索/榜单 track 结构 → SearchResult
   */
  private mapTrack(track: any): SearchResult {
    const trackId = String(track?.id || '');
    const durationMs = track?.duration || 0;

    return {
      id: `qishui_${trackId}`,
      type: 'song',
      title: track?.name || '未知歌曲',
      artist: (track?.artists || []).map((a: any) => a?.name).filter(Boolean).join('/') || '未知歌手',
      album: track?.album?.name || '',
      duration: durationMs ? Math.round(durationMs / 1000) : 0,
      coverUrl: this.buildCoverUrl(track?.url_cover || track?.album?.url_cover) || '',
      sourceId: this.id,
      sourceSongId: trackId,
      quality: Quality.HIGH,
      bitrate: 320,
    };
  }

  /**
   * 封面 URL 构造：base + uri + ~noop.image（文档 第8节示例）
   */
  private buildCoverUrl(urlCover: any): string | null {
    if (!urlCover) return null;
    if (typeof urlCover === 'string') return urlCover;
    const base = urlCover?.urls?.[0];
    const uri = urlCover?.uri;
    if (base && uri) return `${base}${uri}~noop.image`;
    return null;
  }

  /** qishui_{trackId} → trackId；兼容裸 trackId */
  private extractTrackId(songId: string): string {
    if (songId.startsWith('qishui_')) return songId.slice('qishui_'.length);
    return songId;
  }
}
