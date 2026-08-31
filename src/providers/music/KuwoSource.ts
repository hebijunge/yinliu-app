import { BaseHttpSource } from './BaseHttpSource';
import type { SearchParams, SearchResult, SongDetail, HealthStatus, Quality, PlayUrlResult } from '@core/types';
import type { EndpointCandidate } from './types';
import { YinliuError, ErrorCode } from '@core/types';
import { platformFetch } from '@shared/utils/platformFetch';

const KUWO_UA = 'kwplayerhd_ar_4.3.0.8_tianbao_T1A_qirui';

function parseKuwoJson(text: string): unknown {
  // Kuwo returns Python-style single-quote JSON (text/plain)
  // Safe eval-like parsing for simple data structures
  try {
    return new Function('return ' + text)();
  } catch {
    // Fallback: try standard JSON (in case they change to real JSON)
    return JSON.parse(text);
  }
}

export class KuwoSource extends BaseHttpSource {
  readonly id = 'kuwo';
  readonly name = '酷我音乐';
  readonly maxQuality = Quality.LOSSLESS;

  async search(params: SearchParams): Promise<SearchResult[]> {
    const url = 'https://search.kuwo.cn/r.s';
    const queryParams = new URLSearchParams({
      prod: 'kwplayer_ar_9.3.7.2',
      corp: 'kuwo',
      newver: '2',
      vipver: '9.3.7.2',
      source: 'kwplayer_ar_9.3.7.2_meizu.apk',
      p2p: '1',
      notrace: '0',
      client: 'kt',
      all: params.keyword,
      pn: String(params.page || 0),
      rn: String(params.pageSize || 30),
      ft: 'music',
      cluster: '0',
      strategy: '2012',
      encoding: 'utf8',
      rformat: 'json',
    });

    const response = await platformFetch(`${url}?${queryParams.toString()}`, {
      method: 'GET',
      headers: {
        'User-Agent': KUWO_UA,
        'Referer': 'http://search.kuwo.cn/',
      },
    });

    if (!response.ok) {
      throw new Error(`Kuwo search failed: ${response.status}`);
    }

    const text = await response.text();
    const data = parseKuwoJson(text) as Record<string, unknown>;
    const abslist = data?.abslist as Array<Record<string, unknown>> | undefined;

    if (!Array.isArray(abslist)) {
      return [];
    }

    return abslist.map((item) => this.mapSearchResult(item));
  }

  private mapSearchResult(item: Record<string, unknown>): SearchResult {
    const artist = String(item.ARTIST || '').replace(/&/g, ' / ');
    const musicrid = String(item.MUSICRID || '');
    const rid = musicrid.replace(/^MUSIC_/i, '');

    // Parse N_MINFO for available qualities
    const nMinfo = String(item.N_MINFO || '');
    const availableQualities: Quality[] = [Quality.STANDARD];
    if (nMinfo.includes('bitrate:320') || nMinfo.includes('p')) {
      availableQualities.push(Quality.HIGH);
    }
    if (nMinfo.includes('bitrate:2000') || nMinfo.includes('ff')) {
      availableQualities.push(Quality.LOSSLESS);
    }

    return {
      id: `kuwo_${rid}`,
      type: 'song',
      title: String(item.SONGNAME || ''),
      artist,
      album: String(item.ALBUM || ''),
      duration: typeof item.DURATION === 'number' ? item.DURATION : undefined,
      coverUrl: '', // Will be fetched on demand
      sourceId: this.id,
      sourceSongId: rid,
      quality: Quality.STANDARD,
      bitrate: 128,
      availableQualities,
    };
  }

  async getSongDetail(songId: string): Promise<SongDetail> {
    // Cover image
    try {
      const coverResp = await platformFetch(
        `http://artistpicserver.kuwo.cn/pic.web?type=rid_pic&pictype=url&content=list&size=700&rid=${songId}`,
        { method: 'GET', headers: { 'User-Agent': KUWO_UA } }
      );
      const coverText = await coverResp.text();
      const coverUrl = coverText.trim();
      return {
        id: songId,
        title: '',
        coverUrl: coverUrl.startsWith('http') ? coverUrl : undefined,
      };
    } catch {
      return { id: songId, title: '' };
    }
  }

  protected buildEndpointCandidates(songId: string, quality: Quality) {
    const brMap: Record<Quality, string> = {
      [Quality.LOW]: '128kmp3',
      [Quality.STANDARD]: '128kmp3',
      [Quality.HIGHER]: '192kmp3',
      [Quality.HIGH]: '320kmp3',
      [Quality.LOSSLESS]: '2000kflac',
      [Quality.HIRES]: '2000kflac',
      [Quality.SKY]: '2000kflac',
      [Quality.JYEFFECT]: '2000kflac',
      [Quality.HIFI]: '2000kflac',
    };
    const br = brMap[quality] ?? '128kmp3';

    return [
      {
        url: `http://nmobi.kuwo.cn/mobi.s?f=web&user=0&source=kwplayerhd_ar_4.3.0.8_tianbao_T1A_qirui.apk&type=convert_url_with_sign&rid=${songId}&br=${br}`,
        method: 'GET' as const,
        headers: { 'User-Agent': KUWO_UA },
        timeout: 15000,
        priority: 1,
      },
    ];
  }

  protected async linkRace(candidates: EndpointCandidate[], targetQuality: Quality): Promise<PlayUrlResult> {
    const c = candidates[0];
    const response = await platformFetch(c.url, {
      method: c.method,
      headers: c.headers,
    });

    if (!response.ok) {
      throw new YinliuError(ErrorCode.LINK_RACE_FAILED, `Kuwo play URL failed: ${response.status}`, response.status);
    }

    const text = await response.text();
    let data: Record<string, unknown>;
    try {
      data = parseKuwoJson(text) as Record<string, unknown>;
    } catch {
      // Some responses are plain text with key=value pairs
      const pairs = new Map<string, string>();
      for (const line of text.split('\n')) {
        for (const part of line.split('&')) {
          const [k, v] = part.split('=');
          if (k && v) pairs.set(decodeURIComponent(k), decodeURIComponent(v));
        }
      }
      data = Object.fromEntries(pairs);
    }

    const url = data.url || data.data;
    if (!url || typeof url !== 'string') {
      throw new YinliuError(ErrorCode.LINK_RACE_FAILED, 'Kuwo: no play URL returned', 503);
    }

    const actualBr = typeof data.bitrate === 'number' ? data.bitrate : (typeof data.br === 'number' ? data.br : 128000);
    const format = String(data.format || data.extName || 'mp3');

    return {
      url,
      quality: targetQuality,
      bitrate: Math.round(actualBr / 1000),
      format: format.toLowerCase(),
      headers: c.headers,
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const start = Date.now();
      const response = await platformFetch(
        'http://search.kuwo.cn/r.s?all=test&ft=music&itemset=web_8&newsearch=1&cluster=0&pn=0&rn=1&rformat=json&encoding=utf8',
        {
          method: 'GET',
          headers: { 'User-Agent': KUWO_UA },
          signal: AbortSignal.timeout(10000),
        }
      );
      return {
        healthy: response.ok,
        message: response.ok ? '酷我音乐服务正常' : '酷我音乐服务异常',
        latency: Date.now() - start,
      };
    } catch {
      return { healthy: false, message: '酷我音乐服务不可用' };
    }
  }
}
