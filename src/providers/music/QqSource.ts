import { BaseHttpSource, type ResolvedCandidate } from './BaseHttpSource';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult, SearchType, SongDetail, HealthStatus, PlayUrlResult, PlaylistSummary, TierSizes, QualityOption, QualityTier, MvQuality, MvUrlResult } from '@core/types';
import { YinliuError, ErrorCode } from '@core/types';

/**
 * QQ音乐音源Provider
 * 接口：u.y.qq.com/cgi-bin/musicu.fcg (统一网关)
 * 音质：13档降级链（母带→杜比→Hi-Res→FLAC→320k→128k...）
 * 并发：官方端点 + 5个第三方代理竞速
 */
export class QqSource extends BaseHttpSource {
  readonly id = 'qq';
  readonly name = 'QQ音乐';
  readonly maxQuality = Quality.HIFI;
  readonly supportedSearchTypes: SearchType[] = ["song", "artist", "album", "mv"];
  private readonly baseUrl = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

  // 13档音质降级链（从高到低）
  private readonly qualityChain: Array<{ quality: Quality; format: string; bitrate: number }> = [
    { quality: Quality.HIFI, format: 'AIM0.mflac', bitrate: 3000 },    // 至臻母带
    { quality: Quality.JYEFFECT, format: 'Q0M1.mflac', bitrate: 2400 }, // 全景声
    { quality: Quality.SKY, format: 'Q0M0.mflac', bitrate: 2400 },     // 杜比
    { quality: Quality.HIRES, format: 'RSM1.mflac', bitrate: 1800 },   // Hi-Res
    { quality: Quality.LOSSLESS, format: 'F0M0.mflac', bitrate: 1000 }, // FLAC
    { quality: Quality.LOSSLESS, format: 'A000.ape', bitrate: 1000 },   // APE
    { quality: Quality.HIGH, format: 'M800.mp3', bitrate: 320 },        // 320K
    { quality: Quality.HIGH, format: 'C600.mp3', bitrate: 320 },        // 320K(备用)
    { quality: Quality.STANDARD, format: 'M500.mp3', bitrate: 128 },    // 128K
    { quality: Quality.STANDARD, format: 'C400.mp3', bitrate: 128 },    // 128K(备用)
    { quality: Quality.LOW, format: 'C200.mp3', bitrate: 48 },          // 48K
  ];

