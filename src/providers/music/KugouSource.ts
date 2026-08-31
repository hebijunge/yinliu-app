import { BaseHttpSource } from './BaseHttpSource';
import type { SearchParams, SearchResult, SongDetail, HealthStatus, Quality, PlayUrlResult } from '@core/types';
import type { EndpointCandidate } from './types';
import { YinliuError, ErrorCode } from '@core/types';
import { platformFetch } from '@shared/utils/platformFetch';

const KUGOU_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15';
const KUGOU_REFERER = 'http://m.kugou.com/';

export class KugouSource extends BaseHttpSource {
  readonly id = 'kugou';
  readonly name = '酷狗音乐';
  readonly maxQuality = Quality.LOSSLESS;

  async search(params: SearchParams): Promise<SearchResult[]> {
    const page = (params.page || 0) + 1;
    const pagesize = params.pageSize || 20;
    const kw = encodeURIComponent(params.keyword);
    const url = `https://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${kw}&page=${page}&pagesize=${pagesize}`;

    const response = await platformFetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': KUGOU_UA,
        'Referer': KUGOU_REFERER,
      },
    });

    if (!response.ok) {
      throw new Error(`Kugou search failed: ${response.status}`);
    }

    const data = await response.json();
    const songs = data?.data?.info as Array<Record<string, unknown>> | undefined;

    if (!Array.isArray(songs)) {
      return [];
    }

    return songs.map((song) => this.mapSearchResult(song));
  }

  private mapSearchResult(song: Record<string, unknown>): SearchResult {
    const filename = String(song.filename || '');
    const [artist = '', title = ''] = filename.split(' - ', 2);
    const hash = String(song.hash || '');
    const hash320 = String(song['320hash'] || '');
    const sqhash = String(song.sqhash || '');

    const availableQualities: Quality[] = [Quality.STANDARD];
    if (hash320) availableQualities.push(Quality.HIGH);
    if (sqhash) availableQualities.push(Quality.LOSSLESS);

    // Use the source song ID that bundles all hash info for playback resolution
    const sourceSongId = JSON.stringify({ hash, hash320, sqhash, album_id: song.album_id });

    return {
      id: `kugou_${hash}`,
      type: 'song',
      title: title || filename,
      artist: artist.trim(),
      album: String(song.album_name || ''),
      duration: typeof song.duration === 'number' ? song.duration : undefined,
      coverUrl: '',
      sourceId: this.id,
      sourceSongId,
      quality: Quality.STANDARD,
      bitrate: 128,
      availableQualities,
    };
  }

  async getSongDetail(songId: string): Promise<SongDetail> {
    let hash: string;
    try {
      const parsed = JSON.parse(songId);
      hash = parsed.hash || songId;
    } catch {
      hash = songId;
    }

    const url = `http://mobilecdn.kugou.com/api/v3/song/info?format=json&hash=${hash}`;
    try {
      const response = await platformFetch(url, {
        method: 'GET',
        headers: { 'User-Agent': KUGOU_UA },
      });
      const data = await response.json();
      const info = data?.data as Record<string, unknown> | undefined;
      return {
        id: songId,
        title: String(info?.songName || info?.filename || ''),
        artist: String(info?.singername || ''),
        album: String(info?.album_name || ''),
        coverUrl: String(info?.imgurl || info?.album_img || ''),
      };
    } catch {
      return { id: songId, title: '' };
    }
  }

  protected buildEndpointCandidates(songId: string, quality: Quality) {
    // Kugou needs third-party resolver for VIP songs
    // We store JSON with hash info in sourceSongId
    let hash: string;
    try {
      const parsed = JSON.parse(songId);
      if (quality === Quality.LOSSLESS && parsed.sqhash) {
        hash = parsed.sqhash;
      } else if (quality === Quality.HIGH && parsed.hash320) {
        hash = parsed.hash320;
      } else {
        hash = parsed.hash || songId;
      }
    } catch {
      hash = songId;
    }

    const levelMap: Record<Quality, string> = {
      [Quality.LOW]: '128k',
      [Quality.STANDARD]: '128k',
      [Quality.HIGHER]: '320k',
      [Quality.HIGH]: '320k',
      [Quality.LOSSLESS]: 'lossless',
      [Quality.HIRES]: 'lossless',
      [Quality.SKY]: 'lossless',
      [Quality.JYEFFECT]: 'lossless',
      [Quality.HIFI]: 'lossless',
    };
    const level = levelMap[quality] ?? '128k';

    return [
      {
        url: `https://musicserver.haitangw.cc/v1/music/resolve-url`,
        method: 'POST' as const,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': KUGOU_UA,
        },
        body: JSON.stringify({ source: 'kg', rid: hash, level }),
        timeout: 15000,
        priority: 1,
      },
      // Fallback: try free song endpoint
      {
        url: `https://m.kugou.com/app/i/getSongInfo.php?hash=${hash}&cmd=playInfo`,
        method: 'GET' as const,
        headers: { 'User-Agent': KUGOU_UA, 'Referer': KUGOU_REFERER },
        timeout: 10000,
        priority: 2,
      },
    ];
  }

  protected async linkRace(candidates: EndpointCandidate[], targetQuality: Quality): Promise<PlayUrlResult> {
    const controller = new AbortController();

    const promises = candidates.map(async (c) => {
      try {
        const response = await platformFetch(c.url, {
          method: c.method,
          headers: c.headers,
          body: c.body as string | undefined,
          signal: controller.signal,
        });

        if (!response.ok) return null;

        if (c.method === 'POST') {
          // Haitang resolve-url
          const data = await response.json();
          const url = data?.url || data?.data?.url;
          if (!url || typeof url !== 'string') return null;

          const contentType = response.headers.get('content-type') || '';
          const format = contentType.includes('flac') ? 'flac' : 'mp3';
          controller.abort();
          return {
            url,
            quality: targetQuality,
            bitrate: format === 'flac' ? 1000 : 128,
            format,
            headers: c.headers,
          } as PlayUrlResult;
        } else {
          // getSongInfo.php
          const data = await response.json();
          const url = data?.url;
          if (!url || typeof url !== 'string') return null;
          controller.abort();
          return {
            url,
            quality: targetQuality,
            bitrate: 128,
            format: 'mp3',
            headers: c.headers,
          } as PlayUrlResult;
        }
      } catch {
        return null;
      }
    });

    const results = await Promise.allSettled(promises);
    const matched = results
      .filter((r): r is PromiseFulfilledResult<PlayUrlResult | null> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((r): r is PlayUrlResult => r !== null);

    if (matched.length > 0) {
      return matched[0];
    }

    throw new YinliuError(ErrorCode.LINK_RACE_FAILED, `Kugou link race failed`, 503);
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const start = Date.now();
      const response = await platformFetch(
        'http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=test&page=1&pagesize=1',
        {
          method: 'GET',
          headers: { 'User-Agent': KUGOU_UA },
          signal: AbortSignal.timeout(10000),
        }
      );
      return {
        healthy: response.ok,
        message: response.ok ? '酷狗音乐服务正常' : '酷狗音乐服务异常',
        latency: Date.now() - start,
      };
    } catch {
      return { healthy: false, message: '酷狗音乐服务不可用' };
    }
  }
}
