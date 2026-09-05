import type {
  BookSource,
  BookSearchParams,
  BookSearchResult,
  ChapterInfo,
  ChapterContent,
} from './types';

/**
 * 番茄小说书源Provider
 * 域名：fanqienovel.com / fanqiesdk.com
 * 特色：需要X-Gorgon/X-Argus/X-Ladon签名体系
 * API：基于番茄小说App逆向接口
 */
export class FanqieSource implements BookSource {
  readonly id = 'fanqie';
  readonly name = '番茄小说';
  enabled = true;

  private readonly apiBase = 'https://fanqienovel.com/api';
  private readonly readerBase = 'https://fanqienovel.com/reader';

  // 章节内容缓存
  private chapterCache = new Map<string, ChapterContent>();

  /**
   * 搜索书籍
   */
  async searchBooks(params: BookSearchParams): Promise<BookSearchResult[]> {
    const page = params.page || 0;
    const pageSize = params.pageSize || 20;

    try {
      const url = `${this.apiBase}/author/search/search_book/v1/?filter=127&page_count=${pageSize}&page_index=${page}&query=${encodeURIComponent(params.keyword)}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://fanqienovel.com',
        },
        // C1: 裸 fetch 统一补超时
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return this.fallbackSearch(params);
      }

      const data = await response.json();
      const books = data?.data?.search_book_data_list || [];

      return books.map((item: any) => this.mapSearchResult(item));
    } catch {
      return this.fallbackSearch(params);
    }
  }

  private fallbackSearch(params: BookSearchParams): BookSearchResult[] {
    return [];
  }

  private mapSearchResult(item: any): BookSearchResult {
    const bookId = item.book_id || item.id || '';
    return {
      id: `fanqie_${bookId}`,
      sourceId: this.id,
      sourceBookId: bookId.toString(),
      title: item.book_name || item.title || '未知书籍',
      author: item.author || item.author_name || '未知作者',
      coverUrl: item.thumb_url || item.cover || '',
      description: item.description || item.abstract || '',
      wordCount: item.word_number || item.word_count || 0,
      category: item.category || item.category_name || '',
      status: item.creation_status === 1 ? 'ongoing' : 'completed',
      totalChapters: item.serial_count || item.total_chapters || 0,
      lastUpdateTime: item.last_publish_time || 0,
    };
  }

  /**
   * 获取书籍详情
   */
  async getBookDetail(bookId: string): Promise<BookSearchResult | null> {
    const id = this.extractBookId(bookId);

    try {
      const url = `${this.apiBase}/book/detail/?book_id=${id}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36',
        },
        // C1: 裸 fetch 统一补超时
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) return null;

      const data = await response.json();
      const book = data?.data;

      if (!book) return null;

      return this.mapSearchResult(book);
    } catch {
      return null;
    }
  }

  /**
   * 获取章节列表
   */
  async getChapterList(bookId: string): Promise<ChapterInfo[]> {
    const id = this.extractBookId(bookId);

    try {
      const url = `${this.apiBase}/book/catalog/?book_id=${id}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36',
        },
        // C1: 裸 fetch 统一补超时
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) return [];

      const data = await response.json();
      const items = data?.data?.item_list || data?.data?.catalog || [];

      return items.map((item: any, index: number) => ({
        id: `fanqie_ch_${id}_${index}`,
        bookId,
        chapterIndex: index,
        title: item.title || `第${index + 1}章`,
        isVip: item.is_vip || false,
        wordCount: item.word_count || 0,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 获取章节内容
   * 包含缓存策略
   */
  async getChapterContent(bookId: string, chapterIndex: number): Promise<ChapterContent | null> {
    const cacheKey = `${bookId}_${chapterIndex}`;

    // 检查缓存
    const cached = this.chapterCache.get(cacheKey);
    if (cached) return cached;

    const id = this.extractBookId(bookId);

    try {
      // 尝试通过reader页面获取内容
      const url = `${this.readerBase}/${id}/chapter/${chapterIndex + 1}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36',
        },
        // C1: 裸 fetch 统一补超时
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return null;
      }

      const html = await response.text();

      // 从HTML中提取内容
      const content = this.extractContentFromHtml(html);
      const title = this.extractTitleFromHtml(html);

      if (!content) {
        return null;
      }

      const result: ChapterContent = {
        chapterIndex,
        title: title || `第${chapterIndex + 1}章`,
        content,
        wordCount: content.length,
      };

      // 缓存内容（LRU策略：最多缓存50章）
      this.setChapterCache(cacheKey, result);

      return result;
    } catch {
      return null;
    }
  }

  private extractContentFromHtml(html: string): string {
    // 尝试多种方式提取正文
    // 方式1: 从JSON数据中提取
    const jsonMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});/);
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1]);
        const content = data?.chapterContent || data?.content || '';
        if (content) return this.cleanContent(content);
      } catch {
        // 解析失败，继续尝试其他方式
      }
    }

    // 方式2: 从DOM中提取
    const contentMatch = html.match(/<div[^>]*class="[^"]*chapter-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (contentMatch) {
      return this.cleanContent(contentMatch[1]);
    }

    // 方式3: 从article标签提取
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (articleMatch) {
      return this.cleanContent(articleMatch[1]);
    }

    return '';
  }

  private extractTitleFromHtml(html: string): string {
    const match = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
    if (match) return match[1].trim();

    const jsonMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});/);
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1]);
        return data?.chapterTitle || data?.title || '';
      } catch {
        return '';
      }
    }

    return '';
  }

  private cleanContent(raw: string): string {
    return raw
      .replace(/<[^>]+>/g, '\n')  // 移除HTML标签
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n')  // 压缩多余空行
      .trim();
  }

  private setChapterCache(key: string, content: ChapterContent): void {
    // LRU：最多缓存50章
    if (this.chapterCache.size >= 50) {
      const firstKey = this.chapterCache.keys().next().value;
      if (firstKey !== undefined) {
        this.chapterCache.delete(firstKey);
      }
    }
    this.chapterCache.set(key, content);
  }

  private extractBookId(bookId: string): string {
    if (bookId.startsWith('fanqie_')) {
      return bookId.slice(7);
    }
    return bookId;
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    try {
      const response = await fetch('https://fanqienovel.com', {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      return {
        healthy: response.ok,
        message: response.ok ? '番茄小说服务正常' : '番茄小说服务异常',
      };
    } catch {
      return { healthy: false, message: '番茄小说服务不可用' };
    }
  }
}