  /**
   * 搜索：支持歌曲/歌手/专辑/MV
   * QQ搜索类型: 0=歌曲, 2=歌手, 8=专辑, 12=MV
   */
  async search(params: SearchParams): Promise<SearchResult[]> {
    const page = params.page || 0;
    const pageSize = params.pageSize || 30;
    const searchType = params.type || 'song';

    // QQ 搜索类型映射
    const qqTypeMap: Record<string, number> = {
      song: 0,
      artist: 2,
      album: 8,
      mv: 12,
    };
    const qqType = qqTypeMap[searchType];
    if (qqType === undefined) return []; // 不支持的类型直接跳过

    const reqBody = {
      req_1: {
        method: 'DoSearchForQQMusicDesktop',
        module: 'music.search.SearchCgiService',
        param: {
          num_per_page: pageSize,
          page_num: page + 1,
          query: params.keyword,
          search_type: qqType,
        },
      },
    };

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Referer': 'https://y.qq.com',
          'Origin': 'https://y.qq.com',
        },
        body: JSON.stringify(reqBody),
      });

      if (!response.ok) {
        return this.fallbackSearch(params);
      }

      const data = await response.json();
      const body = data?.req_1?.data?.body;

      switch (searchType) {
        case 'song': {
          const list = body?.song?.list || [];
          return list.map((item: any) => this.mapSearchResult(item));
        }
        case 'artist': {
          const list = body?.singer?.list || [];
          return list.map((item: any) => this.mapArtistResult(item));
        }
        case 'album': {
          const list = body?.album?.list || [];
          return list.map((item: any) => this.mapAlbumResult(item));
        }
        case 'mv': {
          const list = body?.mv?.list || [];
          return list.map((item: any) => this.mapMvResult(item));
        }
        default:
          return [];
      }
    } catch {
      return this.fallbackSearch(params);
    }
  }

  private fallbackSearch(params: SearchParams): SearchResult[] {
    // 当官方API不可用时，尝试第三方代理搜索
    return [];
  }

  private mapSearchResult(item: any): SearchResult {
    // v19.1：各档文件大小（item.file.size_128mp3/size_320mp3/size_flac/size_hires，字节）
    const f = item.file || {};
    const sizes: TierSizes = {};
    if (parseInt(f.size_128mp3 || '0', 10) > 0) sizes['128k'] = parseInt(f.size_128mp3, 10);
    if (parseInt(f.size_320mp3 || '0', 10) > 0) sizes['320k'] = parseInt(f.size_320mp3, 10);
    if (parseInt(f.size_flac || '0', 10) > 0) sizes['lossless'] = parseInt(f.size_flac, 10);
    if (parseInt(f.size_hires || '0', 10) > 0) sizes['hires'] = parseInt(f.size_hires, 10);

    return {
      id: `qq_${item.mid || item.songmid}`,
      type: 'song',
      title: item.name || item.title || item.songname || '未知歌曲',
      artist: item.singer?.map((s: any) => s.name).join('/') || item.singername || '未知歌手',
      album: item.album?.name || item.albumname || '',
      duration: item.interval || 0,
      coverUrl: item.album?.mid
        ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.album.mid}.jpg`
        : '',
      sourceId: this.id,
      sourceSongId: item.mid || item.songmid || item.id,
      quality: this.inferQuality(item),
      bitrate: item.size128 ? 128 : item.size320 ? 320 : item.sizeflac ? 1000 : 128,
      sizes: Object.keys(sizes).length > 0 ? sizes : undefined,
    };
  }

  /**
   * v19.1 音质弹窗实时查询：海棠 resolve-url 按 level 取直链（实测无 size 字段），
   * 再对直链 Range 探测真实文件大小；档位按 URL 文件前缀判定（防降级错归组）。
   * 前缀：M500=128K mp3，M800=320K mp3，F000/A000=无损，RS01=Hi-Res。
   * 文档：QQ音乐接口完整文档 §3.4 海棠resolve-url（实测可用）。
   */
  async getQualityOptions(songId: string): Promise<QualityOption[]> {
    const mid = songId.replace(/^qq_/, '');
    if (!mid) return [];
    const levels: Array<{ level: string; fallback: QualityTier }> = [
      { level: 'standard', fallback: '128k' },
      { level: 'exhigh', fallback: '320k' },
      { level: 'lossless', fallback: 'lossless' },
      { level: 'hires', fallback: 'hires' },
    ];

    const settled = await Promise.allSettled(
      levels.map(async ({ level, fallback }) => {
        const resp = await fetch('https://musicserver.haitangw.cc/v1/music/resolve-url', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Referer': 'https://musicserver.haitangw.cc/',
          },
          body: JSON.stringify({ source: 'tx', rid: mid, level }),
        });
        if (!resp.ok) return null;
        const body = await resp.json().catch(() => null);
        const url: string | undefined = body?.data?.url || body?.url;
        if (!url) return null;

        // 档位按直链文件前缀判定（比请求 level 更真实，能识别降级）
        let tier: QualityTier = fallback;
        const m = url.match(/\/([A-Z]?\d{4}|RS01|AIM0|Q0M1|Q0M0)[A-Za-z0-9]*\.(mp3|flac|m4a|ape|ogg|mgg|mflac)/i);
        const prefix = m?.[1]?.toUpperCase() || '';
        if (prefix === 'RS01' || prefix === 'AIM0') tier = 'hires';
        else if (prefix === 'F000' || prefix === 'A000') tier = 'lossless';
        else if (prefix === 'M800') tier = '320k';
        else if (prefix === 'M500') tier = '128k';

        // Range 探测真实大小（best-effort）
        let sizeBytes: number | undefined;
        try {
          const probe = await fetch(url, {
            method: 'GET',
            headers: { Range: 'bytes=0-1', Referer: 'https://y.qq.com' },
            signal: AbortSignal.timeout(8000),
          });
          // 仅接受 206（Range 成功）或 200（整文件）响应；404/403 等错误体不采信
          const valid = probe.status === 206 || probe.status === 200;
          const range = probe.headers.get('content-range') || probe.headers.get('content-length');
          if (valid && range?.startsWith('bytes')) {
            const total = parseInt(range.split('/')[1] || '0', 10) || 0;
            if (total > 65536) sizeBytes = total;
          } else if (valid && range) {
            const total = parseInt(range, 10) || 0;
            if (total > 65536) sizeBytes = total;
          }
          probe.body?.cancel().catch(() => {});
        } catch {
          // 大小探测失败不影响选项本身（无大小块）
        }
        return { sourceId: this.id, sourceName: this.name, tier, format: m?.[2], sizeBytes };
      })
    );

    const seen = new Set<string>();
    const options: QualityOption[] = [];
    for (const r of settled) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      if (seen.has(r.value.tier)) continue;
      seen.add(r.value.tier);
      options.push(r.value);
    }
    return options;
  }

  private mapArtistResult(item: any): SearchResult {
    const mid = item.mid || item.singer_mid || '';
    return {
      id: `qq_artist_${mid}`,
      type: 'artist',
      title: item.name || item.singer_name || '未知歌手',
      artist: item.name || item.singer_name || '',
      coverUrl: mid ? `https://y.gtimg.cn/music/photo_new/T001R300x300M000${mid}.jpg` : '',
      sourceId: this.id,
      sourceSongId: mid,
    };
  }

  private mapAlbumResult(item: any): SearchResult {
    const mid = item.mid || item.album_mid || '';
    return {
      id: `qq_album_${mid}`,
      type: 'album',
      title: item.name || item.album_name || '未知专辑',
      artist: item.singer_name || item.singer?.map((s: any) => s.name).join('/') || '',
      subtitle: item.singer_name || item.singer?.map((s: any) => s.name).join('/') || '',
      coverUrl: mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${mid}.jpg` : '',
      sourceId: this.id,
      sourceSongId: mid,
    };
  }

  private mapMvResult(item: any): SearchResult {
    const vid = item.v_id || item.vid || '';
    return {
      id: `qq_mv_${vid}`,
      type: 'mv',
      title: item.name || item.mv_name || item.title || '未知MV',
      artist: item.singer_name || item.singer?.map((s: any) => s.name).join('/') || '',
      subtitle: item.singer_name || item.singer?.map((s: any) => s.name).join('/') || '',
      duration: item.interval || item.duration || 0,
      coverUrl: item.pic || item.cover || '',
      sourceId: this.id,
      sourceSongId: vid,
      mvUrl: vid ? `https://y.qq.com/n/ryqq/mv/${vid}` : undefined,
    };
  }

  private inferQuality(item: any): Quality {
    const f = item.file || {};
    if (item.sizehires || item.sizeatmos || f.size_hires) return Quality.HIFI;
    if (item.sizeflac || f.size_flac) return Quality.LOSSLESS;
    if (item.size320 || f.size_320mp3) return Quality.HIGH;
    return Quality.STANDARD;
  }

  /**
   * 获取歌曲详情
   */
  // ===================== MV 取链（v19.2）=====================

  /**
   * 获取 MV 播放地址
   * module: gosrf.Stream.MvUrlProxy, method: GetMvUrls
   * 支持画质: 10(240P)/20(480P)/30(720P)/40(1080P)/50(4K)
   */
  async getMvUrl(vid: string, quality: MvQuality): Promise<MvUrlResult | null> {
    const id = vid.replace(/^qq_mv_/, '');
    const reqBody = {
      comm: { ct: 24, guid: '10000' },
      req: {
        module: 'gosrf.Stream.MvUrlProxy',
        method: 'GetMvUrls',
        param: {
          vids: [id],
          request_typet: 10001,
          guid: '10000',
        },
      },
    };

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Referer': 'https://y.qq.com',
        },
        body: JSON.stringify(reqBody),
      });

      if (!response.ok) return null;
      const data = await response.json();
      const mp4List = data?.req?.data?.[id]?.mp4 || [];
      if (!mp4List.length) return null;

      const targetFiletype = this.mvQualityToFiletype(quality);
      const match = mp4List.find((m: any) => m.filetype === targetFiletype);
      if (!match) return null;

      const url = match.freeflow_url?.[0] || match.url?.[0];
      if (!url) return null;

      return {
        url,
        quality,
        size: match.file_size,
        duration: match.duration,
      };
    } catch {
      return null;
    }
  }

  /**
   * 获取 MV 可用画质列表
   * QQ 接口一次返回所有画质，直接解析 mp4[] 数组
   */
  async getMvQualities(vid: string): Promise<MvQuality[]> {
    const id = vid.replace(/^qq_mv_/, '');
    const reqBody = {
      comm: { ct: 24, guid: '10000' },
      req: {
        module: 'gosrf.Stream.MvUrlProxy',
        method: 'GetMvUrls',
        param: {
          vids: [id],
          request_typet: 10001,
          guid: '10000',
        },
      },
    };

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Referer': 'https://y.qq.com',
        },
        body: JSON.stringify(reqBody),
      });

      if (!response.ok) return [];
      const data = await response.json();
      const mp4List = data?.req?.data?.[id]?.mp4 || [];
      const qualities = mp4List
        .map((m: any) => this.filetypeToMvQuality(m.filetype))
        .filter(Boolean) as MvQuality[];
      const unique = Array.from(new Set(qualities));
      unique.sort((a, b) => mvQualityRank(b) - mvQualityRank(a));
      return unique;
    } catch {
      return [];
    }
  }

  private mvQualityToFiletype(q: MvQuality): number {
    switch (q) {
      case '240p': return 10;
      case '480p': return 20;
      case '720p': return 30;
      case '1080p': return 40;
      case '4k': return 50;
      default: return 20;
    }
  }

  private filetypeToMvQuality(ft: number): MvQuality | null {
    switch (ft) {
      case 10: return '240p';
      case 20: return '480p';
      case 30: return '720p';
      case 40: return '1080p';
      case 50: return '4k';
      default: return null;
    }
  }

  async getSongDetail(songId: string): Promise<SongDetail> {
    const reqBody = {
      req_1: {
        method: 'GetSongInfoDetail',
        module: 'music.pf_song_detail',
        param: {
          song_mid: songId,
        },
      },
    };

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Referer': 'https://y.qq.com',
        },
        body: JSON.stringify(reqBody),
      });

      if (!response.ok) {
        return this.buildDetailFromId(songId);
      }

      const data = await response.json();
      const track = data?.req_1?.data?.track_info;

      if (!track) {
        return this.buildDetailFromId(songId);
      }

      return {
        id: songId,
        title: track.name || '未知歌曲',
        artist: track.singer?.map((s: any) => s.name).join('/') || '',
        album: track.album?.name || '',
        duration: track.interval || 0,
        coverUrl: track.album?.mid
          ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${track.album.mid}.jpg`
          : '',
      };
    } catch {
      return this.buildDetailFromId(songId);
    }
  }

  private buildDetailFromId(songId: string): SongDetail {
    return {
      id: songId,
      title: 'QQ音乐歌曲',
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
    const reqBody = {
      req_1: {
        method: 'GetPlayLyricInfo',
        module: 'music.musichallSongPlayLyricInfo',
        param: {
          songMID: songId,
        },
      },
    };

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Referer': 'https://y.qq.com',
        },
        body: JSON.stringify(reqBody),
      });

      if (!response.ok) return null;

      const data = await response.json();
      const lyric = data?.req_1?.data?.lyric;
      return lyric || null;
    } catch {
      return null;
    }
  }

  /**
   * QQ 歌单广场分类标签树缓存：分类名 → categoryId（fcg_get_diss_tag_conf 拉一次复用）
   */
  private qqTagIdCache: Map<string, number> | null = null;

  /** QQ 标签树里没有同名的融合分类 → QQ 官方分类名 */
  private static readonly QQ_TAG_ALIASES: Record<string, string> = {
    热门推荐: '全部',
    华语: '国语',
    欧美: '英语',
    日韩: '日语',
    说唱: '嘻哈',
    影视原声: '影视',
  };

  private async resolveQqTagIds(): Promise<Map<string, number>> {
    if (this.qqTagIdCache) return this.qqTagIdCache;
    const map = new Map<string, number>();
    try {
      const qs =
        'picmid=1&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0';
      const response = await fetch(`https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg?${qs}`, {
        headers: { Referer: 'https://c.y.qq.com/' },
      });
      if (response.ok) {
        const data = await response.json();
        for (const group of data?.data?.categories || []) {
          for (const item of group?.items || []) {
            if (item?.categoryName && item?.categoryId != null) {
              map.set(String(item.categoryName), Number(item.categoryId));
            }
          }
        }
      }
    } catch {
      /* 缓存留空，匹配不到时返回空列表 */
    }
    this.qqTagIdCache = map;
    return map;
  }

  /**
   * 按融合固定分类拉取歌单列表（v19.1 走 QQ 官方歌单广场接口，不再只有推荐Feed）：
   * - 分类树：fcg_get_diss_tag_conf.fcg（语种/流派/主题/心情/场景 全量官方分类）
   * - 分类-歌单列表：fcg_get_diss_by_tag.fcg?categoryId=&sortId=5（官方歌单广场按分类取歌单）
   * 注意：QQ 无「日韩」合并分类，只有日语/韩语两个独立分类，此处按相近原则映射到「日语」。
   */
  async getPlaylistsByCategory(categoryName: string, page = 0): Promise<PlaylistSummary[]> {
    try {
      const tagMap = await this.resolveQqTagIds();
      const wanted = QqSource.QQ_TAG_ALIASES[categoryName] || categoryName;
      const categoryId = tagMap.get(wanted);
      if (!categoryId) return [];

      const sin = page * 30;
      const qs = new URLSearchParams({
        picmid: '1',
        rnd: String(Math.random()),
        g_tk: '5381',
        loginUin: '0',
        hostUin: '0',
        format: 'json',
        inCharset: 'utf8',
        outCharset: 'utf-8',
        notice: '0',
        platform: 'yqq',
        needNewCode: '0',
        categoryId: String(categoryId),
        sortId: '5',
        sin: String(sin),
        ein: String(sin + 29),
      });
      const response = await fetch(`https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?${qs.toString()}`, {
        headers: { Referer: 'https://c.y.qq.com/' },
      });
      if (!response.ok) return [];
      const data = await response.json();
      const list = data?.data?.list || [];
      return list
        .map((item: any) => ({
          id: String(item.dissid || ''),
          title: item.dissname || item.diss_name || '未命名歌单',
          coverUrl: item.imgurl || item.logo || '',
          playCount: Number(item.listennum) > 0 ? Number(item.listennum) : undefined,
          creator: item.nickname || item.creator?.nick || undefined,
        }))
        .filter((p: PlaylistSummary) => p.id);
    } catch {
      return [];
    }
  }

  /**
   * 获取歌单详情
   */
  async getPlaylist(playlistId: string) {
    const reqBody = {
      req_1: {
        method: 'GetPlaylistDetail',
        module: 'music.srfDissInfo.DissInfo',
        param: {
          disstid: playlistId,
          dirid: 0,
          song_num: 100,
        },
      },
    };

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Referer': 'https://y.qq.com',
        },
        body: JSON.stringify(reqBody),
      });

      if (!response.ok) {
        throw new YinliuError(ErrorCode.SOURCE_ERROR, '获取歌单失败', 502);
      }

      const data = await response.json();
      const cdlist = data?.req_1?.data?.cdlist?.[0];

      return {
        id: playlistId,
        name: cdlist?.dissname || 'QQ音乐歌单',
        description: cdlist?.desc || '',
        coverUrl: cdlist?.logo || '',
        songs: (cdlist?.songlist || []).map((item: any) => this.mapSearchResult(item)),
        total: cdlist?.songlist?.length || 0,
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
    // QQ音乐歌单URL格式：
    // https://y.qq.com/n/ryqq/playlist/1234567890
    // https://i.y.qq.com/n2/m/share/details/taoge.html?platform=11&appshare=android&appversion=11040008&hosteuin=...&id=1234567890
    const match = url.match(/(?:playlist|id)[/=](\d+)/);
    if (!match) {
      throw new YinliuError(ErrorCode.VALIDATION_ERROR, '无法解析QQ音乐歌单URL', 400);
    }
    return this.getPlaylist(match[1]);
  }

  /**
   * 构建取链候选端点
   * 包含：官方Vkey端点 + 第三方代理
   * v27(F1/P0-1a)：全部候选带 resolve 解析函数——此前把 musicu.fcg 请求 URL / 代理
   * JSON 响应直接当音频链返回，是 QQ 坏链（1395 字节 JSON 抢先胜出）的根因
   */
  protected buildEndpointCandidates(songId: string, quality: Quality): ResolvedCandidate[] {
    const candidates: ResolvedCandidate[] = this.buildOfficialEndpoints(songId, quality);
    candidates.push(...this.buildProxyEndpoints(songId, quality));
    return candidates;
  }

  private buildOfficialEndpoints(songId: string, quality: Quality): ResolvedCandidate[] {
    const endpoints: ResolvedCandidate[] = [];
    const targetFormats = this.getFormatsForQuality(quality);

    for (const fmt of targetFormats) {
      // GetVkeyServer 明文档取链
      const vkeyUrl = this.buildVkeyUrl(songId, fmt.format);
      const fmtSnapshot = { ...fmt };
      endpoints.push({
        url: vkeyUrl,
        method: 'GET',
        timeout: 8000,
        priority: 1,
        headers: {
          'Referer': 'https://y.qq.com',
        },
        resolve: (response) => this.resolveOfficialVkey(response, quality, fmtSnapshot),
      });
    }

    return endpoints;
  }

  /**
   * F1(v27 P0-1a)：官方 GetVkeyServer 响应解析。
   * musicu.fcg 返回 JSON 协议体——提取 req_2.data.midurlinfo[0].purl 拼 CDN 域名
   * （req_2.data.sip[0]）成真实直链；purl 为空/提取失败一律 return null 判候选失败。
   * 字段路径按真实响应防御性兼容；音质档位请求逻辑不动（守住产品决策口径）。
   */
  private async resolveOfficialVkey(
    response: Response,
    targetQuality: Quality,
    fmt: { format: string; bitrate: number }
  ): Promise<PlayUrlResult | null> {
    try {
      const data = await response.json();
      const midurlinfo = data?.req_2?.data?.midurlinfo?.[0];
      const purl: string = typeof midurlinfo?.purl === 'string' ? midurlinfo.purl : '';
      if (!purl) return null;

      let url: string;
      if (/^https?:\/\//i.test(purl)) {
        url = purl;
      } else {
        const sip = Array.isArray(data?.req_2?.data?.sip)
          ? data.req_2.data.sip.find((s: unknown): s is string => typeof s === 'string' && /^https?:\/\//i.test(s))
          : '';
        if (!sip) return null;
        url = `${sip}${purl}`;
      }
      if (!/^https?:\/\//i.test(url)) return null;

      // 实际格式以 purl 文件后缀为准（请求档与实际回盘可能不一致）
      const actualExt = url.split('?')[0].split('.').pop()?.toLowerCase() || fmt.format.split('.').pop() || 'mp3';
      // 命中所请求档位格式前缀（如 M800/F000/RS01）才算音质准确，否则交竞速层兜底
      const requestedPrefix = fmt.format.split('.')[0];
      const accurate = url.includes(requestedPrefix);

      return {
        url,
        quality: targetQuality,
        bitrate: fmt.bitrate,
        format: actualExt,
        headers: { 'Referer': 'https://y.qq.com' },
        accurate,
      };
    } catch {
      // JSON 解析失败/字段缺失 → 判候选失败
      return null;
    }
  }

  private buildProxyEndpoints(songId: string, quality: Quality): ResolvedCandidate[] {
    // v29 B1：海棠 resolve-url 改为 POST 携带 level——此前 GET 候选不带任何音质参数，
    // 代理固定回 128k/320k，也是「选高音质实际拿低码率」的来源之一。
    // 其余代理仍为 GET（无档位参数，回盘音质不可控，accurate=false 交竞速层兜底）。
    const mid = songId.replace(/^qq_/, '');
    const proxyUrls = [
      // 海棠代理
      `https://musicapi.haitangw.net/music/qq.php?id=${songId}`,
      // metingapi代理
      `https://metingapi.nanorocky.top/?server=tencent&type=url&id=${songId}`,
      // vkeys代理
      `https://api.vkeys.cn/?server=tencent&type=url&id=${songId}`,
    ];

    const candidates: ResolvedCandidate[] = proxyUrls.map((url): ResolvedCandidate => ({
      url,
      method: 'GET',
      timeout: 10000,
      priority: 2,
      // F1(v27)：代理返回 JSON/文本，从中提取第一条音频直链；提取失败判候选失败。
      // 代理回盘音质不可控，标记 accurate=false 交由竞速层兜底降级
      resolve: (response) => this.resolveProxyResponse(response, quality),
    }));

    // 海棠 resolve-url（POST + level，与 getQualityOptions 同一端点同一参数口径）
    if (mid) {
      candidates.push({
        url: 'https://musicserver.haitangw.cc/v1/music/resolve-url',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Referer': 'https://musicserver.haitangw.cc/',
        },
        body: JSON.stringify({ source: 'tx', rid: mid, level: qqLevelForQuality(quality) }),
        timeout: 10000,
        priority: 2,
        resolve: (response) => this.resolveProxyResponse(response, quality),
      });
    }

    return candidates;
  }

  /**
   * F1(v27)：代理响应通用解析——从 JSON/文本响应中提取第一条音频直链。
   * 此前代理 JSON 响应体被直接当音频链返回（坏链同源问题）。
   */
  private async resolveProxyResponse(response: Response, targetQuality: Quality): Promise<PlayUrlResult | null> {
    let text = '';
    try {
      text = await response.text();
    } catch {
      return null;
    }
    const url = extractFirstAudioUrl(text);
    if (!url) return null;

    const ext = url.split('?')[0].split('.').pop()?.toLowerCase() || '';
    const knownExts = new Set(['mp3', 'flac', 'm4a', 'aac', 'ape', 'ogg', 'wav', 'mgg', 'mflac']);
    return {
      url,
      quality: targetQuality,
      bitrate: this.estimateBitrate(null, targetQuality),
      format: knownExts.has(ext) ? ext : 'mp3',
      accurate: false,
    };
  }

  private buildVkeyUrl(songId: string, format: string): string {
    const guid = Math.floor(Math.random() * 1000000000);
    const reqBody = {
      req_1: {
        method: 'GetCdnDispatch',
        module: 'CDN.SrfCdnDispatchServer',
        param: {
          calltype: 0,
          guid: guid.toString(),
          uin: '0',
          songtype: [0],
          songmid: [songId],
        },
      },
      req_2: {
        method: 'GetVkeyServer',
        module: 'vkey.GetVkeyServer',
        param: {
          guid: guid.toString(),
          songmid: [songId],
          songtype: [0],
          uin: '0',
          loginflag: 0,
          platform: '20',
          // v29 B1（关键修复）：必须用 filename 指定音质档位（形如 RS01{mid}.flac / M800{mid}.mp3）。
          // 此前缺省该参数，网关一律回落默认档（128k M500.mp3）——这就是
          // 「选 Hi-Res/无损实际返回 128k 低码率」的根因。
          filename: [buildQqFilename(format, songId)],
        },
      },
    };

    return `${this.baseUrl}?format=json&data=${encodeURIComponent(JSON.stringify(reqBody))}`;
  }

  private getFormatsForQuality(quality: Quality): Array<{ format: string; bitrate: number }> {
    const rank = this.getQualityRank(quality);
    return this.qualityChain.filter((q) => this.getQualityRank(q.quality) <= rank);
  }

  private getQualityRank(q: Quality): number {
    const map: Record<Quality, number> = {
      [Quality.LOW]: 1,
      [Quality.STANDARD]: 2,
      [Quality.HIGHER]: 3,
      [Quality.HIGH]: 4,
      [Quality.LOSSLESS]: 5,
      [Quality.HIRES]: 6,
      [Quality.SKY]: 7,
      [Quality.JYEFFECT]: 8,
      [Quality.HIFI]: 9,
      [Quality.ZHIZHEN]: 10,
      [Quality.DOLBY]: 11,
      [Quality.MASTER]: 12,
    };
    return map[q] || 2;
  }

  /**
   * 获取排行榜列表（v19.1 修正）
   * 实测：module 必须为 musicToplist.ToplistInfoServer（小写 toplist 返回 500003），
   * method=GetAll，榜单在 data.group[].toplist[]（含 topId/title），原 GetToplistList+list 路径取不到数据
   */
  async getCharts() {
    try {
      const reqBody = {
        comm: { ct: '24', cv: '0' },
        req_1: {
          method: 'GetAll',
          module: 'musicToplist.ToplistInfoServer',
          param: {},
        },
      };

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Referer': 'https://y.qq.com' },
        body: JSON.stringify(reqBody),
      });

      if (!response.ok) return [];

      const data = await response.json();
      const groups = data?.req_1?.data?.group || [];
      const charts: Array<{ id: string; name: string; description?: string }> = [];

      for (const group of groups) {
        for (const item of group.toplist || group.list || []) {
          const id = item.topId?.toString() || item.id;
          const name = item.title || item.listName || item.name;
          if (!id || !name) continue;
          charts.push({
            id,
            name,
            description: group.groupName,
          });
        }
      }

      return charts;
    } catch {
      return [];
    }
  }

  /**
   * 获取排行榜详情（v19.1 修正+分页取全量）
   * 实测：module=musicToplist.ToplistInfoServer（小写 toplist 返回 500003），
   * 歌曲在 data.songInfoList（原 songInfo.list 路径永远为空）；
   * 分页 param{offset,num:100} 循环取全量（最多 5 页 / 500 条），不得只取第一页
   */
  async getChartDetail(chartId: string) {
    const PAGE_SIZE = 100;
    const MAX_PAGES = 5;
    const topId = parseInt(chartId, 10);
    const songs: SearchResult[] = [];
    const seen = new Set<string>();

    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const reqBody = {
          comm: { ct: '24', cv: '0' },
          req_1: {
            method: 'GetDetail',
            module: 'musicToplist.ToplistInfoServer',
            param: {
              topId,
              offset: page * PAGE_SIZE,
              num: PAGE_SIZE,
              period: '',
            },
          },
        };

        const response = await fetch(this.baseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Referer': 'https://y.qq.com' },
          body: JSON.stringify(reqBody),
        });

        if (!response.ok) {
          if (page === 0) throw new YinliuError(ErrorCode.SOURCE_ERROR, '获取排行榜失败', 502);
          break;
        }

        const data = await response.json();
        const songList = data?.req_1?.data?.songInfoList || [];
        if (!songList.length) break;

        let added = 0;
        for (const item of songList) {
          const s = this.mapSearchResult({
            ...item,
            // 榜单接口音质档在 item.file（size_128mp3 等），映射成搜索接口的顶层字段
            size128: item.size128 || item.file?.size_128mp3 || 0,
            size320: item.size320 || item.file?.size_320mp3 || 0,
            sizeflac: item.sizeflac || item.file?.size_flac || 0,
            sizehires: item.sizehires || item.file?.size_hires || 0,
          });
          if (s && !seen.has(s.sourceSongId)) {
            seen.add(s.sourceSongId);
            songs.push(s);
            added++;
          }
        }
        if (songList.length < PAGE_SIZE) break;
      }

      return {
        id: chartId,
        name: 'QQ音乐排行榜',
        songs,
      };
    } catch (err) {
      if (err instanceof YinliuError) throw err;
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '获取排行榜失败', 502);
    }
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<HealthStatus> {
    try {
      const response = await fetch('https://y.qq.com', {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      return {
        healthy: response.ok,
        message: response.ok ? 'QQ音乐服务正常' : 'QQ音乐服务异常',
        latency: 0,
      };
    } catch {
      return { healthy: false, message: 'QQ音乐服务不可用' };
    }
  }
}

/**
 * F1(v27)：从任意 JSON/文本响应中提取第一条音频直链。
 * 匹配 http(s) URL 且以已知音频扩展名结尾（不含引号/空白/HTML 标签边界）。
 */
function extractFirstAudioUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s"'<>\\]+/g);
  if (!matches) return null;
  for (const raw of matches) {
    const url = raw.replace(/[),.;!]+$/, '');
    if (/\.(mp3|flac|m4a|aac|ape|ogg|wav|mgg|mflac|mflac0|mgg1)(\?|#|$)/i.test(url)) {
      return url;
    }
  }
  return null;
}

