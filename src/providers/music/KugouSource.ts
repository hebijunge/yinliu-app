import { BaseHttpSource } from './BaseHttpSource';
import { Quality, YinliuError, ErrorCode } from '@core/types';
import type { SearchParams, SearchResult, SongDetail, HealthStatus, PlayUrlResult, PlaylistDetail, Chart, ChartDetail, PlaylistSummary, QualityOption } from '@core/types';
import type { ResolvedCandidate } from './BaseHttpSource';
import { platformFetch } from '@shared/utils/platformFetch';
import { debugLogger } from '@shared/utils/debugLogger';

/**
 * 酷狗音乐音源Provider
 * 基于DJMusic Kotlin源码移植 + 接口文档实测
 * 
 * 搜索：mobilecdn.kugou.com/api/v3/search/song（老版接口，免登录）
 * 取链：官方m.kugou.com/app/i/getSongInfo.php + 海棠resolve-url并发竞速
 * 歌词：krcs.kugou.com/search → lyrics.kugou.com/download（Base64 LRC）
 */
export class KugouSource extends BaseHttpSource {
  readonly id = 'kugou';
  readonly name = '酷狗音乐';
  readonly maxQuality = Quality.HIRES;

  private readonly SEARCH_HOST = 'http://mobilecdn.kugou.com/api/v3';
  private readonly M_HOST = 'http://m.kugou.com';
  private readonly GET_SONG_INFO = 'https://m.kugou.com/app/i/getSongInfo.php';
  private readonly HAITANG_URL = 'https://musicserver.haitangw.cc/v1/music/resolve-url';
  private readonly KRC_SEARCH = 'http://krcs.kugou.com/search';
  private readonly LYRICS_DOWNLOAD = 'http://lyrics.kugou.com/download';
  private readonly M_REF = 'http://m.kugou.com/';

  // hash缓存：自增id -> hash信息（含可选filesize，用于大小校验）
  private hashCache = new Map<string, { hash: string; hash320: string; hashFlac: string; name: string; artist: string; duration: number; filesize?: number }>();
  private nextId = 1;

  /**
   * accurate 竞速优先级判定：accurate !== false 视为可优先选用的结果。
   * 酷狗官方源返回 accurate: true；海棠降级链返回 accurate: false。
   */
  protected isAccurateResult(result: PlayUrlResult): boolean {
    return result.accurate !== false;
  }

  // ===================== 搜索 =====================

  async search(params: SearchParams): Promise<SearchResult[]> {
    const page = (params.page || 0) + 1;
    const kw = encodeURIComponent(params.keyword);
    const url = `${this.SEARCH_HOST}/search/song?format=json&keyword=${kw}&page=${page}&pagesize=30`;

    const data = await this.httpGetJson(url, { Referer: this.M_REF });
    if (!data) return [];

    const info = data?.data?.info || [];
    return info.map((o: any) => this.parseSong(o)).filter(Boolean) as SearchResult[];
  }

  private parseSong(o: any): SearchResult | null {
    const hash = (o.hash || '').toString();
    if (!hash) return null;

    const hash320 = (o['320hash'] || '').toString();
    const hashFlac = (o.sqhash || '').toString();

    let name = (o.songname || o.audio_name || '').toString().trim();
    let artist = (o.singername || o.author_name || '').toString().trim();

    // filename兜底解析
    const filename = (o.filename || '').toString().trim();
    if (!name && filename) {
      const parts = filename.split(' - ', 2);
      if (parts.length === 2) {
        if (!artist) artist = parts[0];
        name = parts[1];
      } else {
        name = filename;
      }
    }

    if (!name) return null;

    const dur = parseInt((o.duration || '0').toString(), 10);
    let cover = (o.img || o.album_img || o.imgurl || '').toString();
    if (cover) cover = cover.replace('{size}', '400');

    const id = `kg_${this.nextId++}`;
    const filesizeRaw = parseInt((o.filesize || '0').toString(), 10);
    const filesize = filesizeRaw > 0 ? filesizeRaw : undefined;
    this.hashCache.set(id, { hash, hash320, hashFlac, name, artist, duration: dur, filesize });

    return {
      id,
      type: 'song',
      title: name,
      artist,
      album: (o.album_name || '').toString(),
      duration: dur,
      coverUrl: cover,
      sourceId: this.id,
      sourceSongId: id, // 内部id，取链时反查hash
      quality: this.inferQuality(hash320, hashFlac),
      bitrate: hashFlac ? 1000 : hash320 ? 320 : 128,
    };
  }

