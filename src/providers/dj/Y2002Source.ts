import type { DjSource, DjSearchParams, DjSearchResult, DjCategory } from '@modules/dj';

/**
 * Y2002音乐网DJ源
 * 域名：pc-api.yy-5.com / www.y2002.com
 * 认证：主站HTML提取var mu签名直链
 */
export class Y2002Source implements DjSource {
  readonly id = 'y2002';
  readonly name = 'Y2002音乐网';
  readonly baseUrl = 'https://pc-api.yy-5.com';
  enabled = true;

  async search(params: DjSearchParams): Promise<DjSearchResult[]> {
    try {
      const query = new URLSearchParams({
        keyword: params.keyword,
        page: String((params.page || 0) + 1),
        pagesize: String(params.pageSize || 20),
      });

      const response = await fetch(`${this.baseUrl}/api/search?${query}`, {
        headers: { 'User-Agent': 'Y2002App/1.0' },
      });

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
      { id: 'house', name: 'House', type: 'style' },
      { id: 'trance', name: 'Trance', type: 'style' },
      { id: 'techno', name: 'Techno', type: 'style' },
      { id: 'dubstep', name: 'Dubstep', type: 'style' },
    ];
  }

  async getSongsByCategory(categoryId: string): Promise<DjSearchResult[]> {
    return this.search({ keyword: categoryId, pageSize: 30 });
  }

  async getPlayUrl(songId: string): Promise<string | null> {
    try {
      const response = await fetch(`${this.baseUrl}/api/playurl?id=${songId}`);
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
      bitrate: item.bitrate || 128,
      sourceId: this.id,
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    try {
      const response = await fetch('https://www.y2002.com', {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      return {
        healthy: response.ok,
        message: response.ok ? 'Y2002服务正常' : '服务异常',
      };
    } catch {
      return { healthy: false, message: 'Y2002服务不可用' };
    }
  }
}
