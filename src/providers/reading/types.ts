// === 书源通用接口 ===

export interface BookSearchParams {
  keyword: string;
  page?: number;
  pageSize?: number;
}

export interface BookSearchResult {
  id: string;
  sourceId: string;
  sourceBookId: string;
  title: string;
  author?: string;
  coverUrl?: string;
  description?: string;
  wordCount?: number;
  category?: string;
  status?: 'ongoing' | 'completed';
  totalChapters?: number;
  lastUpdateTime?: number;
}

export interface ChapterInfo {
  id: string;
  bookId: string;
  chapterIndex: number;
  title: string;
  isVip?: boolean;
  wordCount?: number;
}

export interface ChapterContent {
  chapterIndex: number;
  title: string;
  content: string;
  wordCount: number;
}

export interface BookSource {
  readonly id: string;
  readonly name: string;
  enabled: boolean;

  searchBooks(params: BookSearchParams): Promise<BookSearchResult[]>;
  getBookDetail(bookId: string): Promise<BookSearchResult | null>;
  getChapterList(bookId: string): Promise<ChapterInfo[]>;
  getChapterContent(bookId: string, chapterIndex: number): Promise<ChapterContent | null>;
  healthCheck(): Promise<{ healthy: boolean; message: string }>;
}