  private inferQuality(hash320: string, hashFlac: string): Quality {
    if (hashFlac) return Quality.LOSSLESS;
    if (hash320) return Quality.HIGH;
    return Quality.STANDARD;
  }

  /**
   * v19.1 音质弹窗实时查询：酷狗 /api/v3/song/info?hash= 对单个 hash 只回该档 filesize
   * （实测 320filesize/sqfilesize 恒为空），因此按搜索缓存中的各档 hash
   * （hash→128K、hash320→320K、hashFlac→无损）分别查询、汇总真实大小。
   * 缓存缺失时回退：仅用取链 hash 查询，能拿到哪档算哪档，不编造。
   */
  async getQualityOptions(songId: string): Promise<QualityOption[]> {
    const cached = this.hashCache.get(songId) || this.hashCache.get(songId.replace(/^kg_/, ''));
    const baseHash = cached?.hash || this.getHashFromId(songId);
    if (!baseHash) return [];

    // 各档待查 hash（去重、去空）
    const tierHashes: { tier: '128k' | '320k' | 'lossless'; hash: string }[] = [];
    const push = (tier: '128k' | '320k' | 'lossless', hash: string) => {
      if (hash && !tierHashes.some((t) => t.hash === hash)) tierHashes.push({ tier, hash });
    };
    push('128k', baseHash);
    if (cached) {
      push('320k', cached.hash320);
      push('lossless', cached.hashFlac);
    }

    const queryOne = async (tier: '128k' | '320k' | 'lossless', hash: string): Promise<QualityOption | null> => {
      try {
        const url = `${this.SEARCH_HOST}/song/info?format=json&hash=${encodeURIComponent(hash)}`;
        const data = await this.httpGetJson(url, { Referer: this.M_REF });
        const info = data?.data;
        if (!info) return null;
        const sz = parseInt((info.filesize || '0').toString(), 10) || 0;
        if (sz <= 0) return null;
        return { sourceId: this.id, sourceName: this.name, tier, sizeBytes: sz };
      } catch {
        return null;
      }
    };

    // 并发查询各档（≤3 个请求）
    const results = await Promise.all(tierHashes.map(({ tier, hash }) => queryOne(tier, hash)));
    const seen = new Set<string>();
    const options: QualityOption[] = [];
    for (const r of results) {
      if (!r || seen.has(r.tier)) continue;
      seen.add(r.tier);
      options.push(r);
    }
    return options;
  }

  // ===================== 歌曲详情 =====================

  async getSongDetail(songId: string): Promise<SongDetail> {
    const hash = this.getHashFromId(songId);
    const cached = this.hashCache.get(songId);

    if (cached) {
      return {
        id: songId,
        title: cached.name,
        artist: cached.artist,
        album: '',
        duration: cached.duration,
        coverUrl: '',
      };
    }

    try {
      const url = `${this.GET_SONG_INFO}?cmd=playInfo&hash=${hash}`;
      const data = await this.httpGetJson(url, { Referer: this.M_REF });
      if (data) {
        const title = (data.songName || '').toString().trim();
        if (!title) {
          throw new Error(`酷狗歌曲详情获取失败：hash=${hash} 返回空名称`);
        }
        return {
          id: songId,
          title,
          artist: data.singerName || '',
          album: data.albumName || '',
          duration: data.timeLength ? parseInt(data.timeLength, 10) : 0,
          coverUrl: data.cover || data.imgUrl || '',
        };
      }
    } catch (err) {
      throw err instanceof Error ? err : new Error(`酷狗歌曲详情获取失败：hash=${hash}`);
    }

    throw new Error(`酷狗歌曲详情获取失败：hash=${hash} 无返回数据`);
  }