/**
 * v29 B1：由档位格式串构造 GetVkeyServer 的 filename 参数。
 * format 形如 'RSM1.mflac' / 'M800.mp3' / 'F0M0.mflac' → filename 'RSM1{mid}.mflac' 等。
 * 官方网关靠该文件名前缀识别请求档位；缺省即回落 128k 默认档（B1 根因）。
 * 纯函数导出，供单测直接覆盖（tests/v29-quality-priority.test.mjs）。
 */
export function buildQqFilename(format: string, songId: string): string {
  const dotIdx = format.indexOf('.');
  const prefix = dotIdx === -1 ? format : format.slice(0, dotIdx);
  const ext = dotIdx === -1 ? 'mp3' : format.slice(dotIdx + 1);
  return `${prefix}${songId}.${ext}`;
}

/**
 * v29 B1：目标音质档 → 海棠 resolve-url 的 level 参数。
 * 代理候选此前完全不带音质参数（固定回 128k/320k），B1 起按目标档位传 level。
 * 纯函数导出，供单测直接覆盖。
 */
export function qqLevelForQuality(quality: Quality): string {
  const rank = qualityRankOf(quality);
  if (rank >= 6) return 'hires';      // Hi-Res 及以上
  if (rank >= 5) return 'lossless';   // 无损
  if (rank >= 3) return 'exhigh';     // 320k/192k
  return 'standard';                  // 128k 及以下
}

function qualityRankOf(q: Quality): number {
  const map: Partial<Record<Quality, number>> = {
    [Quality.LOW]: 1,
    [Quality.STANDARD]: 2,
    [Quality.HIGHER]: 3,
    [Quality.HIGH]: 4,
    [Quality.LOSSLESS]: 5,
    [Quality.HIRES]: 6,
    [Quality.SKY]: 7,
    [Quality.JYEFFECT]: 8,
    [Quality.HIFI]: 9,
    [Quality.ZHIZHEN]: 10,
    [Quality.DOLBY]: 11,
    [Quality.MASTER]: 12,
  };
  return map[q] || 2;
}

function mvQualityRank(q: MvQuality): number {
  const map: Record<MvQuality, number> = { '240p': 1, '480p': 2, '720p': 3, '1080p': 4, '4k': 5 };
  return map[q] || 0;
}
