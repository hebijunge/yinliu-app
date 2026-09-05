import type { PlaylistSummary } from '../../core/types';
import { BaseHttpSource, type ResolvedCandidate } from './BaseHttpSource';
import { Quality } from '@core/types';
import type { FileSizeResult } from './types';
import type { SearchParams, SearchResult, SongDetail, HealthStatus, TierSizes, QualityOption, QualityTier, PlayUrlResult } from '@core/types';
import { YinliuError, ErrorCode } from '@core/types';
import { debugLogger } from '@shared/utils/debugLogger';
import { decryptH5v24Response } from '@shared/audio/crypto';

/**
 * 咪咕音乐音源Provider
 * v22.x: 固定 h5v2.4 PQ 取链 + 全音质 URL 派生
 * 不再做多端点并发竞速，不再串行尝试 listenUrl.do / 代理等候选端点
 * HQ/SQ/ZQ24/Z3D 一律从 PQ 直链派生（CDN 签名对音质路径不敏感）
 * 已知限制：部分歌曲无 ZQ24（自动降级到 SQ→HQ→PQ）；Z3D 需额外 3D60 明文提取密钥
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
  /** 当前取链的 copyrightId（由 getPlayUrl 设置） */
  private currentCopyrightId: string | null = null;

  // === 实例级缓存与锁（替代父类多候选竞速）===
  private static readonly MIGU_CACHE_TTL = 25 * 60 * 1000;      // 25 分钟
  private static readonly PQ_CACHE_TTL = 25 * 60 * 1000;   // PQ 直链缓存 25 分钟
  /** songId_quality → PlayUrlResult 缓存 */
  private playUrlCache = new Map<string, { result: PlayUrlResult; expiresAt: number }>();
  /** copyrightId → PQ 直链缓存（PQ 直链记忆仍有价值） */
  private pqUrlCache = new Map<string, { pqUrl: string; expiresAt: number }>();
  /** 去重锁：songId_quality → Promise */
  private pendingLocks = new Map<string, Promise<PlayUrlResult>>();

  /**
   * v22.x: 固定走 h5v2.4 取 PQ 直链，再派生目标音质。
   * 不再调用父类 linkRace 竞速逻辑，不再串行尝试 listenUrl.do / 代理等候选端点。
   */
  async getPlayUrl(songId: string, quality: Quality, signal?: AbortSignal): Promise<PlayUrlResult> {
    const contentId = this.extractContentId(songId);
    const lockKey = `${this.id}_${songId}_${quality}`;

    // 1. 缓存命中检查
    const cached = this.playUrlCache.get(lockKey);
    if (cached && Date.now() < cached.expiresAt) {
      debugLogger.info('player', `咪咕取链缓存命中: ${songId}`, { lockKey, quality });
      return cached.result;
    }

    // 2. 去重保护：同曲同音质正在取链中，直接等待已有请求
    const existing = this.pendingLocks.get(lockKey);
    if (existing) {
      debugLogger.info('player', `咪咕取链去重复用: ${songId}`, { lockKey });
      return existing;
    }

    // 外部取消信号优先
    if (signal?.aborted) {
      throw new YinliuError(ErrorCode.LINK_RACE_FAILED, '取链已取消', 499);
    }

    // 3. 获取 copyrightId
    let copyrightId = this.copyrightIdCache.get(contentId);
    if (!copyrightId) {
      const fetched = await this.fetchCopyrightId(contentId);
      if (fetched) {
        copyrightId = fetched;
        this.copyrightIdCache.set(contentId, fetched);
      }
    }
    this.currentCopyrightId = copyrightId || contentId;

    // 4. 执行取链并管理锁/缓存生命周期
    const promise = this.doGetPlayUrl(contentId, copyrightId || contentId, quality, signal);
    this.pendingLocks.set(lockKey, promise);

    promise
      .then((result) => {
        const ttl = result.expiresAt
          ? result.expiresAt - Date.now()
          : MiguSource.MIGU_CACHE_TTL;
        if (ttl > 0) {
          this.playUrlCache.set(lockKey, { result, expiresAt: Date.now() + ttl });
        }
      })
      .catch(() => {
        // 失败不缓存
      })
      .finally(() => {
        this.pendingLocks.delete(lockKey);
      });

    return promise;
  }

  /**
   * 实际取链：固定 h5v2.4 PQ → 派生目标音质 → HEAD 验证
   */
  private async doGetPlayUrl(
    contentId: string,
    copyrightId: string,
    quality: Quality,
    signal?: AbortSignal
  ): Promise<PlayUrlResult> {
    // 优先查 PQ 直链缓存（同一首歌换音质可复用）
    const pqCacheKey = copyrightId;
    let pqUrl: string | null = null;
    const pqCached = this.pqUrlCache.get(pqCacheKey);
    if (pqCached && Date.now() < pqCached.expiresAt) {
      pqUrl = pqCached.pqUrl;
    }

    // 缓存未命中，请求 h5v2.4 固定 PQ
    if (!pqUrl) {
      pqUrl = await this.fetchH5v24Pq(contentId, copyrightId, signal);
      if (pqUrl) {
        this.pqUrlCache.set(pqCacheKey, { pqUrl, expiresAt: Date.now() + MiguSource.PQ_CACHE_TTL });
      }
    }

    if (!pqUrl) {
      throw new YinliuError(ErrorCode.LINK_RACE_FAILED, '咪咕 h5v2.4 取链失败', 503);
    }

    // 从 PQ 直链按目标音质优先级派生
    const flags = this.qualityToFlags(quality);
    for (const flag of flags) {
      const derived = this.deriveTargetUrl(pqUrl, flag);
      if (!derived) continue;

      // HEAD 验证派生 URL 是否真实存在
      try {
        const head = await fetch(derived, { method: 'HEAD', headers: this.h5v24Headers, signal });
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

        // Z3D 需要附加解密信息（3D60 用于已知明文攻击提取密钥）
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

    // 所有派生都失败，返回 PQ 直链降级
    return {
      url: pqUrl,
      quality: Quality.STANDARD,
      bitrate: 128,
      format: 'mp3',
      accurate: false,
    };
  }

  /**
   * 固定从 h5v2.4 取 PQ 直链（toneFlag=PQ，不再传可变 quality）
   */
  private async fetchH5v24Pq(
    contentId: string,
    copyrightId: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    const url =
      `${this.h5v24Base}?contentId=${encodeURIComponent(contentId)}` +
      `&copyrightId=${encodeURIComponent(copyrightId)}` +
      `&resourceType=2&netType=01&toneFlag=PQ&scene=&lowerQualityContentId=${encodeURIComponent(contentId)}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.h5v24Headers,
        signal: signal || AbortSignal.timeout(12000),
      });

      if (!response.ok) {
        debugLogger.warn('network', '咪咕 h5v2.4 接口 HTTP 错误', { contentId, status: response.status });
        return null;
      }

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

      return pqUrl;
    } catch (err) {
      debugLogger.warn('network', '咪咕 h5v2.4 取链异常', { contentId, err: String(err) });
      return null;
    }
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
      // B2: 先构建局部 Map，成功拿到非空标签才写入缓存；失败不留空缓存占位，下次调用重试
      const map = new Map<string, string>();
      try {
        const data = await this.httpGetJson(
          `${this.apiBase}/MIGUM3.0/v1.0/template/musiclistplaza-taglist/release?templateVersion=1`,
          { channel: '0146921', Referer: 'https://music.migu.cn/' }
        );
        for (const group of data?.data || []) {
          for (const tag of group?.content || []) {
            const texts = tag?.texts || [];
            if (texts.length >= 2) {
              map.set(String(texts[0]), String(texts[1]));
            }
          }
        }
        if (map.size > 0) {
          this.miguTagCache = map;
        }
      } catch {
        /* B2: 失败不缓存，下次重试 */
      }
      if (!this.miguTagCache) return '';
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

  // === 取链（v22.x 核心改造）===

  /**
   * v22.x: buildEndpointCandidates 已停用。
   * 咪咕取链固定走 h5v2.4 PQ 直链 + 音质派生，不再返回多候选端点。
   * 本方法保留仅为满足 BaseHttpSource 抽象类契约。
   */
  protected buildEndpointCandidates(_songId: string, _quality: Quality): ResolvedCandidate[] {
    return [];
  }

  /**
   * v22.x: 覆写 getFileSize，固定走 h5v2.4 PQ → 派生目标音质 → HEAD 验证
   */
  async getFileSize(songId: string, quality: Quality, signal?: AbortSignal): Promise<FileSizeResult | null> {
    const contentId = this.extractContentId(songId);
    let copyrightId = this.copyrightIdCache.get(contentId);
    if (!copyrightId) {
      const fetched = await this.fetchCopyrightId(contentId);
      if (fetched) {
        copyrightId = fetched;
        this.copyrightIdCache.set(contentId, fetched);
      }
    }
    copyrightId = copyrightId || contentId;

    // 获取 PQ 直链
    const pqCacheKey = copyrightId;
    let pqUrl: string | null = null;
    const pqCached = this.pqUrlCache.get(pqCacheKey);
    if (pqCached && Date.now() < pqCached.expiresAt) {
      pqUrl = pqCached.pqUrl;
    } else {
      pqUrl = await this.fetchH5v24Pq(contentId, copyrightId, signal);
      if (pqUrl) {
        this.pqUrlCache.set(pqCacheKey, { pqUrl, expiresAt: Date.now() + MiguSource.PQ_CACHE_TTL });
      }
    }

    if (!pqUrl) return null;

    // 对目标音质的派生 URL 发 HEAD 取文件大小
    const flags = this.qualityToFlags(quality);
    for (const flag of flags) {
      const derived = this.deriveTargetUrl(pqUrl, flag);
      if (!derived) continue;
      try {
        const resp = await fetch(derived, { method: 'HEAD', headers: this.h5v24Headers, signal });
        if (!resp.ok) continue;
        const cl = resp.headers.get('content-length');
        const size = cl ? parseInt(cl, 10) : 0;
        if (size > 0) {
          return { size, url: derived };
        }
      } catch {
        continue;
      }
    }
    return null;
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
   * v22.x: 覆写内容校验，对直链做 HEAD 验证
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