  /** 按音质选取对应 hash */
  private getHashForQuality(songId: string, quality: Quality): string | null {
    const cached = this.hashCache.get(songId);
    if (!cached) {
      if (/^[a-f0-9]{32}$/i.test(songId)) return songId;
      const cleanId = songId.replace(/^kg_/, '');
      if (/^[a-f0-9]{32}$/i.test(cleanId)) return cleanId;
      return null;
    }
    switch (quality) {
      case Quality.LOSSLESS:
      case Quality.HIFI:
      case Quality.HIRES:
        return cached.hashFlac || cached.hash320 || cached.hash;
      case Quality.HIGH:
        return cached.hash320 || cached.hash;
      default:
        return cached.hash;
    }
  }

  // ===================== 取链（核心）=====================

  protected buildEndpointCandidates(songId: string, quality: Quality): ResolvedCandidate[] {
    const hash = this.getHashFromId(songId);
    const level = this.levelOf(quality);
    const candidates: ResolvedCandidate[] = [];

    // 官方getSongInfo.php（免费歌返回直链）
    candidates.push({
      url: `${this.GET_SONG_INFO}?hash=${hash}&cmd=playInfo`,
      method: 'GET',
      timeout: 8000,
      priority: 1,
      headers: { Referer: this.M_REF },
      resolve: async (resp) => {
        const data = await resp.json().catch(() => null);
        if (!data?.url) return null;
        const url = data.url as string;
        if (!url.startsWith('http')) return null;
        // HEAD 校验实际格式/大小，不标 accurate 让 BaseHttpSource 兜底校验
        try {
          const head = await platformFetch(url, { method: 'HEAD', timeout: 2000 });
          const ct = head.headers.get('content-type') || '';
          const cl = head.headers.get('content-length') || '0';
          const format = ct.includes('flac') ? 'flac' : ct.includes('mpeg') || ct.includes('mp3') ? 'mp3' : 'mp3';
          const bitrate = this.estimateBitrate(cl, quality);
          return { url, quality, bitrate, format, accurate: false };
        } catch {
          return { url, quality, bitrate: 128, format: 'mp3', accurate: false };
        }
      },
    });

    // 海棠resolve-url（POST JSON）—— HIGH/LOSSLESS/HIFI/HIRES 均走海棠，超时 3 秒
    if (quality === Quality.HIGH || quality === Quality.LOSSLESS || quality === Quality.HIFI || quality === Quality.HIRES) {
      candidates.push({
        url: this.HAITANG_URL,
        method: 'POST',
        timeout: 3000,
        priority: 2,
        key: 'haitang',
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://musicserver.haitangw.cc/',
        },
        body: JSON.stringify({ source: 'kg', rid: hash, level }),
        resolve: async (resp) => {
          const data = await resp.json().catch(() => null);
          if (!data?.url) return null;
          const url = data.url as string;

          // HEAD 音质校验（带 2 秒独立超时）
          let ct = '';
          let sizeMb = 0;
          try {
            const head = await platformFetch(url, { method: 'HEAD', timeout: 2000 });
            ct = head.headers.get('content-type') || '';
            const cl = head.headers.get('content-length') || '0';
            const sizeBytes = parseInt(cl, 10) || 0;
            sizeMb = sizeBytes / (1024 * 1024);
          } catch {
            // HEAD 失败不阻断，降级为 inaccurate 返回
          }

          const isFlac = ct.includes('flac') || ct.includes('x-flac');
          const isMpeg = ct.includes('mpeg') || ct.includes('mp3');

          // 获取歌曲时长用于动态阈值计算
          const cached = this.hashCache.get(songId);
          const durationSec = cached?.duration || 180; // 默认3分钟

          if (quality === Quality.LOSSLESS || quality === Quality.HIFI || quality === Quality.HIRES) {
            // FLAC 最低阈值：按 500kbps * duration 估算，至少 3MB
            const minFlacMb = Math.max(3, (500 * durationSec) / 8 / 1024 / 1024);
            if (!isFlac || sizeMb < minFlacMb) {
              return { url, quality, bitrate: 128, format: 'mp3', accurate: false };
            }
            return { url, quality, bitrate: this.levelToBitrate(level), format: 'flac', accurate: true };
          }

          if (quality === Quality.HIGH) {
            if (!isMpeg) {
              return { url, quality, bitrate: 128, format: 'mp3', accurate: false };
            }
            // 320K MP3 最低阈值：按 192kbps * duration 估算，至少 2MB
            const minMp3Mb = Math.max(2, (192 * durationSec) / 8 / 1024 / 1024);
            if (sizeMb < minMp3Mb) {
              return { url, quality, bitrate: 128, format: 'mp3', accurate: false };
            }
            return { url, quality, bitrate: this.levelToBitrate(level), format: 'mp3', accurate: true };
          }

          return { url, quality, bitrate: 128, format: 'mp3', accurate: false };
        },
      });
    }

