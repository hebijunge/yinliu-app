import { BaseHttpSource } from './BaseHttpSource';
import { Quality, qualityRank, YinliuError, ErrorCode } from '@core/types';
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
 * 汽水音乐音源 Provider（v21 — track.php 多档加密流方案）
 *
 * 接口依据《汽水音乐接口完整文档_实测整合版》5.x：
 * - 搜索/榜单/歌单：api.qishui.com/luna/*（沿用 v18 实现）
 * - 取链：track.php（唯一取链方式，弃用分享页 _ROUTER_DATA 直链）
 *   · endpoint: GET https://qishui.lxmapi.icu/apis/track.php?track_id={id}
 *   · 响应为 Base64 编码的 AES-128-CBC 密文
 *   · 解密后 JSON：data.audios[]（level, url, decrypt_key, raw_size）+ data.lyrics
 *   · 音频流为 CENC 加密 MP4 容器，需 AES-128-CTR 解密才能播放
 * - 歌词：track.php 响应中的 data.lyrics
 */
export class QishuiSource extends BaseHttpSource {
  readonly id = 'qishui';
  readonly name = '汽水音乐';
  /**
   * track.php 返回 4 档音质：lossless / highest / higher / medium，
   * 最高支持无损，因此注册 maxQuality = LOSSLESS。
   */
  readonly maxQuality = Quality.LOSSLESS;

  private readonly apiBase = 'https://api.qishui.com';
  private readonly apiBackupBase = 'https://api5-lf.qishui.com';
  private readonly trackPhpBase = 'https://qishui.lxmapi.icu/apis/track.php';

  /** PC 客户端公共参数（文档 2.1） */
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

  /** track.php 响应 AES-128-CBC 密钥与 IV（文档 5.x） */
  private readonly trackPhpKey = 'seekmusicv260409';
  private readonly trackPhpIv = '260409seekmusicv';

  /** 官方 4 大榜单（文档 9.2） */
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

  /** track.php 响应缓存：trackId → { data, fetchedAt } */
  private trackCache = new Map<string, { data: any; fetchedAt: number }>();
  private static readonly TRACK_CACHE_TTL = 3 * 60 * 1000; // 3 分钟（URL 短时效）

  /** 并发去重锁：trackId → Promise（避免同一 trackId 并发多次请求 track.php） */
  private static trackPending = new Map<string, Promise<any>>();

  // ==================== 搜索 / 榜单 / 歌单（沿用 v18） ====================

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

  // ==================== 取链：track.php 多档方案 ====================

