import { BaseHttpSource } from './BaseHttpSource';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult, SongDetail, HealthStatus, PlayUrlResult } from '@core/types';
import type { ResolvedCandidate } from './BaseHttpSource';
import { platformFetch } from '@shared/utils/platformFetch';

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

  // hash缓存：自增id -> hash信息
  private hashCache = new Map<string, { hash: string; hash320: string; hashFlac: string; name: string; artist: string; duration: number }>();
  private nextId = 1;

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
    this.hashCache.set(id, { hash, hash320, hashFlac, name, artist, duration: dur });

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
        return {
          id: songId,
          title: data.songName || '未知歌曲',
          artist: data.singerName || '',
          album: data.albumName || '',
          duration: data.timeLength ? parseInt(data.timeLength, 10) : 0,
          coverUrl: data.cover || data.imgUrl || '',
        };
      }
    } catch { /* ignore */ }

    return { id: songId, title: '未知歌曲', artist: '', album: '', duration: 0, coverUrl: '' };
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
        return { url, quality, bitrate: 128, format: 'mp3', accurate: true };
      },
    });

    // 海棠resolve-url（POST JSON）—— 仅用于 lossless 档，HIGH/HIGHER 不走海棠
    if (quality === Quality.LOSSLESS || quality === Quality.HIFI || quality === Quality.HIRES) {
      candidates.push({
        url: this.HAITANG_URL,
        method: 'POST',
        timeout: 10000,
        priority: 2,
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://musicserver.haitangw.cc/',
        },
        resolve: async (resp) => {
          const data = await resp.json().catch(() => null);
          if (!data?.url) return null;
          return {
            url: data.url,
            quality,
            bitrate: this.levelToBitrate(level),
            format: this.detectFormat('', data.url),
            accurate: true,
          };
        },
      });
    }

    return candidates;
  }

  // 覆写getPlayUrl，因为海棠需要POST body
  async getPlayUrl(songId: string, quality: Quality): Promise<PlayUrlResult> {
    const hash = this.getHashFromId(songId);
    const level = this.levelOf(quality);

    const controller = new AbortController();
    const candidates: Promise<PlayUrlResult | null>[] = [];

    // 官方
    candidates.push(this.fetchOfficial(hash, quality, controller.signal));
    // 海棠POST —— 仅用于 lossless 档
    if (quality === Quality.LOSSLESS || quality === Quality.HIFI || quality === Quality.HIRES) {
      candidates.push(this.fetchHaitang(hash, level, quality, controller.signal));
    }

    const results = await Promise.allSettled(candidates);
    const matched = results
      .filter((r): r is PromiseFulfilledResult<PlayUrlResult | null> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((r): r is PlayUrlResult => r !== null);

    if (matched.length > 0) {
      controller.abort();
      return matched[0];
    }

    throw new Error(`酷狗取链失败：所有候选均不可用 (hash=${hash})`);
  }

  private async fetchOfficial(hash: string, quality: Quality, signal: AbortSignal): Promise<PlayUrlResult | null> {
    try {
      const resp = await platformFetch(`${this.GET_SONG_INFO}?hash=${hash}&cmd=playInfo`, {
        headers: { Referer: this.M_REF },
        signal,
      });
      const data = await resp.json().catch(() => null);
      if (!data?.url) return null;
      const url = data.url as string;
      if (!url.startsWith('http')) return null;
      return { url, quality, bitrate: 128, format: 'mp3' };
    } catch { return null; }
  }

  private async fetchHaitang(hash: string, level: string, quality: Quality, signal: AbortSignal): Promise<PlayUrlResult | null> {
    try {
      const resp = await platformFetch(this.HAITANG_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://musicserver.haitangw.cc/',
        },
        body: JSON.stringify({ source: 'kg', rid: hash, level }),
        signal,
      });
      const data = await resp.json().catch(() => null);
      if (!data?.url) return null;
      return {
        url: data.url,
        quality,
        bitrate: this.levelToBitrate(level),
        format: this.detectFormat('', data.url),
      };
    } catch { return null; }
  }

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
      case Quality.HIFI:
      case Quality.HIRES:
        return 'lossless';
      default: return 'standard';
    }
  }

  private levelToBitrate(level: string): number {
    switch (level) {
      case 'standard': return 128;
      case 'exhigh': return 320;
      case 'lossless': return 1000;
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

  // ===================== 歌单 =====================

  async getPlaylist(playlistId: string) {
    try {
      const url = `${this.M_HOST}/plist/list/${playlistId}?json=true`;
      const data = await this.httpGetJson(url, { Referer: this.M_REF });
      if (!data) throw new Error('Empty response');

      const info = data.info?.list || {};
      const songs = data.list?.list?.info || [];

      return {
        id: playlistId,
        name: info.specialname || '酷狗歌单',
        description: info.intro || '',
        coverUrl: (info.imgurl || '').replace('{size}', '400'),
        songs: songs.map((item: any) => this.parseSong(item)).filter(Boolean),
        total: songs.length,
      };
    } catch (err) {
      throw err;
    }
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
