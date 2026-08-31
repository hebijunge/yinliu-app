import type { DjSource, DjSearchParams, DjSearchResult, DjCategory } from '@modules/dj';

/**
 * 火龙DJ源
 * 域名：app-a-djyyk.y2002.com
 * 与DJ串烧集同基础设施但独立App接口
 */
export class HuoLongDjSource implements DjSource {
  readonly id = 'huolongdj';
  readonly name = '火龙DJ';
  readonly baseUrl = 'https://app-a-djyyk.y2002.com';
  enabled = true;

  private readonly utoken = 'Q^q1CnqH%AcYxozSI9bJTTccgy4P#Wje';
  private readonly fdkey = '59b9129ad2bbc089d6bb19a8b1abc4898b886aa8';

  private generateSign(params: Record<string, string | number>): string {
    const sortedKeys = Object.keys(params).sort();
    const paramStr = sortedKeys.map((k) => `${k}=${params[k]}`).join('&');
    return this.md5(paramStr + this.utoken);
  }

  private md5(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return Math.abs(hash).toString(16).padStart(32, '0');
  }

  async search(params: DjSearchParams): Promise<DjSearchResult[]> {
    const reqParams: Record<string, string | number> = {
      keyword: params.keyword,
      page: params.page || 1,
      pagesize: params.pageSize || 20,
      utoken: this.utoken,
      timestamp: Date.now(),
    };
    reqParams.sign = this.generateSign(reqParams);

    try {
      const query = new URLSearchParams(
        Object.entries(reqParams).map(([k, v]) => [k, String(v)])
      );
      const response = await fetch(`${this.baseUrl}/api/search?${query}`);
      if (!response.ok) return [];

      const data = await response.json();
      const list = data?.data?.list || [];
      return list.map((item: any) => this.mapResult(item));
    } catch {
      return [];
    }
  }

  async getCategories(): Promise<DjCategory[]> {
    return [
      { id: 'edm', name: 'EDM', type: 'style' },
      { id: 'bounce', name: 'Bounce', type: 'style' },
      { id: 'hardstyle', name: 'Hardstyle', type: 'style' },
    ];
  }

  async getSongsByCategory(categoryId: string): Promise<DjSearchResult[]> {
    return this.search({ keyword: categoryId, pageSize: 30 });
  }

  async getPlayUrl(songId: string): Promise<string | null> {
    const reqParams: Record<string, string | number> = {
      id: songId,
      quality: '320',
      utoken: this.utoken,
      timestamp: Date.now(),
    };
    reqParams.sign = this.generateSign(reqParams);

    try {
      const query = new URLSearchParams(
        Object.entries(reqParams).map(([k, v]) => [k, String(v)])
      );
      const response = await fetch(`${this.baseUrl}/api/playurl?${query}`);
      if (!response.ok) return null;

      const data = await response.json();
      return data?.data?.url || null;
    } catch {
      return null;
    }
  }

  private mapResult(item: any): DjSearchResult {
    return {
      id: item.id || item.songid || '',
      title: item.name || item.title || '未知DJ',
      artist: item.artist || item.singer || '',
      bpm: item.bpm || 0,
      style: item.style || item.category || '',
      duration: item.duration || item.length || 0,
      coverUrl: item.cover || item.pic || '',
      bitrate: item.bitrate || 320,
      sourceId: this.id,
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    try {
      const response = await fetch(this.baseUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      return {
        healthy: response.ok,
        message: response.ok ? '火龙DJ服务正常' : '服务异常',
      };
    } catch {
      return { healthy: false, message: '火龙DJ服务不可用' };
    }
  }
}
