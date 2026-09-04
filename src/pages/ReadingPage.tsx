import { useState, useCallback, useRef, useEffect } from 'react';
import { Search, BookOpen, ChevronLeft, ChevronRight, Loader2, AlertCircle } from 'lucide-react';
import { FanqieSource } from '../providers/reading/FanqieSource';
import type { BookSearchResult, ChapterInfo, ChapterContent } from '../providers/reading/types';
import { SkeletonPlaylistGrid } from '../components/ui/Skeleton';
import SmartCover from '../components/ui/SmartCover';

const fanqieSource = new FanqieSource();

export default function ReadingPage() {
  const [keyword, setKeyword] = useState('');
  const [books, setBooks] = useState<BookSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [selectedBook, setSelectedBook] = useState<BookSearchResult | null>(null);
  const [chapters, setChapters] = useState<ChapterInfo[]>([]);
  const [currentChapter, setCurrentChapter] = useState<ChapterContent | null>(null);
  const [currentChapterIndex, setCurrentChapterIndex] = useState(0);
  const [showCatalog, setShowCatalog] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [chapterError, setChapterError] = useState('');
  const [bookError, setBookError] = useState('');

  // P1 竞态守卫：搜索 / 开书 / 加载章节各自递增请求号，只允许最新一次请求写状态
  const searchReqRef = useRef(0);
  const bookReqRef = useRef(0);
  const chapterReqRef = useRef(0);

  useEffect(() => {
    // 卸载时废弃所有在途请求的写回资格
    return () => {
      searchReqRef.current++;
      bookReqRef.current++;
      chapterReqRef.current++;
    };
  }, []);

  const handleSearch = useCallback(async () => {
    const kw = keyword.trim();
    if (!kw) return;
    const reqId = ++searchReqRef.current;
    setIsSearching(true);
    setSearchError('');
    try {
      const results = await fanqieSource.searchBooks({ keyword: kw, pageSize: 20 });
      if (reqId !== searchReqRef.current) return; // 已有更新的搜索，丢弃本次结果
      setBooks(results);
    } catch (err) {
      console.error('搜索失败:', err);
      if (reqId !== searchReqRef.current) return;
      setSearchError(err instanceof Error ? err.message : '搜索失败，请稍后重试');
      setBooks([]);
    } finally {
      if (reqId === searchReqRef.current) {
        setIsSearching(false);
      }
    }
  }, [keyword]);

  const loadBook = async (book: BookSearchResult) => {
    // P1：打开新书前清空旧书全部状态，避免旧章节内容/索引串台
    const reqId = ++bookReqRef.current;
    setSelectedBook(book);
    setChapters([]);
    setCurrentChapter(null);
    setCurrentChapterIndex(0);
    setChapterError('');
    setBookError('');
    setShowCatalog(false);
    setIsLoading(true);
    try {
      const list = await fanqieSource.getChapterList(book.sourceBookId);
      if (reqId !== bookReqRef.current) return; // 期间又打开了别的书，丢弃
      setChapters(list);
      if (list.length > 0) {
        await loadChapter(0, book, list);
      }
    } catch (err) {
      console.error('加载书籍失败:', err);
      if (reqId !== bookReqRef.current) return;
      // P1：章节目录加载失败给出错误态而非静默退出
      setBookError(err instanceof Error ? err.message : '章节目录加载失败，请稍后重试');
    } finally {
      if (reqId === bookReqRef.current) {
        setIsLoading(false);
      }
    }
  };

  const loadChapter = async (index: number, bookOverride?: BookSearchResult | null, chaptersOverride?: ChapterInfo[]) => {
    const book = bookOverride ?? selectedBook;
    const chapterList = chaptersOverride ?? chapters;
    if (!book || index < 0 || index >= chapterList.length) return;

    // P1 并发守卫：快速连点上一章/下一章时只让最后一次请求生效
    const reqId = ++chapterReqRef.current;
    setIsLoading(true);
    setCurrentChapterIndex(index);
    setChapterError('');
    try {
      const content = await fanqieSource.getChapterContent(
        book.sourceBookId,
        index
      );
      if (reqId !== chapterReqRef.current) return; // 已切换到其他章节，丢弃
      setCurrentChapter(content);
    } catch (err) {
      console.error('加载章节失败:', err);
      if (reqId !== chapterReqRef.current) return;
      // P1：章节加载失败给出错误态 + 重试入口，而非静默退出
      setChapterError(err instanceof Error ? err.message : '章节加载失败，请稍后重试');
    } finally {
      if (reqId === chapterReqRef.current) {
        setIsLoading(false);
        setShowCatalog(false);
      }
    }
  };

  const retryCurrentChapter = () => {
    void loadChapter(currentChapterIndex);
  };

  const backToSearch = () => {
    bookReqRef.current++;
    chapterReqRef.current++;
    setSelectedBook(null);
    setCurrentChapter(null);
    setChapters([]);
    setChapterError('');
    setBookError('');
    setCurrentChapterIndex(0);
    setShowCatalog(false);
  };

  // 阅读器视图
  if (selectedBook && currentChapter) {
    return (
      <div className="max-w-2xl mx-auto">
        {/* Reader Header */}
        <div className="flex items-center justify-between mb-5">
          <button
            onClick={backToSearch}
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
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
            </div>
          ) : chapterError ? (
            /* P1：章节加载失败错误态 + 重试 */
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <AlertCircle className="w-10 h-10 text-red-400 mb-3" />
              <p className="text-sm text-[var(--text-secondary)] mb-4">{chapterError}</p>
              <button onClick={retryCurrentChapter} className="yinliu-btn">
                重试
              </button>
            </div>
          ) : (
            <div>
              <h1 className="text-xl font-semibold mb-5 text-[var(--text-primary)]">{currentChapter.title}</h1>
              <div className="leading-loose text-[var(--text-primary)] whitespace-pre-wrap">
                {currentChapter.content}
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between mt-5">
          <button
            onClick={() => loadChapter(currentChapterIndex - 1)}
            disabled={currentChapterIndex <= 0 || isLoading}
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
            disabled={currentChapterIndex >= chapters.length - 1 || isLoading}
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

      {/* P1：搜索失败错误态 + 重试 */}
      {!isSearching && searchError && (
        <div className="yinliu-card flex flex-col items-center py-10 text-center">
          <AlertCircle className="w-10 h-10 text-red-400 mb-3" />
          <p className="text-sm text-[var(--text-secondary)] mb-4">{searchError}</p>
          <button onClick={handleSearch} className="yinliu-btn">
            重试
          </button>
        </div>
      )}

      {/* P1：书籍打开后章节目录加载失败的错误态（未进入阅读器） */}
      {!isSearching && !searchError && selectedBook && bookError && !currentChapter && (
        <div className="yinliu-card flex flex-col items-center py-10 text-center">
          <AlertCircle className="w-10 h-10 text-red-400 mb-3" />
          <p className="text-sm text-[var(--text-secondary)] mb-1">《{selectedBook.title}》打开失败</p>
          <p className="text-xs text-[var(--text-tertiary)] mb-4">{bookError}</p>
          <div className="flex gap-2">
            <button onClick={() => loadBook(selectedBook)} className="yinliu-btn">
              重试
            </button>
            <button onClick={backToSearch} className="yinliu-btn-secondary">
              返回搜索
            </button>
          </div>
        </div>
      )}

      {/* Results */}
      {!isSearching && !searchError && !(selectedBook && bookError && !currentChapter) && (
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

      {books.length === 0 && !isSearching && !searchError && (
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