    return candidates;
  }

  // getPlayUrl 使用 BaseHttpSource 的优化版 linkRace（并行竞速 + 成功通道记忆 + 去重锁）

  private getHashFromId(songId: string): string {
    // 如果songId是32位hex，直接返回
    if (/^[a-f0-9]{32}$/i.test(songId)) return songId;

    // 如果是kg_前缀的内部id，从缓存取hash
    const cached = this.hashCache.get(songId);
    if (cached) {
      // 按音质选最佳hash
      if (cached.hashFlac) return cached.hashFlac;
      if (cached.hash320) return cached.hash320;
      return cached.hash;
    }

    // 兜底：去掉前缀
    return songId.replace(/^kg_/, '');
  }

  private levelOf(quality: Quality): string {
    switch (quality) {
      case Quality.LOW:
      case Quality.STANDARD: return 'standard';
      case Quality.HIGH: return 'exhigh';
      case Quality.LOSSLESS:
      case Quality.HIFI: return 'lossless';
      case Quality.HIRES: return 'hires';
      default: return 'standard';
    }
  }

  private levelToBitrate(level: string): number {
    switch (level) {
      case 'standard': return 128;
      case 'exhigh': return 320;
      case 'lossless': return 1000;
      case 'hires': return 1800;
      default: return 128;
    }
  }

  // ===================== 歌词 =====================

  async getLyrics(songId: string): Promise<string | null> {
    const hash = this.getHashFromId(songId);

    try {
      // 第一步：搜索krcs
      const searchUrl = `${this.KRC_SEARCH}?ver=1&man=yes&client=mobi&hash=${hash}&album_audio_id=`;
      const searchData = await this.httpGetJson(searchUrl, { Referer: this.M_REF });
      const cands = searchData?.candidates || [];
      if (cands.length === 0) return null;

      const best = cands[0];
      const id = best.id;
      const akey = best.accesskey;
      if (!id || !akey) return null;

      // 第二步：下载歌词
      const downloadUrl = `${this.LYRICS_DOWNLOAD}?ver=1&client=pc&id=${id}&accesskey=${akey}&fmt=lrc&charset=utf8`;
      const lyricData = await this.httpGetJson(downloadUrl, { Referer: this.M_REF });
      const content = lyricData?.content;
      if (!content) return null;

      // Base64解码
      try {
        return atob(content);
      } catch {
        return content;
      }
    } catch {
      return null;
    }
  }

  // ===================== 榜单（v18） =====================

  /**
   * 榜单列表：m.kugou.com/rank/list&json=true（55个榜单）
   */
  async getCharts(): Promise<Chart[]> {
    const data = await this.httpGetJson(`${this.M_HOST}/rank/list&json=true`, { Referer: this.M_REF });
    const list = data?.rank?.list || data?.list || [];
    return list.map((o: any) => ({
      id: String(o.rankid),
      name: o.rankname || '',
      description: '',
    }));
  }

  /**
   * 榜单详情（v19.1）：mobilecdn.kugou.com/api/v3/rank/song?rankid=&page=&pagesize=100
   * m.kugou.com/rank/info 实测服务端硬限 5 页（仅150条），改用 v3 接口分页取全量
   * （TOP500 total=500，5 页×100 条取完；page 翻页推进正常、无重叠）。
   * data.info[] 字段与 v3 搜索一致（hash/320hash/sqhash/songname），parseSong 直接复用
   */
  async getChartDetail(chartId: string): Promise<ChartDetail> {
    const PAGE_SIZE = 100;
    const MAX_PAGES = 6;
    const songs: SearchResult[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await this.httpGetJson(
        `${this.SEARCH_HOST}/rank/song?rankid=${chartId}&page=${page}&pagesize=${PAGE_SIZE}`,
        { Referer: this.M_REF }
      );
      const list = data?.data?.info || [];
      if (!list.length) break;

      let added = 0;
      for (const o of list) {
        const s = this.parseSong({ ...o, album_img: o.album_sizable_cover || o.album_img || '' });
        if (s && !seen.has(s.sourceSongId)) {
          seen.add(s.sourceSongId);
          songs.push(s);
          added++;
        }
      }
      if (added === 0 || list.length < PAGE_SIZE) break;
    }

    return {
      id: String(chartId),
      name: '酷狗榜单',
      description: '',
      songs,
    };
  }

  // ===================== 歌单 =====================

  /**
   * 获取酷狗歌单
   * - 纯数字ID：走 m.kugou.com/plist/list/{id}?json=true（老接口）
   * - 字母数字混合ID：走 m.kugou.com/songlist/gcid_{id}（HTML 页提取 window.$output）
   * - 全程带 ERROR 日志，杜绝静默失败
   */
  /**
   * 按融合固定分类拉取歌单列表（v19.1）
   * 酷狗移动端实测只有热门歌单列表（plist/index，600+ 官方精选歌单）可用；
   * 酷狗未提供免登录的分类-歌单接口（tag/list 仅年龄标签，与歌单广场分类无关），
   * 因此其他分类如实返回空列表，不编造数据。
   */
  async getPlaylistsByCategory(categoryName: string, page = 0): Promise<PlaylistSummary[]> {
    if (categoryName !== '热门推荐') return [];
    try {
      const url = page > 0
        ? `${this.M_HOST}/plist/index&json=true&page=${page}`
        : `${this.M_HOST}/plist/index&json=true`;
      const data = await this.httpGetJson(url, { Referer: this.M_REF });
      const list = data?.plist?.list?.info || [];
      return list
        .map((o: any) => ({
          id: String(o.specialid || o.id || ''),
          title: o.specialname || o.name || '未命名歌单',
          coverUrl: (o.imgurl || '').replace('{size}', '480') || '',
          playCount: typeof o.playcount === 'number' ? o.playcount : undefined,
          trackCount: typeof o.songcount === 'number' ? o.songcount : undefined,
          creator: o.nickname || undefined,
        }))
        .filter((p: PlaylistSummary) => p.id);
    } catch {
      return [];
    }
  }

  async getPlaylist(playlistId: string): Promise<PlaylistDetail> {
    const isAlphanumeric = !/^\d+$/.test(playlistId);

    debugLogger.info('network', `酷狗歌单解析开始`, { playlistId, isAlphanumeric });

    if (isAlphanumeric) {
      return this.getPlaylistFromGcid(playlistId);
    }
    return this.getPlaylistFromPlist(playlistId);
  }

  private async getPlaylistFromPlist(playlistId: string): Promise<PlaylistDetail> {
    const url = `${this.M_HOST}/plist/list/${playlistId}?json=true`;
    debugLogger.info('network', `酷狗 plist 请求`, { url, playlistId });

    let resp: Response | null = null;
    try {
      resp = await this.httpGet(url, { Referer: this.M_REF });
    } catch (err) {
      debugLogger.error('network', `酷狗 plist 请求异常`, {
        url,
        playlistId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, `酷狗歌单请求失败: ${err instanceof Error ? err.message : '未知错误'}`, 502);
    }

    if (!resp) {
      debugLogger.error('network', `酷狗 plist 响应为空`, { url, playlistId });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '酷狗歌单响应为空', 502);
    }

    // 处理 302 重定向：CapacitorHttp 可能不自动跟随，需手动读 Location 重发
    if (resp.status === 301 || resp.status === 302) {
      const location = resp.headers.get('location') || resp.headers.get('Location');
      debugLogger.info('network', `酷狗 plist 收到 ${resp.status}，尝试跟随重定向`, { url, location });
      if (location) {
        try {
          resp = await this.httpGet(location, { Referer: this.M_REF });
        } catch (err) {
          debugLogger.error('network', `酷狗 plist 重定向请求失败`, {
            url,
            location,
            error: err instanceof Error ? err.message : String(err),
          });
          throw new YinliuError(ErrorCode.SOURCE_ERROR, `酷狗歌单重定向失败: ${err instanceof Error ? err.message : '未知错误'}`, 502);
        }
      } else {
        debugLogger.error('network', `酷狗 plist ${resp.status} 无 Location 头`, { url, headers: Object.fromEntries(resp.headers.entries()) });
        throw new YinliuError(ErrorCode.SOURCE_ERROR, `酷狗歌单 ${resp.status} 重定向缺少 Location`, 502);
      }
    }

    if (!resp || !resp.ok) {
      const bodyPreview = await resp?.text().catch(() => '').then(t => t.slice(0, 200));
      debugLogger.error('network', `酷狗 plist 非成功状态码`, {
        url,
        status: resp?.status,
        statusText: resp?.statusText,
        bodyPreview,
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, `酷狗歌单返回 ${resp?.status || 'unknown'}`, resp?.status || 502);
    }

    let data: any;
    try {
      data = await resp.json();
    } catch (err) {
      const bodyPreview = await resp.text().catch(() => '').then(t => t.slice(0, 200));
      debugLogger.error('network', `酷狗 plist JSON 解析失败`, {
        url,
        bodyPreview,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '酷狗歌单响应 JSON 解析失败', 502);
    }

    if (!data) {
      debugLogger.error('network', `酷狗 plist 解析后数据为空`, { url });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '酷狗歌单响应为空', 502);
    }

    const info = data.info?.list || {};
    const songs = data.list?.list?.info || [];

    if (!songs.length) {
      debugLogger.error('network', `酷狗 plist 曲目列表为空`, {
        url,
        dataPreview: JSON.stringify(data).slice(0, 200),
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '酷狗歌单曲目列表为空', 422);
    }

    debugLogger.info('network', `酷狗 plist 解析成功`, { playlistId, songCount: songs.length });

    return {
      id: playlistId,
      name: info.specialname || '酷狗歌单',
      description: info.intro || '',
      coverUrl: (info.imgurl || '').replace('{size}', '400'),
      songs: songs.map((item: any) => this.parseSong(item)).filter(Boolean),
      total: songs.length,
    };
  }

  /**
   * 字母数字混合歌单码走 gcid HTML 页提取
   * 页面内嵌 window.$output = { info: { songs: [...], listinfo: {...} } }
   */
  private async getPlaylistFromGcid(playlistId: string): Promise<PlaylistDetail> {
    const url = `https://m.kugou.com/songlist/gcid_${playlistId}`;
    debugLogger.info('network', `酷狗 gcid 请求`, { url, playlistId });

    let resp: Response | null = null;
    try {
      // gcid 页面对 User-Agent 敏感，必须用移动端 UA 才返回含 window.$output 的 HTML
      resp = await this.httpGet(url, {
        Referer: this.M_REF,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      });
    } catch (err) {
      debugLogger.error('network', `酷狗 gcid 请求异常`, {
        url,
        playlistId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, `酷狗歌单请求失败: ${err instanceof Error ? err.message : '未知错误'}`, 502);
    }

    if (!resp) {
      debugLogger.error('network', `酷狗 gcid 响应为空`, { url, playlistId });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '酷狗歌单响应为空', 502);
    }

    // 处理 302 重定向
    if (resp.status === 301 || resp.status === 302) {
      const location = resp.headers.get('location') || resp.headers.get('Location');
      debugLogger.info('network', `酷狗 gcid 收到 ${resp.status}，尝试跟随重定向`, { url, location });
      if (location) {
        try {
          resp = await this.httpGet(location, { Referer: this.M_REF });
        } catch (err) {
          debugLogger.error('network', `酷狗 gcid 重定向请求失败`, {
            url,
            location,
            error: err instanceof Error ? err.message : String(err),
          });
          throw new YinliuError(ErrorCode.SOURCE_ERROR, `酷狗歌单重定向失败: ${err instanceof Error ? err.message : '未知错误'}`, 502);
        }
      } else {
        debugLogger.error('network', `酷狗 gcid ${resp.status} 无 Location 头`, { url });
        throw new YinliuError(ErrorCode.SOURCE_ERROR, `酷狗歌单 ${resp.status} 重定向缺少 Location`, 502);
      }
    }

    if (!resp || !resp.ok) {
      const bodyPreview = await resp?.text().catch(() => '').then(t => t.slice(0, 200));
      debugLogger.error('network', `酷狗 gcid 非成功状态码`, {
        url,
        status: resp?.status,
        bodyPreview,
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, `酷狗歌单返回 ${resp?.status || 'unknown'}`, resp?.status || 502);
    }

    let html: string;
    try {
      html = await resp.text();
    } catch (err) {
      debugLogger.error('network', `酷狗 gcid 读取响应体失败`, {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '酷狗歌单响应读取失败', 502);
    }

    const extracted = this.extractWindowOutput(html);
    if (!extracted) {
      const bodyPreview = html.slice(0, 200);
      debugLogger.error('network', `酷狗 gcid 未找到 window.\$output`, {
        url,
        bodyPreview,
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '酷狗歌单页面结构解析失败', 502);
    }

    const songs = extracted.info?.songs || [];
    const listinfo = extracted.info?.listinfo || {};

    if (!songs.length) {
      debugLogger.error('network', `酷狗 gcid 曲目列表为空`, {
        url,
        extractedKeys: Object.keys(extracted),
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '酷狗歌单曲目列表为空', 422);
    }

    debugLogger.info('network', `酷狗 gcid 解析成功`, { playlistId, songCount: songs.length });

    // gcid 页面的 song 结构与搜索不同，需做字段映射
    return {
      id: playlistId,
      name: listinfo.name || '酷狗歌单',
      description: listinfo.intro || '',
      coverUrl: (listinfo.pic || '').replace('{size}', '400'),
      songs: songs.map((item: any) => this.parseGcidSong(item)).filter(Boolean),
      total: songs.length,
    };
  }

  /**
   * 从 HTML 中提取 window.$output JSON
   */
  private extractWindowOutput(html: string): any | null {
    const marker = 'window.$output = ';
    const start = html.indexOf(marker);
    if (start === -1) return null;

    let braceStart = start + marker.length;
    while (braceStart < html.length && html[braceStart] !== '{') {
      braceStart++;
    }

    let stack = 0;
    let inString = false;
    let escape = false;
    let i = braceStart;
    while (i < html.length) {
      const c = html[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (c === '\\') {
          escape = true;
        } else if (c === '"') {
          inString = false;
        }
      } else {
        if (c === '"') {
          inString = true;
        } else if (c === '{') {
          stack++;
        } else if (c === '}') {
          stack--;
          if (stack === 0) {
            break;
          }
        }
      }
      i++;
    }

    const jsonStr = html.slice(braceStart, i + 1);
    try {
      return JSON.parse(jsonStr);
    } catch {
      return null;
    }
  }

  /**
   * 解析 gcid 页面的歌曲对象（字段结构与搜索不同）
   */
  private parseGcidSong(o: any): SearchResult | null {
    const hash = (o.hash || '').toString();
    if (!hash) return null;

    const name = (o.name || '').toString().trim();
    if (!name) return null;

    const singers = o.singerinfo || [];
    const artist = singers.map((s: any) => s.name).join('、') || '';

    const dur = parseInt((o.timelen || '0').toString(), 10);
    let cover = (o.cover || '').toString();
    if (cover) cover = cover.replace('{size}', '400');

    // 取最高音质 hash
    const relateGoods = o.relate_goods || [];
    const best = relateGoods.length > 0
      ? relateGoods.reduce((a: any, b: any) => (b.bitrate || 0) > (a.bitrate || 0) ? b : a, relateGoods[0])
      : null;
    const bestHash = best?.hash || hash;
    const hash320 = relateGoods.find((g: any) => g.bitrate === 320)?.hash || '';
    const hashFlac = relateGoods.find((g: any) => g.bitrate > 1000)?.hash || '';

    const id = `kg_${this.nextId++}`;
    const filesizeRaw = parseInt((o.filesize || best?.filesize || '0').toString(), 10);
    const filesize = filesizeRaw > 0 ? filesizeRaw : undefined;
    this.hashCache.set(id, { hash: bestHash, hash320, hashFlac, name, artist, duration: dur, filesize });

    return {
      id,
      type: 'song',
      title: name,
      artist,
      album: (o.albuminfo?.name || '').toString(),
      duration: dur,
      coverUrl: cover,
      sourceId: this.id,
      sourceSongId: id,
      quality: this.inferQuality(hash320, hashFlac),
      bitrate: hashFlac ? 1000 : hash320 ? 320 : 128,
    };
  }

  /**
   * 解析歌单URL
   * 酷狗歌单URL格式：
   *   https://www.kugou.com/yy/special/single/12345.html
   *   https://m.kugou.com/yy/special/single/12345.html
   *   https://www.kugou.com/yy/special/single/12345-zhash.html (带 hash 段，ID 是第一段)
   *   https://m.kugou.com/plist/list/3z9vj1p5zb6z06a (字母数字混合码)
   */
  async parsePlaylistUrl(url: string): Promise<PlaylistDetail> {
    let playlistId: string | null = null;
    // gcid 格式: m.kugou.com/songlist/gcid_xxx
    const gcidMatch = url.match(/songlist[\/]gcid[_]?(\w+)/);
    if (gcidMatch) playlistId = gcidMatch[1];
    else {
      // plist/list 格式（字母数字混合码）
      const plistMatch = url.match(/plist[\/]list[\/](\w+)/);
      if (plistMatch) playlistId = plistMatch[1];
    }
    if (!playlistId) {
      // single/special 格式（纯数字）
      const specialMatch = url.match(/(?:special\/single|special)\/(\d+)/)
        || url.match(/[?&]id=(\d+)/);
      if (specialMatch) playlistId = specialMatch[1];
    }
    if (!playlistId) {
      throw new YinliuError(ErrorCode.VALIDATION_ERROR, '无法解析酷狗歌单URL', 400);
    }
    return this.getPlaylist(playlistId);
  }

  // ===================== 健康检查 =====================

  async healthCheck(): Promise<HealthStatus> {
    try {
      const resp = await platformFetch('https://www.kugou.com', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      return { healthy: resp.ok, message: resp.ok ? '酷狗音乐服务正常' : '服务异常', latency: 0 };
    } catch {
      return { healthy: false, message: '酷狗音乐服务不可用' };
    }
  }
}
