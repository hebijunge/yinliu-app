import { useState, useCallback, useEffect } from 'react';
import { Search, Music, Radio, Loader2 } from 'lucide-react';
import { djModule } from '../modules/dj';
import type { DjCategory, DjSearchResult } from '../modules/dj';
import { playerEngine } from '../core/player';
import { SkeletonSearchResult } from '../components/ui/Skeleton';

export default function DjPage() {
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<DjSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [categories, setCategories] = useState<DjCategory[]>([]);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  // 初始化分类
  useEffect(() => {
    djModule.getAllCategories().then(setCategories);
  }, []);

  const handleSearch = useCallback(async () => {
    if (!keyword.trim()) return;

    setIsSearching(true);
    try {
      const { results } = await djModule.search({ keyword, pageSize: 30 });
      setResults(results);
    } catch (err) {
      console.error('DJ搜索失败:', err);
    } finally {
      setIsSearching(false);
    }
  }, [keyword]);

  const handleCategoryClick = useCallback(async (categoryId: string) => {
    setActiveCategory(categoryId);
    setIsSearching(true);

    try {
      const params = djModule.getCategoryParams(categoryId);
      const { results } = await djModule.search({ keyword: '', ...params, pageSize: 30 });
      setResults(results);
    } catch (err) {
      console.error('DJ分类加载失败:', err);
    } finally {
      setIsSearching(false);
    }
  }, []);

  const handlePlay = async (result: DjSearchResult) => {
    const source = djModule.getSource(result.sourceId);
    if (!source) return;

    const url = await source.getPlayUrl(result.id);
    if (!url) return;

    await playerEngine.playTrack({
      id: result.id,
      title: result.title,
      artist: result.artist,
      duration: result.duration,
      coverUrl: result.coverUrl,
      sourceId: result.sourceId,
      sourceSongId: result.id,
      uri: `dj://${result.sourceId}/${result.id}`,
    });
  };

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6 hidden lg:block flex items-center gap-2">
        <Radio className="w-6 h-6" />
        DJ舞曲
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
            placeholder="搜索DJ舞曲..."
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

      {/* Categories */}
      <div className="mb-6">
        <h2 className="text-sm font-medium text-[var(--text-secondary)] mb-3">分类浏览</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => handleCategoryClick(cat.id)}
              className={`p-3 rounded-xl text-left transition-all focus-ring ${
                activeCategory === cat.id
                  ? 'bg-[var(--accent-soft)] border border-[var(--accent)]/30 shadow-sm'
                  : 'bg-[var(--bg-secondary)] border border-[var(--border-subtle)] hover:border-[var(--accent)]/20 hover:shadow-sm'
              }`}
            >
              <div className="font-medium text-sm">{cat.name}</div>
              {cat.description && (
                <div className="text-xs text-[var(--text-tertiary)] mt-0.5">{cat.description}</div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Skeleton Loading */}
      {isSearching && (
        <SkeletonSearchResult count={5} />
      )}

      {/* Results */}
      {!isSearching && (
        <div className="space-y-2">
          {results.map((result) => (
            <div
              key={result.id}
              className="flex items-center gap-3 p-3 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] hover:border-[var(--accent)]/30 hover:shadow-sm transition-all duration-200 group"
            >
              <div className="w-12 h-12 rounded-xl bg-[var(--bg-tertiary)] flex-shrink-0 flex items-center justify-center shadow-sm ring-1 ring-[var(--border-subtle)]">
                <Music className="w-5 h-5 text-[var(--text-tertiary)]" />
              </div>

              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{result.title}</div>
                <div className="text-sm text-[var(--text-secondary)] truncate">
                  {result.artist} {result.bpm && `· ${result.bpm} BPM`}
                </div>
              </div>

              <div className="text-xs text-[var(--text-tertiary)] hidden sm:block font-medium">
                {result.style}
              </div>

              <button
                onClick={() => handlePlay(result)}
                className="p-2.5 rounded-full bg-[var(--accent)] text-white opacity-0 group-hover:opacity-100 transition-all hover:bg-[var(--accent-hover)] active:scale-95 shadow-sm focus-ring"
                title="播放"
              >
                <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {results.length === 0 && !isSearching && (
        <div className="text-center py-16">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-[var(--bg-tertiary)] flex items-center justify-center">
            <Radio className="w-8 h-8 text-[var(--text-tertiary)]" />
          </div>
          <p className="text-[var(--text-tertiary)]">选择分类或搜索DJ舞曲</p>
        </div>
      )}
    </div>
  );
}
