import { BaseHttpSource } from './BaseHttpSource';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult, SongDetail, HealthStatus, TierSizes, PlaylistSummary, QualityOption, QualityTier } from '@core/types';
import { YinliuError, ErrorCode } from '@core/types';
import { debugLogger } from '@shared/utils/debugLogger';

/**
 * 咪咕音乐音源Provider
 * 接口：app.c.nf.migu.cn / pd.musicapp.migu.cn（JSON API）
 * 特色：URL派生法（PQ→HQ/SQ/ZQ24替换目录+扩展名），免登录全音质
 * 并发：官方listen接口 + URL派生 + 第三方代理
 */
export class MiguSource extends BaseHttpSource {
  readonly id = 'migu';
  readonly name = '咪咕音乐';
  readonly maxQuality = Quality.HIRES;
  private readonly apiBase = 'https://app.c.nf.migu.cn';
  private readonly bmwBase = 'https://pd.musicapp.migu.cn/MIGU/3.0.0/v2.0/content';

  /**
   * 搜索歌曲
   */
  async search(params: SearchParams): Promise<SearchResult[]> {
    const page = params.page || 0;
    const pageSize = params.pageSize || 30;

    const searchUrl = `${this.bmwBase}/search_all.do?&text=${encodeURIComponent(params.keyword)}&pageNo=${page + 1}&pageSize=${pageSize}&searchSwitch={"song":1,"album":0,"singer":0,"tagSong":0,"mvSong":0,"songlist":0,"bestShow":1}`;

    try {
      const response = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        return this.fallbackSearch(params);
      }

      const data = await response.json();
      const songResult = data?.songResultData?.result || [];

      return songResult.map((item: any) => this.mapSearchResult(item));
    } catch {
      return this.fallbackSearch(params);
    }
  }

  private fallbackSearch(params: SearchParams): SearchResult[] {
    return [];
  }

  private mapSearchResult(item: any): SearchResult {
    const contentId = item.contentId || item.copyrightId || item.id || '';
    const newRateFormats = item.newRateFormats || [];

    // 找出最高音质
    let maxQuality = Quality.STANDARD;
    let maxBitrate = 128;

    for (const fmt of newRateFormats) {
      const formatType = fmt.formatType || '';
      if (formatType.includes('ZQ24') || formatType.includes('Hires')) {
        maxQuality = Quality.HIRES;
        maxBitrate = 1800;
      } else if (formatType.includes('SQ') && maxQuality !== Quality.HIRES) {
        maxQuality = Quality.LOSSLESS;
        maxBitrate = 1000;
      } else if (formatType.includes('HQ') && maxQuality === Quality.STANDARD) {
        maxQuality = Quality.HIGH;
        maxBitrate = 320;
      }
    }

    // v19.1：搜索结果的音质大小（best-effort，newRateFormats/rateFormats/audioFormats 任一携带即取）
    const sizes = this.extractSizes(item);

    return {
      id: `migu_${contentId}`,
      type: 'song',
      title: item.title || item.songName || '未知歌曲',
      artist: item.singerName || item.singer || '未知歌手',
      album: item.album || item.albumName || '',
      duration: item.length || item.duration || 0,
      coverUrl: item.img || item.imgItems?.[0]?.img || '',
      sourceId: this.id,
      sourceSongId: contentId,
      quality: maxQuality,
      bitrate: maxBitrate,
      sizes: Object.keys(sizes).length > 0 ? sizes : undefined,
    };
  }

  /**
   * v19.1 从咪咕各形态响应中提取每档文件大小（字节）：
   * - newRateFormats: {formatType(PQ/HQ/SQ/ZQ24), size, androidSize}
   * - rateFormats:    {formatType(LQ/PQ/HQ/SQ), size, androidSize}
   * - audioFormats:   {formatType, isize, resourceType}
   * 档位映射：ZQ24/ZQ/Hires→Hi-Res，SQ→无损，HQ→320K，PQ→128K（LQ 48K 不展示）。
   */
  private extractSizes(item: any): TierSizes {
    const sizes: TierSizes = {};
    if (!item) return sizes;
    const put = (formatType: string, bytes: number) => {
      const ft = (formatType || '').toString();
      let tier: QualityTier | null = null;
      if (/ZQ24|ZQ(?!2)|hires/i.test(ft)) tier = 'hires';
      else if (ft === 'SQ') tier = 'lossless';
      else if (ft === 'HQ') tier = '320k';
      else if (ft === 'PQ') tier = '128k';
      if (tier && bytes > 0 && !sizes[tier]) sizes[tier] = bytes;
    };
    for (const fmt of item.newRateFormats || []) {
      put(fmt?.formatType, parseInt((fmt?.androidSize || fmt?.size || '0').toString(), 10) || 0);
    }
    for (const fmt of item.rateFormats || []) {
      put(fmt?.formatType, parseInt((fmt?.androidSize || fmt?.size || '0').toString(), 10) || 0);
    }
    for (const fmt of item.audioFormats || []) {
      put(fmt?.formatType, parseInt((fmt?.isize || '0').toString(), 10) || 0);
    }
    return sizes;
  }

  /**
   * v19.1 音质弹窗实时查询：resourceinfo.do 歌曲详情（resourceType=2），
   * 返回 rateFormats/newRateFormats 各档文件大小。
   * 文档：咪咕音乐接口完整文档 §4.1 歌曲详情 resourceType=2（实测可用）。
   */
  async getQualityOptions(songId: string): Promise<QualityOption[]> {
    const contentId = this.extractContentId(songId);
    if (!contentId) return [];
    const url = `https://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?resourceId=${contentId}&resourceType=2`;
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://y.migu.cn/',
        },
      });
      if (!resp.ok) return [];
      const data = await resp.json().catch(() => null);
      const res = data?.resource?.[0];
      if (!res) return [];
      const sizes = this.extractSizes(res);
      return Object.entries(sizes).map(([tier, sizeBytes]) => ({
        sourceId: this.id,
        sourceName: this.name,
        tier: tier as QualityTier,
        sizeBytes,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 获取歌曲详情
   */
  async getSongDetail(songId: string): Promise<SongDetail> {
    const contentId = this.extractContentId(songId);

    try {
      const url = `${this.apiBase}/MIGU/3.0.0/v2.0/content/querySongInfo.do?contentId=${contentId}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36',
        },
      });

      if (!response.ok) {
        return this.buildDetailFromId(contentId);
      }

      const data = await response.json();
      const song = data?.data;

      if (!song) {
        return this.buildDetailFromId(contentId);
      }

      return {
        id: songId,
        title: song.title || '未知歌曲',
        artist: song.singerName || '',
        album: song.album || '',
        duration: song.length || 0,
        coverUrl: song.imgItems?.[0]?.img || '',
      };
    } catch {
      return this.buildDetailFromId(contentId);
    }
  }

  private buildDetailFromId(contentId: string): SongDetail {
    return {
      id: contentId,
      title: '咪咕音乐歌曲',
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
    const contentId = this.extractContentId(songId);

    try {
      const url = `${this.apiBase}/MIGU/3.0.0/v2.0/content/queryLyricInfo.do?contentId=${contentId}`;
      const response = await fetch(url);

      if (!response.ok) return null;

      const data = await response.json();
      const lyric = data?.data?.lyric;
      return lyric || null;
    } catch {
      return null;
    }
  }

  /**
   * 按融合固定分类拉取歌单列表：taglist 匹配标签 → listbytag
   */
  async getPlaylistsByCategory(categoryName: string, page = 0): Promise<PlaylistSummary[]> {
    try {
      const tagId = await this.resolveMiguTagId(categoryName);
      if (!tagId) return [];
      const url = `${this.apiBase}/MIGUM3.0/v1.0/template/musiclistplaza-listbytag/release?tagId=${encodeURIComponent(
        tagId
      )}&pageNumber=${page + 1}&templateVersion=1`;
      const data = await this.httpGetJson(url, {
        channel: '0146921',
        Referer: 'https://music.migu.cn/',
      });
      const items = data?.data?.contentItemList?.itemList || [];
      return items
        .map((it: any) => {
          const m = String(it.actionUrl || '').match(/id=(\d+)/);
          return {
            id: m ? m[1] : '',
            title: it.title || it.songListName || '未命名歌单',
            coverUrl: it.imageUrl || it.img || '',
            playCount: typeof it.playCount === 'number' ? it.playCount : undefined,
          };
        })
        .filter((p: PlaylistSummary) => p.id);
    } catch (err) {
      debugLogger.warn('network', '咪咕分类歌单拉取失败', { categoryName, err: String(err) });
      return [];
    }
  }

  /** 从 taglist 接口匹配分类名对应的 tagId（缓存） */
  private miguTagCache: Map<string, string> | null = null;
  private async resolveMiguTagId(categoryName: string): Promise<string> {
    if (!this.miguTagCache) {
      this.miguTagCache = new Map();
      try {
        const data = await this.httpGetJson(
          `${this.apiBase}/MIGUM3.0/v1.0/template/musiclistplaza-taglist/release?templateVersion=1`,
          { channel: '0146921', Referer: 'https://music.migu.cn/' }
        );
        for (const group of data?.data || []) {
          for (const tag of group?.content || []) {
            const texts = tag?.texts || [];
            if (texts.length >= 2) {
              this.miguTagCache.set(String(texts[0]), String(texts[1]));
            }
          }
        }
      } catch {
        /* 缓存留空，匹配不到时返回空列表 */
      }
    }
    return this.miguTagCache.get(categoryName) || this.miguTagCache.get(categoryName.replace(/榜单|歌单/g, '')) || '';
  }

  /**
   * 获取歌单详情
   */
  async getPlaylist(playlistId: string) {
    try {
      const url = `${this.bmwBase}/queryMusiclistSongs.do?musicListId=${playlistId}&pageSize=100`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new YinliuError(ErrorCode.SOURCE_ERROR, '获取歌单失败', 502);
      }

      const data = await response.json();
      const list = data?.data?.items || [];

      return {
        id: playlistId,
        name: data?.data?.musicListTitle || '咪咕歌单',
        description: data?.data?.musicListSummary || '',
        coverUrl: data?.data?.img || '',
        songs: list.map((item: any) => this.mapSearchResult(item)),
        total: list.length,
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
    // 咪咕歌单URL格式：
    // https://music.migu.cn/v3/music/playlist/123456789
    const match = url.match(/playlist[\/](\d+)/);
    if (!match) {
      throw new YinliuError(ErrorCode.VALIDATION_ERROR, '无法解析咪咕歌单URL', 400);
    }
    return this.getPlaylist(match[1]);
  }

  /**
   * 构建取链候选端点
   * 包含：官方listen接口 + URL派生法 + 第三方代理
   */
  protected buildEndpointCandidates(songId: string, quality: Quality) {
    const contentId = this.extractContentId(songId);
    const candidates = [];

    // 官方listen接口
    candidates.push({
      url: `${this.apiBase}/MIGU/3.0.0/v2.0/content/listenUrl.do?contentId=${contentId}&resourceType=2&purpose=1&channel=0`,
      method: 'GET' as const,
      timeout: 8000,
      priority: 1,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36',
      },
    });

    // URL派生法：通过PQ URL派生HQ/SQ/ZQ24
    const derivedUrls = this.buildDerivedUrls(contentId, quality);
    for (const url of derivedUrls) {
      candidates.push({
        url,
        method: 'GET' as const,
        timeout: 10000,
        priority: 1,
      });
    }

    // 第三方代理
    candidates.push({
      url: `https://migu-api-enhanced.example/v1/song/url?id=${contentId}&quality=${this.mapQualityToParam(quality)}`,
      method: 'GET' as const,
      timeout: 10000,
      priority: 2,
    });

    return candidates;
  }

  /**
   * URL派生法：从PQ（标准音质）URL派生HQ/SQ/ZQ24 URL
   * 原理：替换目录名和扩展名，CDN只校验Tim/Key参数
   */
  private buildDerivedUrls(contentId: string, quality: Quality): string[] {
    const urls: string[] = [];

    // 先获取PQ URL，然后替换
    const pqUrl = `https://freetyst.nf.migu.cn/${contentId}.mp3`;

    switch (quality) {
      case Quality.HIFI:
      case Quality.HIRES:
        // ZQ24
        urls.push(pqUrl.replace('.mp3', '_ZQ24.flac'));
        urls.push(pqUrl.replace('.mp3', '_SQ.flac'));
        break;
      case Quality.LOSSLESS:
        // SQ FLAC
        urls.push(pqUrl.replace('.mp3', '_SQ.flac'));
        break;
      case Quality.HIGH:
        // HQ 320K
        urls.push(pqUrl.replace('.mp3', '_HQ.mp3'));
        break;
      case Quality.STANDARD:
      default:
        // PQ 128K
        urls.push(pqUrl);
        break;
    }

    return urls;
  }

  private mapQualityToParam(quality: Quality): string {
    switch (quality) {
      case Quality.HIFI:
      case Quality.HIRES:
        return 'ZQ24';
      case Quality.LOSSLESS:
        return 'SQ';
      case Quality.HIGH:
        return 'HQ';
      case Quality.STANDARD:
      default:
        return 'PQ';
    }
  }

  private extractContentId(songId: string): string {
    // songId可能是 migu_xxx 或纯contentId
    if (songId.startsWith('migu_')) {
      return songId.slice(5);
    }
    return songId;
  }

  /**
   * 获取歌曲音质信息
   */
  async getSongRateInfo(contentId: string) {
    try {
      const url = `${this.apiBase}/MIGU/3.0.0/v2.0/content/querySongInfo.do?contentId=${contentId}`;
      const response = await fetch(url);
      if (!response.ok) return null;

      const data = await response.json();
      return data?.data?.newRateFormats || [];
    } catch {
      return null;
    }
  }

  /**
   * 获取排行榜列表（v18：官方 rank-index 接口，channel 必须为 014X031）
   * 嵌套结构：data.contents[].style=分组名, contents[] 内 rankId/rankName，需递归提取
   */
  async getCharts() {
    try {
      const url = `${this.apiBase}/pc/bmw/rank/rank-index/v1.0?channel=014X031`;
      const response = await fetch(url, {
        headers: {
          Referer: 'https://music.migu.cn/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      if (!response.ok) return [];

      const data = await response.json();
      const charts: { id: string; name: string; description: string }[] = [];
      const seen = new Set<string>();

      const walk = (node: any) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (node.rankId && node.rankName) {
          const id = String(node.rankId);
          if (!seen.has(id)) {
            seen.add(id);
            charts.push({ id, name: node.rankName, description: '' });
          }
        }
        Object.values(node).forEach((v) => walk(v));
      };
      walk(data?.data);

      return charts;
    } catch {
      return [];
    }
  }

  /**
   * 获取排行榜详情（v18：官方 rank-info 接口）
   * 歌曲信息在 contents[].songData（JSON字符串需二次解析），部分条目缺 songData 时回退本层 txt/txt2/resId
   */
  async getChartDetail(chartId: string) {
    try {
      const url = `${this.apiBase}/pc/bmw/rank/rank-info/v1.0?rankId=${chartId}&pageSize=50&pageNum=1&channel=014X031`;
      const response = await fetch(url, {
        headers: {
          Referer: 'https://music.migu.cn/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      if (!response.ok) return { id: chartId, name: '咪咕榜单', songs: [] };

      const data = await response.json();
      const contents = data?.data?.contents || [];

      const songs: SearchResult[] = [];
      for (const item of contents) {
        if (item?.songData) {
          try {
            const song = typeof item.songData === 'string' ? JSON.parse(item.songData) : item.songData;
            songs.push(this.mapRankSong(song));
            continue;
          } catch {
            // fallthrough
          }
        }
        // 兜底：本层字段（榜单分组页内嵌歌曲）
        if (item?.resId && item?.txt) {
          songs.push({
            id: `migu_${item.resId}`,
            type: 'song',
            title: item.txt || '未知歌曲',
            artist: item.txt2 || '未知歌手',
            album: item.txt3 || '',
            duration: 0,
            coverUrl: '',
            sourceId: this.id,
            sourceSongId: String(item.resId),
            quality: Quality.STANDARD,
            bitrate: 128,
          });
        }
      }

      return { id: chartId, name: '咪咕榜单', songs };
    } catch {
      return { id: chartId, name: '咪咕榜单', songs: [] };
    }
  }

  /**
   * rank-info songData 结构 → SearchResult（songName/singerList/img3/audioFormats.isize）
   */
  private mapRankSong(song: any): SearchResult {
    const contentId = song?.contentId || song?.copyrightId || song?.songId || '';
    const formats = song?.audioFormats || [];

    let maxQuality = Quality.STANDARD;
    let maxBitrate = 128;
    const sizes: TierSizes = {};
    for (const fmt of formats) {
      const formatType = fmt.formatType || '';
      const size = parseInt(fmt.isize || '0', 10) || 0;
      const tier: keyof TierSizes | null = formatType.includes('ZQ24') || formatType.toLowerCase().includes('hires')
        ? 'hires'
        : formatType === 'SQ' ? 'lossless'
        : formatType === 'HQ' ? '320k'
        : null;
      if (tier && size > 0) sizes[tier] = size;
      if ((formatType.includes('ZQ24') || formatType.includes('Hires')) && maxQuality < Quality.HIRES) {
        maxQuality = Quality.HIRES; maxBitrate = 1800;
      } else if (formatType === 'SQ' && maxQuality < Quality.LOSSLESS) {
        maxQuality = Quality.LOSSLESS; maxBitrate = 1000;
      } else if (formatType === 'HQ' && maxQuality < Quality.HIGH) {
        maxQuality = Quality.HIGH; maxBitrate = 320;
      }
    }

    return {
      id: `migu_${contentId}`,
      type: 'song',
      title: song?.songName || '未知歌曲',
      artist: (song?.singerList || []).map((s: any) => s?.name).filter(Boolean).join('/') || '未知歌手',
      album: song?.album || '',
      duration: Math.round((song?.duration || song?.length || 0) / 1000) || 0,
      coverUrl: song?.img3 || song?.img2 || song?.img1 || '',
      sourceId: this.id,
      sourceSongId: String(contentId),
      quality: maxQuality,
      bitrate: maxBitrate,
      sizes: Object.keys(sizes).length > 0 ? sizes : undefined,
    };
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<HealthStatus> {
    try {
      const response = await fetch('https://music.migu.cn', {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      return {
        healthy: response.ok,
        message: response.ok ? '咪咕音乐服务正常' : '咪咕音乐服务异常',
        latency: 0,
      };
    } catch {
      return { healthy: false, message: '咪咕音乐服务不可用' };
    }
  }
}
