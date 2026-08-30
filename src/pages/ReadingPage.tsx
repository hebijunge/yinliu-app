import { useState, useCallback } from 'react';
import { Search, BookOpen, ChevronLeft, ChevronRight, Bookmark, Loader2 } from 'lucide-react';
import { FanqieSource } from '../providers/reading/FanqieSource';
import type { BookSearchResult, ChapterInfo, ChapterContent } from '../providers/reading/types';

const fanqieSource = new FanqieSource();

export default function ReadingPage() {
  const [keyword, setKeyword] = useState('');
  const [books, setBooks] = useState<BookSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedBook, setSelectedBook] = useState<BookSearchResult | null>(null);
  const [chapters, setChapters] = useState<ChapterInfo[]>([]);
  const [currentChapter, setCurrentChapter] = useState<ChapterContent | null>(null);
  const [currentChapterIndex, setCurrentChapterIndex] = useState(0);
  const [showCatalog, setShowCatalog] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!keyword.trim()) return;
    setIsSearching(true);
    try {
      const results = await fanqieSource.searchBooks({ keyword, pageSize: 20 });
      setBooks(results);
    } catch (err) {
      console.error('搜索失败:', err);
    } finally {
      setIsSearching(false);
    }
  }, [keyword]);

  const loadBook = async (book: BookSearchResult) => {
    setIsLoading(true);
    setSelectedBook(book);
    try {
      const list = await fanqieSource.getChapterList(book.sourceBookId);
      setChapters(list);
      if (list.length > 0) {
        await loadChapter(0);
      }
    } catch (err) {
      console.error('加载书籍失败:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const loadChapter = async (index: number) => {
    if (!selectedBook || index < 0 || index >= chapters.length) return;

    setIsLoading(true);
    setCurrentChapterIndex(index);
    try {
      const content = await fanqieSource.getChapterContent(
        selectedBook.sourceBookId,
        index
      );
      setCurrentChapter(content);
    } catch (err) {
      console.error('加载章节失败:', err);
    } finally {
      setIsLoading(false);
      setShowCatalog(false);
    }
  };

  // 阅读器视图
  if (selectedBook && currentChapter) {
    return (
      <div className="max-w-2xl mx-auto">
        {/* Reader Header */}
        <div className="flex items-center justify-between mb-4">
          <button
            onClick={() => {
              setSelectedBook(null);
              setCurrentChapter(null);
              setChapters([]);
            }}
            className="flex items-center gap-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <ChevronLeft className="w-4 h-4" />
            返回
          </button>
          <h2 className="font-medium truncate flex-1 mx-4 text-center">{selectedBook.title}</h2>
          <button
            onClick={() => setShowCatalog(!showCatalog)}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            目录
          </button>
        </div>

        {/* Catalog Drawer */}
        {showCatalog && (
          <div className="yinliu-card mb-4 max-h-64 overflow-y-auto">
            <div className="text-sm font-medium mb-2">章节目录</div>
            <div className="space-y-1">
              {chapters.map((ch, idx) => (
                <button
                  key={ch.id}
                  onClick={() => loadChapter(idx)}
                  className={`w-full text-left px-2 py-1.5 rounded text-sm ${
                    idx === currentChapterIndex
                      ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                      : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
                  }`}
                >
                  {ch.title}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Chapter Content */}
        <div className="yinliu-card min-h-[50vh]">
          <h1 className="text-xl font-bold mb-4">{currentChapter.title}</h1>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
            </div>
          ) : (
            <div className="leading-loose text-[var(--text-primary)] whitespace-pre-wrap">
              {currentChapter.content}
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between mt-4">
          <button
            onClick={() => loadChapter(currentChapterIndex - 1)}
            disabled={currentChapterIndex <= 0}
            className="yinliu-btn-secondary flex items-center gap-1 disabled:opacity-50"
          >
            <ChevronLeft className="w-4 h-4" />
            上一章
          </button>
          <span className="text-sm text-[var(--text-secondary)]">
            {currentChapterIndex + 1} / {chapters.length}
          </span>
          <button
            onClick={() => loadChapter(currentChapterIndex + 1)}
            disabled={currentChapterIndex >= chapters.length - 1}
            className="yinliu-btn-secondary flex items-center gap-1 disabled:opacity-50"
          >
            下一章
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  // 书籍列表视图
  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6 hidden lg:block flex items-center gap-2">
        <BookOpen className="w-6 h-6" />
        阅读
      </h1>

      {/* Search */}
      <div className="flex gap-2 mb-6">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-tertiary)]" />
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="搜索书籍..."
            className="yinliu-input w-full pl-10"
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={isSearching}
          className="yinliu-btn flex items-center gap-2"
        >
          {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          搜索
        </button>
      </div>

      {/* Books Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {books.map((book) => (
          <button
            key={book.id}
            onClick={() => loadBook(book)}
            className="text-left group"
          >
            <div className="aspect-[3/4] rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] overflow-hidden mb-2 group-hover:border-[var(--accent)]/30 transition-colors">
              {book.coverUrl ? (
                <img src={book.coverUrl} alt={book.title} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <BookOpen className="w-8 h-8 text-[var(--text-tertiary)]" />
                </div>
              )}
            </div>
            <div className="font-medium text-sm truncate">{book.title}</div>
            <div className="text-xs text-[var(--text-secondary)]">{book.author}</div>
            {book.wordCount && (
              <div className="text-xs text-[var(--text-tertiary)]">
                {(book.wordCount / 10000).toFixed(1)}万字
              </div>
            )}
          </button>
        ))}
      </div>

      {books.length === 0 && !isSearching && (
        <div className="text-center py-12 text-[var(--text-tertiary)]">
          搜索你想看的书籍
        </div>
      )}
    </div>
  );
}
