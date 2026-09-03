import type { PlaylistSummary } from '../../core/types';
import { BaseHttpSource, type ResolvedCandidate } from './BaseHttpSource';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult, SongDetail, HealthStatus, TierSizes, QualityOption, QualityTier, PlayUrlResult } from '@core/types';
import { YinliuError, ErrorCode } from '@core/types';
import { debugLogger } from '@shared/utils/debugLogger';
import { decryptH5v24Response } from '@shared/audio/crypto';

/**
 * 咪咕音乐音源Provider
 * v21.4: 接入 h5v2.4 加密取链 + URL派生法 + Z3D 流式解密支持
 * 接口：app.c.nf.migu.cn / pd.musicapp.migu.cn / c.musicapp.migu.cn（h5v2.4）
 * 特色：h5v2.4 免登录绕过版权限制，URL派生全音质，Z3D 需流式解密
 */
export class MiguSource extends BaseHttpSource {
  readonly id = 'migu';
  readonly name = '咪咕音乐';
  readonly maxQuality = Quality.HIRES;
  private readonly apiBase = 'https://app.c.nf.migu.cn';
  private readonly bmwBase = 'https://pd.musicapp.migu.cn/MIGU/3.0.0/v2.0/content';
  private readonly h5v24Base = 'https://c.musicapp.migu.cn/strategy/listen-url/h5/v2.4';

  /** h5v2.4 必需请求头 */
  private readonly h5v24Headers: Record<string, string> = {
    birth: 'h5page',
    channel: '014X031',
    Referer: 'https://y.migu.cn/',
    'location-data': '30.6698676660,104.1229614820',
    'location-info': '',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };

  /** contentId → copyrightId 缓存 */
  private copyrightIdCache = new Map<string, string>();
  /** 当前取链的 copyrightId（由 getPlayUrl 覆写设置） */
  private currentCopyrightId: string | null = null;

  /**
   * v21.4: 覆写 getPlayUrl，先获取 copyrightId 再调用父类竞速逻辑
   */
  async getPlayUrl(songId: string, quality: Quality, signal?: AbortSignal): Promise<PlayUrlResult> {
    const contentId = this.extractContentId(songId);
    let copyrightId = this.copyrightIdCache.get(contentId);
    if (!copyrightId) {
      const fetched = await this.fetchCopyrightId(contentId);
      if (fetched) {
        copyrightId = fetched;
        this.copyrightIdCache.set(contentId, fetched);
      }
    }
    this.currentCopyrightId = copyrightId || contentId;
    return super.getPlayUrl(songId, quality, signal);
  }

