import { BaseHttpSource } from './BaseHttpSource';
import { Quality } from '@core/types';
import type { SearchParams, SearchResult, SongDetail, HealthStatus, PlayUrlResult } from '@core/types';
import type { EndpointCandidate } from './types';
import { YinliuError, ErrorCode } from '@core/types';
import { platformFetch } from '@shared/utils/platformFetch';

const QISHUI_UA = 'LunaPC/3.0.0(290101097)';
const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

/**
 * 汽水音乐音源Provider
 * 源标识：qi
 * 接口：官方免登录搜索/歌单/榜单 + 分享页_ROUTER_DATA明文直链 + 第三方track.php/BugPk-Api竞速
 * 加密：track.php返回CENC+AES-CTR加密流，需decrypt_key解密
 */
export class QishuiSource extends BaseHttpSource {
  readonly id = 'qishui';
  readonly name = '汽水音乐';
  readonly maxQuality = Quality.LOSSLESS;

  // 官方API公共参数（PC客户端伪装）
  private readonly commonParams = new URLSearchParams({
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
  });

  async search(params: SearchParams): Promise<SearchResult[]> {
    const url = `https://api.qishui.com/luna/search/track?${this.commonParams.toString()}&q=${encodeURIComponent(params.keyword)}&count=${params.pageSize || 20}&search_method=history&cursor=${(params.page || 0) * (params.pageSize || 20)}`;

    const response = await platformFetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': QISHUI_UA,
        'Referer': 'https://api.qishui.com/',
      },
    });

    if (!response.ok) {
      throw new Error(`Qishui search failed: ${response.status}`);
    }

    const data = await response.json();
    const group = data?.result_groups?.find((g: any) => g.id === 'tracks');
    const tracks = group?.data || [];

    return tracks.map((item: any) => this.mapSearchResult(item));
  }

  private mapSearchResult(item: any): SearchResult {
    const track = item.entity?.track || item.entity?.track_wrapper?.track || item.entity || {};
    const artists = Array.isArray(track.artists)
      ? track.artists.map((a: any) => a.name).filter(Boolean).join(' / ')
      : '';
    const album = track.album || {};
    const duration = typeof track.duration === 'number' ? Math.round(track.duration / 1000) : undefined;

    // 汽水音乐默认可用音质：medium/higher/highest/lossless
    const availableQualities: Quality[] = [Quality.STANDARD, Quality.HIGHER, Quality.HIGH, Quality.LOSSLESS];

    return {
      id: `qi_${track.id}`,
      type: 'song',
      title: String(track.name || ''),
      artist: artists,
      album: String(album.name || ''),
      duration,
      coverUrl: String(album.url_cover || track.url_cover || ''),
      sourceId: this.id,
      sourceSongId: String(track.id || ''),
      quality: Quality.STANDARD,
      bitrate: 128,
      availableQualities,
    };
  }

  async getSongDetail(songId: string): Promise<SongDetail> {
    // 汽水无独立歌曲详情接口，用SEO track或搜索补充
    const url = `https://beta-luna.douyin.com/luna/h5/seo_track?track_id=${songId}&device_platform=web`;
    try {
      const response = await platformFetch(url, {
        method: 'GET',
        headers: { 'User-Agent': GOOGLEBOT_UA },
      });
      if (!response.ok) {
        return { id: songId, title: '' };
      }
      const data = await response.json();
      const track = data?.seo_track?.track || {};
      return {
        id: songId,
        title: String(track.name || ''),
        artist: Array.isArray(track.artists)
          ? track.artists.map((a: any) => a.name).filter(Boolean).join(' / ')
          : '',
        duration: typeof track.duration === 'number' ? Math.round(track.duration / 1000) : undefined,
      };
    } catch {
      return { id: songId, title: '' };
    }
  }

  /**
   * 构建取链候选端点
   * 包含：分享页_ROUTER_DATA明文直链(官方) + 第三方track.php + BugPk-Api 并发竞速
   */
  protected buildEndpointCandidates(songId: string, quality: Quality): EndpointCandidate[] {
    const candidates: EndpointCandidate[] = [];

    // 方案1：分享页_ROUTER_DATA明文直链（官方免登录，首选）
    candidates.push({
      url: `https://music.douyin.com/qishui/share/track?track_id=${songId}`,
      method: 'GET',
      headers: {
        'User-Agent': GOOGLEBOT_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 15000,
      priority: 1,
    });

    // 方案2：第三方track.php（多档含lossless，AES-CBC加密响应）
    candidates.push({
      url: `https://qishui.lxmapi.icu/apis/track.php?track_id=${songId}`,
      method: 'GET',
      headers: { 'User-Agent': QISHUI_UA },
      timeout: 15000,
      priority: 2,
    });

    // 方案3：BugPk-Api（单档higher明文，免解密备用）
    const shareLink = encodeURIComponent(`https://music.douyin.com/qishui/share/track?track_id=${songId}`);
    candidates.push({
      url: `https://api.bugpk.com/api/qsmusic?url=${shareLink}`,
      method: 'GET',
      headers: { 'User-Agent': GOOGLEBOT_UA },
      timeout: 10000,
      priority: 3,
    });

    return candidates;
  }

  /**
   * 覆写解析逻辑：处理三种不同方案的响应格式
   */
  protected async parsePlayUrlResponse(
    response: Response,
    candidate: EndpointCandidate,
    targetQuality: Quality
  ): Promise<PlayUrlResult | null> {
    const url = candidate.url;

    // 方案1：分享页_ROUTER_DATA明文直链（HTML响应）
    if (url.includes('music.douyin.com/qishui/share/track')) {
      const html = await response.text();
      const playUrl = this.extractRouterDataUrl(html);
      if (playUrl) {
        return {
          url: playUrl,
          quality: targetQuality,
          bitrate: this.estimateBitrateFromUrl(playUrl),
          format: this.detectFormat('', playUrl),
          headers: candidate.headers,
        };
      }
      return null;
    }

    // 方案2：第三方track.php（Base64+AES-CBC加密响应）
    if (url.includes('track.php')) {
      try {
        const encryptedBase64 = await response.text();
        const decrypted = await this.decryptTrackPhpResponse(encryptedBase64);
        if (!decrypted) return null;

        const data = JSON.parse(decrypted);
        if (data.code !== 200 || !data.data?.audios?.length) return null;

        // 按目标音质选择最佳档位
        const audio = this.selectBestAudio(data.data.audios, targetQuality);
        if (!audio?.url) return null;

        return {
          url: audio.url,
          quality: targetQuality,
          bitrate: this.mapLevelToBitrate(audio.level),
          format: audio.url.includes('.mp4') ? 'mp4' : 'aac',
          headers: candidate.headers,
          isEncrypted: true,
          decryptKey: audio.decrypt_key,
        };
      } catch {
        return null;
      }
    }

    // 方案3：BugPk-Api（JSON明文响应）
    if (url.includes('api.bugpk.com')) {
      try {
        const data = await response.json();
        if (data.code !== 200 || !data.data?.url) return null;
        const meta = data.data.video_meta || {};
        return {
          url: data.data.url,
          quality: Quality.HIGHER,
          bitrate: Math.round((meta.bitrate || 128000) / 1000),
          format: meta.vtype || 'm4a',
          headers: candidate.headers,
        };
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * 从分享页HTML中提取_ROUTER_DATA明文播放URL
   */
  private extractRouterDataUrl(html: string): string | null {
    // 匹配 _ROUTER_DATA = {...};
    const match = html.match(/_ROUTER_DATA\s*=\s*({[\s\S]*?});\s*<\/script>/);
    if (!match) {
      // 更宽松的匹配
      const looseMatch = html.match(/_ROUTER_DATA\s*=\s*({[\s\S]*?});/);
      if (!looseMatch) return null;
      try {
        const data = JSON.parse(looseMatch[1]);
        return data?.loaderData?.track_page?.audioWithLyricsOption?.url || null;
      } catch {
        return null;
      }
    }
    try {
      const data = JSON.parse(match[1]);
      return data?.loaderData?.track_page?.audioWithLyricsOption?.url || null;
    } catch {
      return null;
    }
  }

  /**
   * track.php AES-128-CBC解密
   * 兼容两种密钥：lxmusiclxmusiclx（IV取自密文前16字节）和 seekmusicv260409（固定IV）
   */
  private async decryptTrackPhpResponse(encryptedBase64: string): Promise<string | null> {
    try {
      const cipherText = this.base64ToUint8Array(encryptedBase64.trim());
      if (!cipherText || cipherText.length < 16) return null;

      // 尝试密钥1：lxmusiclxmusiclx + IV取自密文前16字节
      const key1 = new TextEncoder().encode('lxmusiclxmusiclx');
      const iv1 = cipherText.slice(0, 16);
      const encrypted1 = cipherText.slice(16);
      const result1 = await this.aesCbcDecrypt(encrypted1, key1, iv1);
      if (result1) return result1;

      // 尝试密钥2：seekmusicv260409 + 固定IV（去除BOM头）
      const key2 = new TextEncoder().encode('seekmusicv260409');
      const iv2 = new TextEncoder().encode('260409seekmusicv');
      let raw = cipherText;
      if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
        raw = raw.slice(3);
      }
      return await this.aesCbcDecrypt(raw, key2, iv2);
    } catch {
      return null;
    }
  }

  private async aesCbcDecrypt(encrypted: Uint8Array, key: Uint8Array, iv: Uint8Array): Promise<string | null> {
    try {
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key as unknown as BufferSource,
        { name: 'AES-CBC' },
        false,
        ['decrypt']
      );
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: iv.buffer as ArrayBuffer },
        cryptoKey,
        encrypted.buffer as ArrayBuffer,
      );
      // 去除PKCS7填充
      const padView = new Uint8Array(decrypted);
      const padLen = padView[padView.length - 1];
      if (padLen > 0 && padLen <= 16) {
        const unpadded = padView.slice(0, padView.length - padLen);
        return new TextDecoder().decode(unpadded);
      }
      return new TextDecoder().decode(decrypted);
    } catch {
      return null;
    }
  }

  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * 从track.php的audios数组中选择最佳音质
   */
  private selectBestAudio(audios: Array<{ level: string; url: string; decrypt_key?: string; raw_size?: number }>, targetQuality: Quality) {
    const levelPriority: Record<string, number> = {
      lossless: 4,
      highest: 3,
      higher: 2,
      medium: 1,
    };

    // 按优先级排序
    const sorted = [...audios].sort((a, b) => (levelPriority[b.level] || 0) - (levelPriority[a.level] || 0));

    // 根据目标音质选择
    const targetMap: Record<Quality, string[]> = {
      [Quality.LOW]: ['medium'],
      [Quality.STANDARD]: ['medium'],
      [Quality.HIGHER]: ['higher', 'medium'],
      [Quality.HIGH]: ['highest', 'higher', 'medium'],
      [Quality.LOSSLESS]: ['lossless', 'highest', 'higher'],
      [Quality.HIRES]: ['lossless', 'highest'],
      [Quality.SKY]: ['lossless'],
      [Quality.JYEFFECT]: ['lossless'],
      [Quality.HIFI]: ['lossless'],
    };

    const preferred = targetMap[targetQuality] || ['medium'];
    for (const level of preferred) {
      const found = sorted.find((a) => a.level === level);
      if (found) return found;
    }
    return sorted[0];
  }

  private mapLevelToBitrate(level: string): number {
    const map: Record<string, number> = {
      medium: 128,
      higher: 192,
      highest: 320,
      lossless: 1000,
    };
    return map[level] || 128;
  }

  private estimateBitrateFromUrl(url: string): number {
    // v5-luna.douyinvod.com 返回的URL音质不明确，按标准估算
    return 128;
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const start = Date.now();
      const response = await platformFetch(
        `https://api.qishui.com/luna/search/track?${this.commonParams.toString()}&q=test&count=1&search_method=history&cursor=0`,
        {
          method: 'GET',
          headers: { 'User-Agent': QISHUI_UA },
          signal: AbortSignal.timeout(10000),
        }
      );
      return {
        healthy: response.ok,
        message: response.ok ? '汽水音乐服务正常' : '汽水音乐服务异常',
        latency: Date.now() - start,
      };
    } catch {
      return { healthy: false, message: '汽水音乐服务不可用' };
    }
  }
}
