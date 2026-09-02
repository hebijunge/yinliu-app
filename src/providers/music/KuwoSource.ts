import { BaseHttpSource } from './BaseHttpSource';
import { Quality, YinliuError, ErrorCode } from '@core/types';
import type { SearchParams, SearchResult, SongDetail, HealthStatus, PlayUrlResult, PlaylistDetail, Chart, ChartDetail, PlaylistSummary, QualityOption, QualityTier, TierSizes } from '@core/types';
import type { ResolvedCandidate } from './BaseHttpSource';
import { platformFetch } from '@shared/utils/platformFetch';
import { debugLogger } from '@shared/utils/debugLogger';

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
 *
 * 音质档实测结论（2026-08-27）：
 *  - 128kmp3：✅ 真 128k MP3
 *  - 320kmp3：✅ 真 320k MP3（有免费档的歌）
 *  - 2000kflac：✅ 真 FLAC 无损
 *  - 4000kflac：⚠️ 行为不确定（降级128k或加密mflac）
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
  private readonly ALBUM_COVER_BASE = 'https://img4.kuwo.cn/star/albumcover/';
  private readonly NMOBI_UA = 'kwplayerhd_ar_4.3.0.8_tianbao_T1A_qirui';

  // 缓存
  private songMetaCache = new Map<string, { name: string; artist: string }>();
  private durationCache = new Map<string, number>();

  /**
   * accurate 竞速优先级判定：accurate !== false 视为可优先选用的结果。
   * 酷我官方源按码率精确匹配标记 accurate；海棠降级链标记 accurate: false。
   */
  protected isAccurateResult(result: PlayUrlResult): boolean {
    return result.accurate !== false;
  }

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
    const minfo = (o.N_MINFO || o.MINFO || o.minfo || '').toString();
    // v16 封面修复：搜索列表部分条目不显示图片的根因——
    // 旧逻辑用「歌手图」字段 web_artistpic_short 拼 starheads 前缀，多数歌曲没有歌手图，
    // 拼出来还是 404。改为优先专辑图（web_albumpic_short → albumcover 域名，实测 200/无 Referer），
    // 其次移动端 MVPIC（完整 https 直链），最后才回退歌手图。
    const albumPic = (o.web_albumpic_short || o.web_albumpic || '').toString();
    const artistPic = (o.web_artistpic_short || o.web_artistpic || '').toString();
    const mvpic = (o.hts_MVPIC || o.MVPIC || '').toString();
    let cover = '';
    if (albumPic) {
      // 尺寸段 120 → 500 升清（实测 albumcover 域名 500 路径同样 200）
      cover = `${this.ALBUM_COVER_BASE}${albumPic.replace(/^120\//, '500/')}`;
    } else if (mvpic.startsWith('http')) {
      cover = mvpic;
    } else if (artistPic) {
      cover = `${this.COVER_BASE}${artistPic}`;
    }

    // 缓存元数据用于取链
    this.songMetaCache.set(rid, { name, artist });
    this.durationCache.set(rid, dur);

    // v19.1：搜索结果的音质大小（MINFO 各档 bitrate+size）——音质弹窗展示用
    const { sizes } = this.parseMinfoSizes(minfo);

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
      sizes: Object.keys(sizes).length > 0 ? sizes : undefined,
    };
  }

  /**
   * v19.1 解析酷我 MINFO/N_MINFO 音质信息串。
   * 格式（分号分隔各档，逗号分隔 key:value）：
   *   level:ff,bitrate:2000,format:flac,size:52.83Mb;level:p,bitrate:320,format:mp3,size:10.29Mb;...
   * size 带 Mb 后缀，实测为 MiB（29.72Mb ↔ 31168013 字节）。
   */
  private parseMinfoSizes(minfo: string): { sizes: TierSizes } {
    const sizes: TierSizes = {};
    if (!minfo) return { sizes };
    for (const seg of minfo.split(';')) {
      const kv: Record<string, string> = {};
      for (const part of seg.split(',')) {
        const i = part.indexOf(':');
        if (i > 0) kv[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
      }
      const br = parseInt((kv.bitrate || '').replace(/[^\d]/g, ''), 10) || 0;
      const szMb = parseFloat((kv.size || '').replace(/[^\d.]/g, '')) || 0;
      if (br <= 0 || szMb <= 0) continue;
      let tier: QualityTier;
      if (br >= 10000) tier = 'hires';        // zpga* 母带（mflac 20201 等）
      else if (br >= 900) tier = 'lossless';  // ff=2000 flac
      else if (br >= 320) tier = '320k';      // p=320
      else if (br >= 192) tier = '192k';
      else tier = '128k';                     // h=128
      if (!sizes[tier]) sizes[tier] = Math.round(szMb * 1048576);
    }
    return { sizes };
  }

  /**
   * v19.1 音质弹窗实时查询：musicpay 免登录详情，返回各档 MINFO（bitrate+size）。
   * 文档：酷我接口完整文档 §6.1 musicpay 免登录详情（免登录，200 实测可用）。
   */
  async getQualityOptions(songId: string): Promise<QualityOption[]> {
    const rid = songId.replace(/^kw_/, '');
    if (!rid || !/^\d+$/.test(rid)) return [];
    const url = `https://musicpay.kuwo.cn/music.pay?src=kwplayer_ar_11.3.0.0_40.apk&op=query&action=play&ids=${rid}`;
    try {
      const resp = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!resp.ok) return [];
      const data = await resp.json().catch(() => null);
      const song = data?.songs?.[0];
      const minfo = (song?.N_MINFO || song?.MINFO || '').toString();
      const { sizes } = this.parseMinfoSizes(minfo);
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

    if (!cached?.name) {
      throw new Error(`酷我歌曲详情获取失败：rid=${rid} 无缓存元数据`);
    }

    return {
      id: songId,
      title: cached.name,
      artist: cached.artist || '',
      album: '',
      duration: 0,
      coverUrl: '',
    };
  }

  // ===================== 取链（核心）=====================
  // getPlayUrl 使用 BaseHttpSource 的优化版 linkRace（并行竞速 + 成功通道记忆 + 去重锁）

  protected buildEndpointCandidates(songId: string, quality: Quality): ResolvedCandidate[] {
    const rid = songId.replace(/^kw_/, '');
    const br = this.brOf(quality);
    const expected = this.qualityExpectation(quality);

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
        resolve: async (resp) => this.resolveNmobi(resp, quality, expected),
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
        return { url, quality, bitrate: 128, format: 'mp3', accurate: quality === Quality.LOW || quality === Quality.STANDARD };
      },
    });

    // 海棠第三方代理（超时 3 秒，不阻塞主链路）
    const level = this.haitangLevel(quality);
    const expectedBitrate = this.brToBitrate(br);
    candidates.push({
      url: `${this.HAITANG_HOST}/music/kw.php?id=${rid}&level=${level}&type=mp3`,
      method: 'GET',
      timeout: 3000,
      priority: 2,
      key: 'haitang',
      resolve: async (resp) => {
        const ct = resp.headers.get('content-type') || '';
        if (!ct.includes('audio') && !ct.includes('octet-stream')) return null;
        const url = `${this.HAITANG_HOST}/music/kw.php?id=${rid}&level=${level}&type=mp3`;
        return { url, quality, bitrate: expectedBitrate, format: 'mp3', accurate: this.isBitrateAccurate(quality, expectedBitrate) };
      },
    });

    return candidates;
  }

  /** nmobi JSON解析，带精确音质校验 */
  private async resolveNmobi(resp: Response, quality: Quality, expected: [number, string] | null): Promise<PlayUrlResult | null> {
    let data: any;
    try {
      data = await resp.json();
    } catch { return null; }

    if (data?.code !== 200) return null;
    const d = data.data;
    if (!d?.url) return null;

    const url = d.url as string;
    const bitrate = parseInt((d.bitrate || '0').toString(), 10) || 128;
    const format = (d.format || 'mp3').toString().toLowerCase();
    const ekey = d.ekey ? String(d.ekey) : undefined;

    // nmobi 响应级防盗标记（字段名来自实测，非猜测）
    const nmobiAntiFlag = d.isLimit === true || d.isLimit === '1' || d.isLimit === 1
      || d.isListen === true || d.isListen === '1' || d.isListen === 1
      || d.listenFlag === true || d.listenFlag === '1' || d.listenFlag === 1;
    if (nmobiAntiFlag) {
      debugLogger.warn('network', `酷我 nmobi 响应级防盗标记命中`, { url: url.slice(0, 120), isLimit: d.isLimit, isListen: d.isListen, listenFlag: d.listenFlag });
      return null;
    }

    // URL 级防盗链占位校验
    if (this.isAntiTheft(url)) return null;

    // 精确音质匹配（参照 DJMusic qualityExpectation/bitrateTolerance）
    const accurate = this.isBitrateAccurate(quality, bitrate, format);

    // 如果 expected 存在且完全不匹配，丢弃此链
    if (expected && !accurate) {
      return null;
    }

    // 判断加密：有 ekey 或格式为 mflac/mgg
    const isEncrypted = !!ekey || format === 'mflac' || format === 'mgg' || url.endsWith('.mflac') || url.endsWith('.mgg');

    return { url, quality, bitrate, format, accurate, isEncrypted, ekey };
  }

  /**
   * 选定音质档 → 期望的 (bitrate, format)，用于并发取链时拒绝回退假链
   * 酷我按歌曲策略：免费档无某高品时，请求 320kmp3 会返回 128k 直链，
   * 这种「降级链」大小/码率与所选音质不符，必须丢弃。
   */
  protected qualityExpectation(quality: Quality): [number, string] | null {
    switch (quality) {
      case Quality.LOW: return [48, 'aac'];
      case Quality.STANDARD: return [128, 'mp3'];
      case Quality.HIGH: return [320, 'mp3'];
      case Quality.LOSSLESS: return [2000, 'flac'];
      default: return null;
    }
  }

  /**
   * bitrate 匹配容差（不同编码实测码率有小幅浮动）
   * 参照 DJMusic：flac 80kbps / mp3,aac 8kbps
   */
  protected bitrateTolerance(format: string): number {
    const f = format.toLowerCase();
    if (f === 'flac') return 80;
    return 8;
  }

  /** 判断实际码率是否与请求音质匹配 */
  private isBitrateAccurate(requestedQuality: Quality, actualBitrate: number, actualFormat?: string): boolean {
    const expected = this.qualityExpectation(requestedQuality);
    if (!expected) return true;
    const [expBr, expFmt] = expected;
    const tol = this.bitrateTolerance(actualFormat || expFmt);
    const formatMatch = !actualFormat || actualFormat === expFmt;
    return formatMatch && Math.abs(actualBitrate - expBr) <= tol;
  }

  private isAntiTheft(url: string): boolean {
    if (url.endsWith('.mgg')) return true;
    if (url.includes('防盗链') || url.includes('打击')) return true;
    return false;
  }

  /**
   * 内容级防盗校验（覆写 BaseHttpSource）。
   * 对竞速选中的酷我直链做：
   * 1. HEAD 请求取 Content-Length + Content-Type
   * 2. 按 bitrate 估算时长，与歌曲原始时长对比
   * 3. Range GET 取前 4KB 校验音频魔数（ID3 / MP3 / FLAC / ADTS）
   * 4. 时长异常短（< 歌曲时长 40% 或 < 30s）→ 判为防盗/试听占位
   *
   * 命中后竞速自动继续其余通道（本候选返回 null），不静默。
   */
  protected override async validateContent(result: PlayUrlResult, songId: string): Promise<boolean> {
    const rid = songId.replace(/^kw_/, '');
    const songDuration = this.durationCache.get(rid) || 0;

    let contentLength = 0;
    let contentType = '';
    let headOk = false;

    // 1. HEAD 请求（3 秒超时，失败不阻断）
    try {
      const head = await platformFetch(result.url, {
        method: 'HEAD',
        headers: result.headers,
        timeout: 3000,
      });
      headOk = head.ok;
      contentLength = parseInt(head.headers.get('content-length') || '0', 10);
      contentType = head.headers.get('content-type') || '';
    } catch (err) {
      debugLogger.warn('network', `酷我防盗校验 HEAD 失败`, {
        url: result.url.slice(0, 120),
        error: err instanceof Error ? err.message : String(err),
      });
      // HEAD 失败时降级信任，继续放行
      return true;
    }

    // 2. 按 bitrate 估算时长
    const bitrateKbps = result.bitrate || 128;
    const estimatedDuration = contentLength > 0
      ? Math.round((contentLength * 8) / (bitrateKbps * 1000))
      : 0;

    // 3. 时长判定
    let isTheft = false;
    let reason = '';

    if (songDuration > 0 && estimatedDuration > 0) {
      // 有歌曲参考时长：异常短 → 防盗
      if (estimatedDuration < songDuration * 0.4) {
        isTheft = true;
        reason = `估算时长(${estimatedDuration}s) < 歌曲时长(${songDuration}s)的40%`;
      }
    } else if (estimatedDuration > 0 && estimatedDuration < 30) {
      // 无参考时长：保守阈值 < 30s
      isTheft = true;
      reason = `估算时长(${estimatedDuration}s) < 30s（无参考时长）`;
    }

    // 4. 魔数校验（辅助，非决定性）
    let magic = 'unknown';
    try {
      const rangeResp = await platformFetch(result.url, {
        method: 'GET',
        headers: { ...result.headers, Range: 'bytes=0-4095' },
        timeout: 5000,
      });
      if (rangeResp.ok) {
        const buf = await rangeResp.arrayBuffer();
        magic = this.detectAudioMagic(new Uint8Array(buf));
        // 如果魔数完全不对（不是任何已知音频格式），加重嫌疑
        if (magic === 'unknown' && contentLength > 0 && contentLength < 500 * 1024) {
          if (!isTheft) {
            isTheft = true;
            reason = `魔数未知且文件过小(${Math.round(contentLength / 1024)}KB)`;
          }
        }
      }
    } catch (err) {
      // Range 失败不阻断，仅记录
      debugLogger.warn('network', `酷我防盗校验 Range GET 失败`, {
        url: result.url.slice(0, 120),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 5. 日志留证（无论是否命中）
    if (isTheft) {
      debugLogger.warn('network', `酷我防盗音频命中（内容级校验）`, {
        url: result.url.slice(0, 120),
        contentType,
        contentLength,
        contentLengthKb: Math.round(contentLength / 1024),
        magic,
        bitrate: bitrateKbps,
        estimatedDuration,
        songDuration,
        reason,
        rid,
      });
      return false; // 作废该通道结果，竞速继续其余通道
    }

    debugLogger.info('network', `酷我内容级校验通过`, {
      url: result.url.slice(0, 120),
      contentType,
      contentLengthKb: Math.round(contentLength / 1024),
      magic,
      estimatedDuration,
      songDuration,
      rid,
    });
    return true;
  }

  /** 音频文件魔数检测 */
  private detectAudioMagic(view: Uint8Array): string {
    if (view.length < 4) return 'unknown';

    // ID3
    if (view[0] === 0x49 && view[1] === 0x44 && view[2] === 0x33) return 'id3';
    // FLAC
    if (view[0] === 0x66 && view[1] === 0x4C && view[2] === 0x61 && view[3] === 0x43) return 'flac';
    // MP3 帧头 (0xFFE0-0xFFFF)
    if (view[0] === 0xFF && (view[1] & 0xE0) === 0xE0) return 'mp3';
    // ADTS AAC (0xFFF0-0xFFFF)
    if (view[0] === 0xFF && (view[1] & 0xF0) === 0xF0) return 'adts';
    // Ogg
    if (view[0] === 0x4F && view[1] === 0x67 && view[2] === 0x67 && view[3] === 0x53) return 'ogg';
    // RIFF/WAV
    if (view[0] === 0x52 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x46) return 'riff';
    // M4A ftyp（在偏移 4 处）
    if (view.length > 8 && view[4] === 0x66 && view[5] === 0x74 && view[6] === 0x79 && view[7] === 0x70) return 'm4a';

    return 'unknown';
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

  // ===================== 榜单（v18） =====================

  /**
   * 榜单树：wapi.kuwo.cn/api/pc/bang/list（多级嵌套，递归提取 id/name）
   */
  async getCharts(): Promise<Chart[]> {
    const data = await this.httpGetJson('https://wapi.kuwo.cn/api/pc/bang/list', { Referer: 'https://www.kuwo.cn/' });
    const charts: Chart[] = [];
    const seen = new Set<string>();

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      // 节点形如 {id, name, pic} 或 {sourceid, name}
      const id = node.id !== undefined ? String(node.id) : node.sourceid !== undefined ? String(node.sourceid) : null;
      const name = node.name || node.disname || '';
      if (id && name && /^\d+$/.test(id) && !seen.has(id)) {
        seen.add(id);
        charts.push({ id, name, description: '' });
      }
      Object.values(node).forEach((v) => walk(v));
    };
    walk(data?.data ?? data);

    return charts;
  }

  /**
   * 榜单歌曲：kbangserver.kuwo.cn/ksong.s（Python dict格式，容错解析）
   * musiclist[] 条目字段为小写 id/name/artist/album/duration
   */
  async getChartDetail(chartId: string): Promise<ChartDetail> {
    const url = `https://kbangserver.kuwo.cn/ksong.s?from=pc&type=bang&id=${chartId}&pn=0&rn=100`;
    const resp = await this.httpGet(url, { Referer: 'https://www.kuwo.cn/' });
    if (!resp || !resp.ok) {
      return { id: String(chartId), name: '酷我榜单', description: '', songs: [] };
    }

    let text: string;
    try { text = await resp.text(); } catch { return { id: String(chartId), name: '酷我榜单', description: '', songs: [] }; }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      // Python dict风格解析（与 searchRs 相同的容错策略）
      try {
        const normalized = text
          .replace(/'/g, '"')
          .replace(/\bNone\b/g, 'null')
          .replace(/\bTrue\b/g, 'true')
          .replace(/\bFalse\b/g, 'false')
          .replace(/;\s*$/, '');
        data = JSON.parse(normalized);
      } catch {
        return { id: String(chartId), name: '酷我榜单', description: '', songs: [] };
      }
    }

    const musiclist = data?.musiclist || [];
    const songs: SearchResult[] = [];
    for (const o of musiclist) {
      const rid = (o.id || o.musicrid || o.MUSICRID || '').toString().replace(/^MUSIC_/, '');
      const name = (o.name || o.NAME || o.songname || '').toString().replace(/&nbsp;/g, ' ').trim();
      if (!rid || !name) continue;
      songs.push({
        id: `kw_${rid}`,
        type: 'song',
        title: name,
        artist: (o.artist || o.ARTIST || '').toString().replace(/&nbsp;/g, ' ').trim() || '未知歌手',
        album: (o.album || o.ALBUM || '').toString().trim(),
        duration: parseInt((o.duration || o.DURATION || '0').toString(), 10) || 0,
        coverUrl: (o.pic || o.albumpic || '').toString().startsWith('http') ? (o.pic || o.albumpic) : '',
        sourceId: this.id,
        sourceSongId: rid,
        quality: Quality.STANDARD,
        bitrate: 128,
      });
    }

    return { id: String(chartId), name: '酷我榜单', description: '', songs };
  }

  // ===================== 歌单 =====================

  /** 标签列表缓存（getTagList 拉一次复用） */
  private tagListCache: { id: string; name: string }[] | null = null;

  /**
   * 融合分类名 → 酷我标签名的别名映射（酷我标签树里没有同名的分类）
   */
  private static readonly KW_TAG_ALIASES: Record<string, string> = {
    日韩: '日语',
    说唱: '嘻哈',
    影视原声: '影视',
  };

  /**
   * 按融合固定分类拉取歌单列表（v19.1 全部走酷我歌单广场真实接口，不再用搜索）：
   * - 热门推荐：getRcmPlayList?id=37（酷我歌单广场"热门推荐"，实测 total 9000+）
   * - 其他分类：getTagList 匹配标签 → getTagPlayList（酷我官方分类-歌单列表）
   * 注意：getTagPlayList / getRcmPlayList 的 pn 从 1 开始（pn=0 实测返回空列表）
   */
  async getPlaylistsByCategory(categoryName: string, page = 0): Promise<PlaylistSummary[]> {
    try {
      const pn = page + 1;
      if (categoryName === '热门推荐') {
        const url = `https://wapi.kuwo.cn/api/pc/classify/playlist/getRcmPlayList?id=37&pn=${pn}&rn=30`;
        const data = await this.httpGetJson(url, { Referer: 'https://www.kuwo.cn/' });
        const list = data?.data?.data || [];
        if (!Array.isArray(list)) return [];
        return list
          .map((o: any) => ({
            id: String(o.id || ''),
            title: o.name || o.title || '未命名歌单',
            coverUrl: o.img || o.pic || o.cover || '',
            playCount: Number(o.listencnt) > 0 ? Number(o.listencnt) : undefined,
            trackCount: Number(o.total) > 0 ? Number(o.total) : undefined,
            creator: o.uname || undefined,
          }))
          .filter((p: PlaylistSummary) => p.id);
      }

      if (!this.tagListCache) {
        const data = await this.httpGetJson(
          'https://wapi.kuwo.cn/api/pc/classify/playlist/getTagList',
          { Referer: 'https://www.kuwo.cn/' }
        );
        const tags: { id: string; name: string }[] = [];
        const walk = (node: any) => {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) { node.forEach(walk); return; }
          if (node.name && node.id !== undefined) tags.push({ id: String(node.id), name: String(node.name) });
          for (const v of Object.values(node)) walk(v);
        };
        walk(data);
        this.tagListCache = tags;
      }

      const wanted = KuwoSource.KW_TAG_ALIASES[categoryName] || categoryName;
      // 精确匹配 → 包含匹配
      const tag =
        this.tagListCache.find((t) => t.name === wanted) ||
        this.tagListCache.find((t) => t.name.includes(wanted) || wanted.includes(t.name));
      if (!tag) return [];

      const url = `http://wapi.kuwo.cn/api/pc/classify/playlist/getTagPlayList?loginUid=0&loginSid=0&appUid=38668888&pn=${pn}&id=${tag.id}`;
      const data = await this.httpGetJson(url, { Referer: 'https://www.kuwo.cn/' });
      const list = data?.data?.list || (Array.isArray(data?.data) ? data.data : []);
      if (!Array.isArray(list)) return [];
      return list.map((o: any) => ({
        id: String(o.id || o.playlistid),
        title: o.name || o.title || '未命名歌单',
        coverUrl: o.img || o.pic || o.cover || '',
        playCount: Number(o.listencnt) > 0 ? Number(o.listencnt) : undefined,
        trackCount: Number(o.total) > 0 ? Number(o.total) : undefined,
        creator: o.uname || undefined,
      }));
    } catch (err) {
      debugLogger.warn('network', '酷我分类歌单拉取失败', { categoryName, err: String(err) });
      return [];
    }
  }

  /**
   * 获取酷我歌单
   * - 优先尝试 API（kuwo.cn/api/www/playlist/playListInfo）
   * - 若 API 被反爬拒绝，降级走 HTML 页提取 window.__NUXT__
   * - 全程带 ERROR 日志，杜绝静默失败
   */
  async getPlaylist(playlistId: string): Promise<PlaylistDetail> {
    debugLogger.info('network', `酷我歌单解析开始`, { playlistId });

    // 1. 尝试 API
    try {
      const result = await this.getPlaylistFromApi(playlistId);
      debugLogger.info('network', `酷我歌单 API 解析成功`, { playlistId, songCount: result.total });
      return result;
    } catch (err) {
      debugLogger.warn('network', `酷我歌单 API 失败，降级到 HTML`, {
        playlistId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. 降级到 HTML 提取
    try {
      const result = await this.getPlaylistFromHtml(playlistId);
      debugLogger.info('network', `酷我歌单 HTML 解析成功`, { playlistId, songCount: result.total });
      return result;
    } catch (err) {
      debugLogger.error('network', `酷我歌单 HTML 解析也失败`, {
        playlistId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err instanceof YinliuError
        ? err
        : new YinliuError(ErrorCode.SOURCE_ERROR, `酷我歌单解析失败: ${err instanceof Error ? err.message : '未知错误'}`, 502);
    }
  }

  private async getPlaylistFromApi(playlistId: string): Promise<PlaylistDetail> {
    const url = `${this.SEARCH_V2_HOST}/api/www/playlist/playListInfo?pid=${playlistId}&pn=1&rn=50`;
    debugLogger.info('network', `酷我 API 请求`, { url, playlistId });

    let resp: Response | null = null;
    try {
      resp = await this.httpGet(url, { Referer: 'https://www.kuwo.cn/' });
    } catch (err) {
      debugLogger.error('network', `酷我 API 请求异常`, {
        url,
        playlistId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, `酷我歌单请求失败: ${err instanceof Error ? err.message : '未知错误'}`, 502);
    }

    if (!resp) {
      debugLogger.error('network', `酷我 API 响应为空`, { url, playlistId });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '酷我歌单响应为空', 502);
    }

    if (!resp.ok) {
      const bodyPreview = await resp.text().catch(() => '').then(t => t.slice(0, 200));
      debugLogger.error('network', `酷我 API 非成功状态码`, {
        url,
        status: resp.status,
        bodyPreview,
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, `酷我歌单返回 ${resp.status}`, resp.status);
    }

    let data: any;
    try {
      data = await resp.json();
    } catch (err) {
      const bodyPreview = await resp.text().catch(() => '').then(t => t.slice(0, 200));
      debugLogger.error('network', `酷我 API JSON 解析失败`, {
        url,
        bodyPreview,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '酷我歌单 JSON 解析失败', 502);
    }

    // 反爬返回 200 但 success:false
    if (data && data.success === false) {
      const msg = data.message || data.error || '反爬拦截';
      debugLogger.error('network', `酷我 API 被反爬拦截`, {
        url,
        playlistId,
        responseMsg: msg,
        responsePreview: JSON.stringify(data).slice(0, 200),
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, `酷我歌单被反爬拦截: ${msg}`, 403);
    }

    if (!data?.data) {
      debugLogger.error('network', `酷我 API 数据字段缺失`, {
        url,
        playlistId,
        dataPreview: JSON.stringify(data).slice(0, 200),
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, `酷我歌单不存在或无权限: ${playlistId}`, 404);
    }

    const pl = data.data;
    const list = pl.musicList || [];

    if (!list.length) {
      debugLogger.error('network', `酷我 API 曲目列表为空`, { url, playlistId });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '酷我歌单曲目列表为空', 422);
    }

    return {
      id: playlistId,
      name: pl.name || '酷我歌单',
      description: pl.info || '',
      coverUrl: pl.img || '',
      songs: list.map((o: any) => this.parseSong(o)).filter(Boolean) as SearchResult[],
      total: list.length,
    };
  }

  /**
   * 降级：从 HTML 页提取 window.__NUXT__ 中的歌单数据
   */
  private async getPlaylistFromHtml(playlistId: string): Promise<PlaylistDetail> {
    const url = `${this.SEARCH_V2_HOST}/playlist_detail/${playlistId}`;
    debugLogger.info('network', `酷我 HTML 请求`, { url, playlistId });

    let resp: Response | null = null;
    try {
      resp = await this.httpGet(url, { Referer: 'https://www.kuwo.cn/' });
    } catch (err) {
      debugLogger.error('network', `酷我 HTML 请求异常`, {
        url,
        playlistId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, `酷我歌单 HTML 请求失败: ${err instanceof Error ? err.message : '未知错误'}`, 502);
    }

    if (!resp) {
      debugLogger.error('network', `酷我 HTML 响应为空`, { url, playlistId });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '酷我歌单 HTML 响应为空', 502);
    }

    if (!resp.ok) {
      const bodyPreview = await resp.text().catch(() => '').then(t => t.slice(0, 200));
      debugLogger.error('network', `酷我 HTML 非成功状态码`, {
        url,
        status: resp.status,
        bodyPreview,
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, `酷我歌单 HTML 返回 ${resp.status}`, resp.status);
    }

    let html: string;
    try {
      html = await resp.text();
    } catch (err) {
      debugLogger.error('network', `酷我 HTML 读取响应体失败`, {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '酷我歌单 HTML 读取失败', 502);
    }

    const nuxtData = this.extractNuxtData(html);
    if (!nuxtData) {
      const bodyPreview = html.slice(0, 200);
      debugLogger.error('network', `酷我 HTML 未找到 window.__NUXT__`, {
        url,
        bodyPreview,
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '酷我歌单 HTML 结构解析失败', 502);
    }

    const pl = nuxtData.playListInfo;
    if (!pl) {
      debugLogger.error('network', `酷我 HTML 无 playListInfo`, {
        url,
        nuxtKeys: Object.keys(nuxtData),
      });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '酷我歌单 HTML 中未找到歌单信息', 404);
    }

    const list = pl.musicList || [];
    if (!list.length) {
      debugLogger.error('network', `酷我 HTML 曲目列表为空`, { url, playlistId });
      throw new YinliuError(ErrorCode.SOURCE_ERROR, '酷我歌单曲目列表为空', 422);
    }

    return {
      id: playlistId,
      name: pl.name || '酷我歌单',
      description: pl.info || '',
      coverUrl: pl.img || '',
      songs: list.map((o: any) => this.parseSong(o)).filter(Boolean) as SearchResult[],
      total: list.length,
    };
  }

  /**
   * 从 HTML 中提取 window.__NUXT__ 数据
   * Nuxt 格式: window.__NUXT__=(function(a,b,...){return {...}})(...)
   * 由于 Nuxt 使用函数参数替换，无法直接正则提取 JSON，需用 new Function 安全执行。
   */
  private extractNuxtData(html: string): any | null {
    const marker = 'window.__NUXT__=';
    const start = html.indexOf(marker);
    if (start === -1) return null;

    const scriptEnd = html.indexOf('</script>', start);
    const nuxtCode = html.slice(start + marker.length, scriptEnd);

    try {
      // new Function 比 eval 安全：不访问局部作用域
      const fn = new Function('return ' + nuxtCode);
      const parsed = fn();
      if (parsed && Array.isArray(parsed.data) && parsed.data.length > 0) {
        return parsed.data[0];
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async parsePlaylistUrl(url: string): Promise<PlaylistDetail> {
    const match = url.match(/playlist_detail\/(\d+)/)
      || url.match(/playlists\/(\d+)/)
      || url.match(/[?&]pid=(\d+)/);
    if (!match || !match[1]) {
      throw new YinliuError(ErrorCode.VALIDATION_ERROR, '无法解析酷我歌单URL', 400);
    }
    return this.getPlaylist(match[1]);
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