  /**
   * 通过 resourceinfo.do 获取 copyrightId
   */
  private async fetchCopyrightId(contentId: string): Promise<string | null> {
    try {
      const url = `https://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?resourceId=${contentId}&resourceType=2`;
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36',
          Accept: 'application/json',
          Referer: 'https://y.migu.cn/',
        },
      });
      if (!resp.ok) return null;
      const data = await resp.json().catch(() => null);
      const res = data?.resource?.[0];
      const cid = res?.copyrightId || res?.contentId || '';
      return cid ? String(cid) : null;
    } catch {
      return null;
    }
  }

  // === 搜索 ===

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
    const copyrightId = item.copyrightId || '';
    if (contentId && copyrightId && String(copyrightId) !== String(contentId)) {
      this.copyrightIdCache.set(String(contentId), String(copyrightId));
    }

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

    // v19.1：搜索结果的音质大小
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
   * v19.1 从咪咕各形态响应中提取每档文件大小（字节）
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
   * v19.1 音质弹窗实时查询
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

  // === 歌曲详情 ===

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

  // === 歌词 ===

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

  // === 歌单分类 ===

  private static readonly MIGU_TAG_ALIASES: Record<string, string> = {
    华语: '国语',
    日韩: '日语',
    说唱: '嘻哈',
    古风: '国风',
    轻音乐: '纯音乐',
    影视原声: '电影',
  };

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
        /* 缓存留空 */
      }
    }
    const alias = MiguSource.MIGU_TAG_ALIASES[categoryName];
    return (
      this.miguTagCache.get(categoryName) ||
      (alias ? this.miguTagCache.get(alias) : undefined) ||
      this.miguTagCache.get(categoryName.replace(/榜单|歌单/g, '')) ||
      ''
    );
  }

  // === 歌单详情 ===

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

  async parsePlaylistUrl(url: string) {
    const match = url.match(/playlist[\/](\d+)/);
    if (!match) {
      throw new YinliuError(ErrorCode.VALIDATION_ERROR, '无法解析咪咕歌单URL', 400);
    }
    return this.getPlaylist(match[1]);
  }

  // === 取链（v21.4 核心改造）===

  /**
   * v21.4: 构建取链候选端点
   * 优先级：h5v2.4(0) > listenUrl.do fallback(1) > URL派生 fallback(1) > 第三方代理(2)
   */
  protected buildEndpointCandidates(songId: string, quality: Quality): ResolvedCandidate[] {
    const contentId = this.extractContentId(songId);
    const copyrightId = this.currentCopyrightId || contentId;
    const candidates: ResolvedCandidate[] = [];

    // 1. h5v2.4 加密取链（主链路，唯一能绕过版权限制的接口）
    const h5v24Url =
      `${this.h5v24Base}?contentId=${encodeURIComponent(contentId)}` +
      `&copyrightId=${encodeURIComponent(copyrightId)}` +
      `&resourceType=2&netType=01&toneFlag=PQ&scene=&lowerQualityContentId=${encodeURIComponent(contentId)}`;

    candidates.push({
      url: h5v24Url,
      method: 'GET',
      timeout: 12000,
      priority: 0,
      headers: this.h5v24Headers,
      key: `h5v24_${contentId}`,
      resolve: async (response: Response) => {
        return this.resolveH5v24Response(response, quality);
      },
    });

    // 2. listenUrl.do 明文取链（fallback）
    candidates.push({
      url: `${this.apiBase}/MIGU/3.0.0/v2.0/content/listenUrl.do?contentId=${contentId}&resourceType=2&purpose=1&channel=0`,
      method: 'GET',
      timeout: 8000,
      priority: 1,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36',
      },
    });

    // 3. URL派生法 fallback（基于固定模板，不依赖 h5v2.4）
    const derivedUrls = this.buildDerivedUrls(contentId, quality);
    for (const url of derivedUrls) {
      candidates.push({
        url,
        method: 'GET',
        timeout: 10000,
        priority: 1,
      });
    }

    // 4. 第三方代理
    candidates.push({
      url: `https://migu-api-enhanced.example/v1/song/url?id=${contentId}&quality=${this.mapQualityToParam(quality)}`,
      method: 'GET',
      timeout: 10000,
      priority: 2,
    });

    return candidates;
  }

  /**
   * v21.4: 解析 h5v2.4 加密响应，解密后派生目标音质 URL
   */
  private async resolveH5v24Response(response: Response, quality: Quality): Promise<PlayUrlResult | null> {
    try {
      const raw = new Uint8Array(await response.arrayBuffer());
      const json = decryptH5v24Response(raw);

      if (json.code !== '000000') {
        debugLogger.warn('network', `h5v2.4 取链失败: ${json.code}`, { info: json.info });
        return null;
      }

      const data = json.data as Record<string, unknown> | undefined;
      const pqUrl = data?.url as string | undefined;
      if (!pqUrl || !pqUrl.includes('freetyst.nf.migu.cn')) {
        return null;
      }

      // 按目标音质尝试派生 URL（优先级列表）
      const flags = this.qualityToFlags(quality);
      for (const flag of flags) {
        const derived = this.deriveTargetUrl(pqUrl, flag);
        if (!derived) continue;

        // HEAD 验证派生 URL 是否有效
        try {
          const head = await fetch(derived, { method: 'HEAD', headers: this.h5v24Headers });
          if (!head.ok) continue;
          const cl = head.headers.get('content-length');
          const size = cl ? parseInt(cl, 10) : 0;
          if (size < 1024) continue; // 太小可能是防盗占位

          const result: PlayUrlResult = {
            url: derived,
            quality,
            bitrate: this.flagToBitrate(flag),
            format: this.flagToFormat(flag),
            accurate: true,
            headers: this.h5v24Headers,
          };

          // Z3D 需要附加解密信息
          if (flag === 'Z3D') {
            const p3dUrl = this.deriveTargetUrl(pqUrl, '3D60');
            if (p3dUrl) {
              result.z3dDecryptInfo = { z3dUrl: derived, p3dUrl };
            } else {
              continue; // 3D60 派生失败，无法解密 Z3D，跳过
            }
          }

          return result;
        } catch {
          // HEAD 失败，继续试下一个 flag
          continue;
        }
      }

      // 所有派生都失败，返回 PQ 直链（降级）
      return {
        url: pqUrl,
        quality: Quality.STANDARD,
        bitrate: 128,
        format: 'mp3',
        accurate: false,
      };
    } catch (err) {
      debugLogger.warn('network', 'h5v2.4 响应解析失败', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * v21.4: h5v2.4 加密取链独立方法：返回二进制加密 JSON，解密后获取 PQ 直链
   * 该接口可绕过 VIP/版权限制（cannotCode=440013），供取链失败排查与集成测试直调
   * 注意：常规取链走 buildEndpointCandidates 的 resolveH5v24Response（含音质派生与 HEAD 校验）
   */
  async fetchH5v24(contentId: string, quality: Quality): Promise<string | null> {
    const toneFlag = this.mapQualityToParam(quality);
    const url =
      `${this.h5v24Base}?contentId=${encodeURIComponent(contentId)}` +
      `&toneFlag=${toneFlag}&resourceType=2&version=1`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          ...this.h5v24Headers,
          'birth': 'h5page',
          'channel': '014X031',
          'Referer': 'https://y.migu.cn/',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        debugLogger.warn('network', '咪咕 h5v2.4 接口 HTTP 错误', { contentId, status: response.status });
        return null;
      }

      const raw = new Uint8Array(await response.arrayBuffer());
      if (raw.length < 4) {
        debugLogger.warn('network', '咪咕 h5v2.4 响应过短', { contentId, length: raw.length });
        return null;
      }

      const decrypted = decryptH5v24Response(raw) as {
        code?: unknown;
        msg?: unknown;
        data?: { listenUrl?: string };
        listenUrl?: string;
      };

      // 检查业务错误码
      const code = decrypted?.code;
      if (code !== undefined && code !== '000000' && code !== 0) {
        debugLogger.warn('network', '咪咕 h5v2.4 业务错误', { contentId, code, msg: decrypted?.msg });
        return null;
      }

      const listenUrl = decrypted?.data?.listenUrl || decrypted?.listenUrl || '';
      if (!listenUrl) {
        debugLogger.warn('network', '咪咕 h5v2.4 返回空 listenUrl', { contentId });
        return null;
      }

      return listenUrl;
    } catch (err) {
      debugLogger.warn('network', '咪咕 h5v2.4 取链异常', { contentId, err: String(err) });
      return null;
    }
  }

  /**
   * 音质档位 → 派生 toneFlag 优先级列表
   */
  private qualityToFlags(quality: Quality): string[] {
    switch (quality) {
      case Quality.LOW:
        return ['PQ'];
      case Quality.STANDARD:
        return ['PQ'];
      case Quality.HIGHER:
        return ['HQ', 'PQ'];
      case Quality.HIGH:
        return ['HQ', 'PQ'];
      case Quality.LOSSLESS:
        return ['SQ', 'HQ', 'PQ'];
      case Quality.HIFI:
      case Quality.HIRES:
        return ['ZQ24', 'SQ', 'HQ', 'PQ'];
      case Quality.SKY:
      case Quality.JYEFFECT:
        return ['HQ', 'PQ'];
      default:
        return ['PQ'];
    }
  }

  /**
   * 从 PQ 直链派生目标档 URL（URL 派生法）
   * 原理：替换中文目录 + ASCII 子目录 + 扩展名，CDN 只校验 Tim/Key 签名
   */
  private deriveTargetUrl(pqUrl: string, targetFlag: string): string | null {
    if (!pqUrl.includes('freetyst.nf.migu.cn')) return null;

    const mapping: Record<string, { cn: string; ascii: string; ext: string }> = {
      PQ: { cn: '标清高清', ascii: 'MP3_128_16_Stero', ext: '.mp3' },
      HQ: { cn: '标清高清', ascii: 'MP3_320_16_Stero', ext: '.mp3' },
      SQ: { cn: '歌曲下载', ascii: 'flac', ext: '.flac' },
      ZQ24: { cn: '歌曲下载', ascii: 'flac_24bit', ext: '.flac' },
      Z3D: { cn: '歌曲下载', ascii: 'wav_3d', ext: '.wav' },
      '3D60': { cn: '歌曲下载', ascii: 'wav_3d_60s', ext: '.wav' },
    };

    const map = mapping[targetFlag];
    if (!map) return null;

    const pqMap = mapping['PQ'];

    let url = pqUrl;

    // 替换中文目录（URL 编码形态 + 明文形态）
    const pqCnEncoded = encodeURIComponent(pqMap.cn);
    const targetCnEncoded = encodeURIComponent(map.cn);
    url = url.replace(pqCnEncoded, targetCnEncoded);
    url = url.replace(pqMap.cn, map.cn);

    // 替换 ASCII 子目录
    url = url.replace(pqMap.ascii, map.ascii);

    // 替换扩展名（只替换文件名部分的 .mp3）
    const urlParts = url.split('?');
    const path = urlParts[0];
    const query = urlParts[1] || '';
    const lastDot = path.lastIndexOf('.');
    if (lastDot > path.lastIndexOf('/')) {
      url = path.substring(0, lastDot) + map.ext + (query ? `?${query}` : '');
    }

    return url;
  }

  /**
   * v21.4: 覆写内容校验，对直链做 HEAD 验证
   */
  protected async validateContent(result: PlayUrlResult, _songId: string): Promise<boolean> {
    try {
      const head = await fetch(result.url, {
        method: 'HEAD',
        headers: result.headers,
      });
      if (!head.ok) return false;
      const cl = head.headers.get('content-length');
      const size = cl ? parseInt(cl, 10) : 0;
      return size >= 1024;
    } catch {
      return true; // HEAD 失败不拦截
    }
  }

  /**
   * toneFlag → 码率
   */
  private flagToBitrate(flag: string): number {
    switch (flag) {
      case 'PQ': return 128;
      case 'HQ': return 320;
      case 'SQ': return 1000;
      case 'ZQ24': return 1800;
      case 'Z3D': return 1800;
      default: return 128;
    }
  }

  /**
   * toneFlag → 格式
   */
  private flagToFormat(flag: string): string {
    switch (flag) {
      case 'PQ': return 'mp3';
      case 'HQ': return 'mp3';
      case 'SQ': return 'flac';
      case 'ZQ24': return 'flac';
      case 'Z3D': return 'wav';
      default: return 'mp3';
    }
  }

  // === 兼容旧版 URL 派生（fallback）===

  private buildDerivedUrls(contentId: string, quality: Quality): string[] {
    const urls: string[] = [];
    const pqUrl = `https://freetyst.nf.migu.cn/${contentId}.mp3`;

    switch (quality) {
      case Quality.HIFI:
      case Quality.HIRES:
        urls.push(pqUrl.replace('.mp3', '_ZQ24.flac'));
        urls.push(pqUrl.replace('.mp3', '_SQ.flac'));
        break;
      case Quality.LOSSLESS:
        urls.push(pqUrl.replace('.mp3', '_SQ.flac'));
        break;
      case Quality.HIGH:
        urls.push(pqUrl.replace('.mp3', '_HQ.mp3'));
        break;
      case Quality.STANDARD:
      default:
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
    if (songId.startsWith('migu_')) {
      return songId.slice(5);
    }
    return songId;
  }

  // === 其他接口 ===

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

  async getChartDetail(chartId: string) {
    const PAGE_SIZE = 100;
    const MAX_PAGES = 3;
    const songs: SearchResult[] = [];
    const seen = new Set<string>();

    try {
      for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
        const url = `${this.apiBase}/pc/bmw/rank/rank-info/v1.0?rankId=${chartId}&pageSize=${PAGE_SIZE}&pageNum=${pageNum}&channel=014X031`;
        const response = await fetch(url, {
          headers: {
            Referer: 'https://music.migu.cn/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });
        if (!response.ok) break;
        const data = await response.json();
        const contents = data?.data?.contents || [];
        if (!contents.length) break;

        let added = 0;
        for (const item of contents) {
          let song: SearchResult | null = null;
          if (item?.songData) {
            try {
              const parsed = typeof item.songData === 'string' ? JSON.parse(item.songData) : item.songData;
              song = this.mapRankSong(parsed);
            } catch {
              // fallthrough
            }
          }
          if (!song && item?.resId && item?.txt) {
            song = {
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
            };
          }
          if (song && !seen.has(song.sourceSongId)) {
            seen.add(song.sourceSongId);
            songs.push(song);
            added++;
          }
        }
        if (added === 0 || data?.data?.hasNextPage !== true) break;
      }

      return { id: chartId, name: '咪咕榜单', songs };
    } catch {
      return { id: chartId, name: '咪咕榜单', songs };
    }
  }

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
