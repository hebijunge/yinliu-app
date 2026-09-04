import { useState, useCallback } from 'react';
import { Search, BookOpen, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { FanqieSource } from '../providers/reading/FanqieSource';
import type { BookSearchResult, ChapterInfo, ChapterContent } from '../providers/reading/types';
import { SkeletonPlaylistGrid } from '../components/ui/Skeleton';
import SmartCover from '../components/ui/SmartCover';

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
        <div className="flex items-center justify-between mb-5">
          <button
            onClick={() => {
              setSelectedBook(null);
              setCurrentChapter(null);
              setChapters([]);
            }}
            className="flex items-center gap-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus-ring rounded-xl px-3 py-2"
          >
            <ChevronLeft className="w-4 h-4" />
            返回
          </button>
          <h2 className="font-medium truncate flex-1 mx-4 text-center text-[var(--text-primary)]">{selectedBook.title}</h2>
          <button
            onClick={() => setShowCatalog(!showCatalog)}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus-ring rounded-xl px-3 py-2"
          >
            目录
          </button>
        </div>

        {/* Catalog Drawer */}
        {showCatalog && (
          <div className="yinliu-card mb-5 max-h-64 overflow-y-auto">
            <div className="text-sm font-semibold mb-3 text-[var(--text-primary)]">章节目录</div>
            <div className="space-y-0.5">
              {chapters.map((ch, idx) => (
                <button
                  key={ch.id}
                  onClick={() => loadChapter(idx)}
                  className={`w-full text-left px-3 py-2 rounded-xl text-sm transition-colors focus-ring ${
                    idx === currentChapterIndex
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium'
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
          <h1 className="text-xl font-semibold mb-5 text-[var(--text-primary)]">{currentChapter.title}</h1>
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
        <div className="flex items-center justify-between mt-5">
          <button
            onClick={() => loadChapter(currentChapterIndex - 1)}
            disabled={currentChapterIndex <= 0}
            className="yinliu-btn-secondary flex items-center gap-1 disabled:opacity-50"
          >
            <ChevronLeft className="w-4 h-4" />
            上一章
          </button>
          <span className="text-sm text-[var(--text-secondary)] font-medium">
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

  // 搜索视图
  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-light mb-8 hidden lg:block flex items-center gap-3 text-[var(--text-primary)]">
        <BookOpen className="w-6 h-6" />
        阅读
      </h1>

      {/* Search */}
      <div className="flex gap-3 mb-6">
        <div className="flex-1 relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-tertiary)]" />
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="搜索小说..."
            className="yinliu-input w-full pl-12"
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

      {/* Skeleton Loading */}
      {isSearching && (
        <SkeletonPlaylistGrid count={4} />
      )}

      {/* Results */}
      {!isSearching && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {books.map((book) => (
            <button
              key={book.id}
              onClick={() => loadBook(book)}
              className="text-left rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] overflow-hidden hover:border-[var(--accent)]/30 transition-all duration-200 focus-ring"
            >
              <div className="aspect-[3/4] bg-[var(--bg-tertiary)] flex items-center justify-center">
                {book.coverUrl ? (
                  <SmartCover src={book.coverUrl} alt="" className="w-full h-full" />
                ) : (
                  <BookOpen className="w-10 h-10 text-[var(--text-tertiary)]" />
                )}
              </div>
              <div className="p-4">
                <h3 className="font-medium truncate text-sm text-[var(--text-primary)]">{book.title}</h3>
                <p className="text-xs text-[var(--text-secondary)] mt-1">{book.author}</p>
              </div>
            </button>
          ))}
        </div>
      )}

      {books.length === 0 && !isSearching && (
        <div className="text-center py-20">
          <div className="w-16 h-16 mx-auto mb-5 rounded-3xl bg-[var(--bg-tertiary)] flex items-center justify-center">
            <BookOpen className="w-8 h-8 text-[var(--text-tertiary)]" />
          </div>
          <p className="text-[var(--text-tertiary)]">搜索小说开始阅读</p>
        </div>
      )}
    </div>
  );
}