  protected buildEndpointCandidates(songId: string, quality: Quality) {
    const trackId = this.extractTrackId(songId);
    const trackUrl = `${this.trackPhpBase}?track_id=${trackId}`;
    return [
      {
        url: trackUrl,
        method: 'GET' as const,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: '*/*',
        },
        timeout: 15000,
        priority: 1,
        resolve: async (response: Response): Promise<PlayUrlResult | null> => {
          try {
            const base64 = await response.text();
            const data = await this.fetchTrackPhpWithDedup(trackId, base64);
            if (!data) return null;

            const audios: any[] = data?.data?.audios || [];
            if (!Array.isArray(audios) || audios.length === 0) {
              debugLogger.warn('network', '汽水 track.php 无音频数据', { trackId });
              return null;
            }

            const result = this.pickAudioByQuality(audios, quality);
            if (!result) {
              debugLogger.warn('network', '汽水 track.php 无可匹配音质', { trackId, quality });
              return null;
            }

            return result;
          } catch (err) {
            debugLogger.warn('network', '汽水 track.php 解析失败', {
              trackId,
              err: err instanceof Error ? err.message : String(err),
            });
            return null;
          }
        },
      },
    ];
  }

  /**
   * 音质校验：恢复标准校验逻辑，不再为试听版开特殊通道。
   * track.php 返回的音质由 API 明确标注，accurate=true 信任子类标注。
   */
  protected validateQuality(result: PlayUrlResult, target: Quality): boolean {
    if (!result.url) return false;
    if (qualityRank(result.quality) < qualityRank(target)) return false;
    if (result.accurate === true) return true;
    return this.validateBitrateAndFormat(result.bitrate, result.format, target);
  }

  /**
   * 歌词：优先从 track.php 响应获取；失败则返回 null。
   * （v21 起不再依赖分享页，track.php 已包含歌词字段。）
   */
  async getLyrics(songId: string): Promise<string | null> {
    const trackId = this.extractTrackId(songId);

    // 1. 复用缓存
    const cached = this.trackCache.get(trackId);
    if (cached && Date.now() - cached.fetchedAt < QishuiSource.TRACK_CACHE_TTL) {
      return cached.data?.data?.lyrics ?? null;
    }

    // 2. 请求 track.php
    try {
      const resp = await fetch(`${this.trackPhpBase}?track_id=${trackId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      if (!resp.ok) return null;
      const base64 = await resp.text();
      const data = await this.decryptTrackPhpResponse(base64);
      const parsed = JSON.parse(data);
      this.trackCache.set(trackId, { data: parsed, fetchedAt: Date.now() });
      return parsed?.data?.lyrics ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 音质选项：返回 track.php 提供的全部档位及真实文件大小。
   */
  async getQualityOptions(songId: string): Promise<QualityOption[]> {
    const trackId = this.extractTrackId(songId);

    let data: any;
    const cached = this.trackCache.get(trackId);
    if (cached && Date.now() - cached.fetchedAt < QishuiSource.TRACK_CACHE_TTL) {
      data = cached.data;
    } else {
      try {
        const resp = await fetch(`${this.trackPhpBase}?track_id=${trackId}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        });
        if (!resp.ok) return [];
        const base64 = await resp.text();
        const decrypted = await this.decryptTrackPhpResponse(base64);
        data = JSON.parse(decrypted);
        this.trackCache.set(trackId, { data, fetchedAt: Date.now() });
      } catch {
        return [];
      }
    }

    const audios: any[] = data?.data?.audios || [];
    if (!Array.isArray(audios)) return [];

    const options: QualityOption[] = [];
    for (const audio of audios) {
      const level = String(audio?.level || '');
      const mapping = LEVEL_TO_QUALITY[level];
      if (!mapping) continue;

      options.push({
        sourceId: this.id,
        sourceName: '汽水',
        tier: mapping.tier,
        format: 'mp4',
        sizeBytes: typeof audio?.raw_size === 'number' ? audio.raw_size : 0,
        isPreview: false,
      });
    }

    // 按音质从高到低排序
    const tierOrder = ['lossless', '320k', '192k', '128k'];
    options.sort((a, b) => tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier));

    return options;
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

  // ==================== 内部工具 ====================

  /**
   * 带并发去重的 track.php 请求解析。
   * 若 resolve 已拿到原始 base64 文本，直接解密；否则发起新请求。
   */
  private async fetchTrackPhpWithDedup(trackId: string, base64Text?: string): Promise<any> {
    // 先查缓存
    const cached = this.trackCache.get(trackId);
    if (cached && Date.now() - cached.fetchedAt < QishuiSource.TRACK_CACHE_TTL) {
      return cached.data;
    }

    // 并发去重：同一 trackId 正在请求中，等待结果
    const pending = QishuiSource.trackPending.get(trackId);
    if (pending) {
      return pending;
    }

    const promise = (async () => {
      try {
        let text = base64Text;
        if (!text) {
          const resp = await fetch(`${this.trackPhpBase}?track_id=${trackId}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          });
          if (!resp.ok) throw new Error(`track.php HTTP ${resp.status}`);
          text = await resp.text();
        }
        const decrypted = await this.decryptTrackPhpResponse(text);
        const parsed = JSON.parse(decrypted);
        this.trackCache.set(trackId, { data: parsed, fetchedAt: Date.now() });
        return parsed;
      } finally {
        QishuiSource.trackPending.delete(trackId);
      }
    })();

    QishuiSource.trackPending.set(trackId, promise);
    return promise;
  }

  /**
   * AES-128-CBC 解密 track.php 响应（PKCS7 padding）。
   */
  private async decryptTrackPhpResponse(base64Ciphertext: string): Promise<string> {
    const cipherBytes = Uint8Array.from(atob(base64Ciphertext.trim()), (c) => c.charCodeAt(0));
    const keyBytes = new TextEncoder().encode(this.trackPhpKey);
    const ivBytes = new TextEncoder().encode(this.trackPhpIv);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-CBC', length: 128 },
      false,
      ['decrypt']
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: ivBytes },
      cryptoKey,
      cipherBytes
    );

    // WebCrypto 的 AES-CBC decrypt 已自动校验并剥离 PKCS7 padding，
    // 此处不得再次手工去填充（历史上因双重剥离导致汽水全链路解密失败）。
    return new TextDecoder('utf-8').decode(new Uint8Array(decrypted));
  }

  /**
   * 从 audios[] 中挑选最匹配请求音质的条目。
   * 优先精确匹配，其次返回更高一档，最后返回最高可用档。
   */
  private pickAudioByQuality(audios: any[], targetQuality: Quality): PlayUrlResult | null {
    // 按音质从高到低排序
    const levelOrder = ['lossless', 'highest', 'higher', 'medium'];
    const sorted = [...audios].sort((a, b) => {
      return levelOrder.indexOf(a?.level) - levelOrder.indexOf(b?.level);
    });

    // 建立 level → audio 映射
    const map = new Map<string, any>();
    for (const audio of sorted) {
      const level = String(audio?.level || '');
      if (level && !map.has(level)) map.set(level, audio);
    }

    // 目标 level
    const targetLevel = QUALITY_TO_LEVEL[targetQuality];

    // 1. 精确匹配
    if (targetLevel && map.has(targetLevel)) {
      return this.buildPlayUrlResult(map.get(targetLevel)!, targetQuality, true);
    }

    // 2. 找更高一档
    const targetIdx = levelOrder.indexOf(targetLevel || '');
    if (targetIdx >= 0) {
      for (let i = targetIdx - 1; i >= 0; i--) {
        const level = levelOrder[i];
        if (map.has(level)) {
          const audio = map.get(level)!;
          const mapping = LEVEL_TO_QUALITY[level];
          return this.buildPlayUrlResult(audio, mapping?.quality || Quality.LOSSLESS, false);
        }
      }
    }

    // 3. 返回最高可用档
    for (const level of levelOrder) {
      if (map.has(level)) {
        const audio = map.get(level)!;
        const mapping = LEVEL_TO_QUALITY[level];
        return this.buildPlayUrlResult(audio, mapping?.quality || Quality.LOSSLESS, false);
      }
    }

    return null;
  }

  private buildPlayUrlResult(audio: any, quality: Quality, accurate: boolean): PlayUrlResult {
    const level = String(audio?.level || '');
    const mapping = LEVEL_TO_QUALITY[level];
    const bitrate = mapping?.bitrate || 128;

    return {
      url: audio?.url || '',
      quality,
      bitrate,
      format: 'mp4',
      headers: {
        // CENC 加密 MP4 的 Content-Type 为 video/mp4，需按原样请求
        Accept: 'video/mp4,audio/mp4,*/*',
      },
      accurate,
      isPreview: false,
      isEncrypted: true,
      decryptKey: audio?.decrypt_key || undefined,
    };
  }

  // ==================== 数据映射 ====================

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
      quality: Quality.STANDARD,
      bitrate: 128,
    };
  }

  private buildCoverUrl(urlCover: any): string | null {
    if (!urlCover) return null;
    if (typeof urlCover === 'string') return urlCover;
    const base = urlCover?.urls?.[0];
    const uri = urlCover?.uri;
    if (base && uri) return `${base}${uri}~noop.image`;
    return null;
  }

  private extractTrackId(songId: string): string {
    if (songId.startsWith('qishui_')) return songId.slice('qishui_'.length);
    return songId;
  }
}

/** track.php level → App 音质体系映射 */
interface LevelMapping {
  quality: Quality;
  tier: 'lossless' | '320k' | '192k' | '128k';
  bitrate: number;
}

const LEVEL_TO_QUALITY: Record<string, LevelMapping> = {
  lossless: { quality: Quality.LOSSLESS, tier: 'lossless', bitrate: 1000 },
  highest: { quality: Quality.HIGH, tier: '320k', bitrate: 320 },
  higher: { quality: Quality.HIGHER, tier: '192k', bitrate: 192 },
  medium: { quality: Quality.STANDARD, tier: '128k', bitrate: 128 },
};

const QUALITY_TO_LEVEL: Record<Quality, string> = {
  [Quality.LOSSLESS]: 'lossless',
  [Quality.HIGH]: 'highest',
  [Quality.HIGHER]: 'higher',
  [Quality.STANDARD]: 'medium',
  [Quality.LOW]: 'medium',
  [Quality.HIRES]: 'lossless',
  [Quality.HIFI]: 'lossless',
  [Quality.SKY]: 'lossless',
  [Quality.JYEFFECT]: 'highest',
  // 汽水源无至臻/全景声/母带档，映射到最高可用（lossless）
  [Quality.ZHIZHEN]: 'lossless',
  [Quality.DOLBY]: 'lossless',
  [Quality.MASTER]: 'lossless',
};
