import { useState, useCallback } from 'react';
import { Trophy, ListMusic, Music, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from '../shared/components/Toast';
import { playerEngine } from '../core/player';
import { downloadEngine } from '../core/download';
import { useSearchStore } from '../shared/store/searchStore';
import SongListItem from '../components/common/SongListItem';
import DownloadQualitySheet from '../components/common/DownloadQualitySheet';
import type { AggregatedSearchResult } from '../core/search';
import {
  RANK_CATEGORIES,
  PLAYLIST_CATEGORIES,
  PLATFORM_DISPLAY_ORDER,
  PLATFORM_META,
} from '../shared/data';

/** 榜单分类图标映射（无 icon 字段时兜底） */
const CATEGORY_ICONS: Record<string, string> = {
  hot: '🔥',
  new: '🆕',
  rising: '📈',
  original: '✨',
  viral: '🌐',
  western: '🌍',
  jpkorean: '🇯🇵',
  chinese: '🇨🇳',
  cantonese: '🎤',
  chineseStyle: '🏮',
  dj: '🎧',
  rap: '🎤',
  rockFolk: '🎸',
  ost: '🎬',
  acg: '🎮',
  global: '🌎',
  retro: '📻',
  vip: '👑',
  scene: '🚗',
  other: '🎁',
};

/** 歌单分类图标映射 */
const PLAYLIST_ICONS: Record<string, string> = {
  pop: '🎵',
  rock: '🎸',
  folk: '🍃',
  electronic: '⚡',
  rap: '🎤',
  rnb: '🎷',
  chineseStyle: '🏮',
  western: '🌍',
  jpkorean: '🇯🇵',
  chinese: '🇨🇳',
  dj: '🎧',
  ost: '🎬',
  acg: '🎮',
  retro: '📻',
  light: '☁️',
  healing: '💆',
  study: '📚',
  workout: '💪',
  sleep: '🌙',
  other: '🎁',
};

/** 分类关键词 → 搜索词（模拟榜单内容） */
const KEYWORD_MAP: Record<string, string> = {
  hot: '热门',
  new: '新歌',
  rising: '飙升',
  original: '原创',
  viral: '网络歌曲',
  western: '欧美',
  jpkorean: '日韩',
  chinese: '华语',
  cantonese: '粤语',
  chineseStyle: '国风',
  dj: 'DJ',
  rap: '说唱',
  rockFolk: '摇滚',
  ost: '影视',
  acg: 'ACG',
  global: '全球',
  retro: '经典',
  vip: 'VIP',
  scene: '车载',
  other: '轻音乐',
};

type LibraryTab = 'charts' | 'playlists';

export default function LibraryPage() {
  const [activeTab, setActiveTab] = useState<LibraryTab>('charts');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [categoryResults, setCategoryResults] = useState<AggregatedSearchResult[]>([]);
  const [isLoadingCategory, setIsLoadingCategory] = useState(false);
  const { selectedQuality } = useSearchStore();
  const navigate = useNavigate();

  // 下载音质弹窗
  const [downloadSheetOpen, setDownloadSheetOpen] = useState(false);
  const [downloadSheetSong, setDownloadSheetSong] = useState<AggregatedSearchResult | null>(null);

  const handleCategoryClick = useCallback(async (categoryId: string) => {
    setSelectedCategory(categoryId);
    setIsLoadingCategory(true);
    setCategoryResults([]);

    try {
      const { searchEngine } = await import('../core/search');
      const { results } = await searchEngine.search(
        { keyword: KEYWORD_MAP[categoryId] || '热门', page: 0, pageSize: 30 },
        { timeout: 12000 }
      );
      setCategoryResults(results.slice(0, 30));
    } catch (err) {
      console.error('Category load failed:', err);
    } finally {
      setIsLoadingCategory(false);
    }
  }, []);

  const handleBack = () => {
    setSelectedCategory(null);
    setCategoryResults([]);
  };

  const handlePlay = async (result: AggregatedSearchResult) => {
    if (!result.sources || result.sources.length === 0) {
      toast.error('暂无可用音源');
      return;
    }
    try {
      await playerEngine.playTrack({
        id: result.id,
        title: result.title,
        artist: result.artist,
        album: result.album,
        coverUrl: result.coverUrl,
        duration: result.duration,
        sourceId: result.sourceId,
        sourceSongId: result.sourceSongId,
        uri: `stream://${result.sourceId}/${result.sourceSongId}`,
        availableSources: result.sources.map((s) => ({
          sourceId: s.sourceId,
          sourceSongId: s.sourceSongId,
        })),
      }, selectedQuality);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '播放失败';
      toast.error('播放失败', msg);
    }
  };

  const handleMore = (result: AggregatedSearchResult) => {
    setDownloadSheetSong(result);
    setDownloadSheetOpen(true);
  };

  const qualityOptions: Parameters<typeof DownloadQualitySheet>[0]['options'] = downloadSheetSong
    ? (() => {
        const opts: Parameters<typeof DownloadQualitySheet>[0]['options'] = [];
        for (const src of downloadSheetSong.sources) {
          const qualities = ['128K', '192K', '320K', '无损', 'Hi-Res'];
          for (const q of qualities) {
            opts.push({
              sourceId: src.sourceId,
              sourceName: src.sourceName,
              quality: q,
              bitrateLabel: q,
              fileSize: `${(3 + Math.random() * 48).toFixed(1)}MB`,
            });
          }
        }
        return opts;
      })()
    : [];

  const handleDownloadSelected = async (selectedOpts: typeof qualityOptions) => {
    if (!downloadSheetSong) return;
    for (const opt of selectedOpts) {
      try {
        const task = await downloadEngine.createTask({
          songId: downloadSheetSong.sourceSongId,
          sourceId: opt.sourceId,
          quality: selectedQuality,
          title: downloadSheetSong.title,
          artist: downloadSheetSong.artist,
          availableSources: downloadSheetSong.sources.map((s) => ({
            sourceId: s.sourceId,
            sourceSongId: s.sourceSongId,
          })),
        });
        downloadEngine.startDownload(task.id);
      } catch (err) {
        console.error('Download failed:', err);
      }
    }
    toast.success('已加入下载队列', `选中 ${selectedOpts.length} 个音质`);
    setDownloadSheetOpen(false);
  };

  // 榜单详情视图
  if (selectedCategory && activeTab === 'charts') {
    const category = RANK_CATEGORIES.find((c) => c.id === selectedCategory);
    return (
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={handleBack}
            className="p-2 rounded-xl hover:bg-[var(--bg-tertiary)] transition-colors text-[var(--text-secondary)]"
          >
            ← 返回
          </button>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">
            {CATEGORY_ICONS[selectedCategory] || '🎵'} {category?.name}
          </h1>
        </div>

        {isLoadingCategory && categoryResults.length === 0 && (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-[var(--bg-secondary)]">
                <div className="w-12 h-12 skeleton-shimmer rounded-xl" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-1/3 skeleton-shimmer rounded" />
                  <div className="h-3 w-1/2 skeleton-shimmer rounded" />
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2">
          {categoryResults.map((result, idx) => (
            <SongListItem
              key={result.id}
              result={result}
              index={idx + 1}
              showIndex={true}
              onPlay={handlePlay}
              onMore={handleMore}
            />
          ))}
        </div>

        {!isLoadingCategory && categoryResults.length === 0 && (
          <div className="text-center py-12 text-[var(--text-tertiary)]">
            <Music className="w-12 h-12 mx-auto mb-3 opacity-40" />
            <p>该分类暂无数据</p>
            <p className="text-xs mt-1">等待「分类数据」子任务接入真实榜单 API</p>
          </div>
        )}

        {downloadSheetOpen && downloadSheetSong && (
          <DownloadQualitySheet
            songTitle={downloadSheetSong.title}
            songArtist={downloadSheetSong.artist}
            options={qualityOptions}
            onClose={() => setDownloadSheetOpen(false)}
            onDownload={handleDownloadSelected}
            onPlay={() => {
              setDownloadSheetOpen(false);
              handlePlay(downloadSheetSong);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6 hidden lg:block">曲库</h1>

      {/* Tabs */}
      <div className="flex gap-1 mb-6">
        <button
          onClick={() => setActiveTab('charts')}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-medium transition-all ${
            activeTab === 'charts'
              ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
          }`}
        >
          <Trophy className="w-4 h-4" />
          榜单
        </button>
        <button
          onClick={() => setActiveTab('playlists')}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-medium transition-all ${
            activeTab === 'playlists'
              ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
          }`}
        >
          <ListMusic className="w-4 h-4" />
          歌单
        </button>
      </div>

      {/* 榜单 Tab */}
      {activeTab === 'charts' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {RANK_CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              onClick={() => handleCategoryClick(cat.id)}
              className="yinliu-card-hover text-left p-4 group"
            >
              <div className="text-2xl mb-2">{CATEGORY_ICONS[cat.id] || '🎵'}</div>
              <div className="text-sm font-medium text-[var(--text-primary)]">{cat.name}</div>
              <div className="text-[10px] text-[var(--text-tertiary)] mt-1 group-hover:text-[var(--accent)] transition-colors">
                点击查看 →
              </div>
            </button>
          ))}
        </div>
      )}

      {/* 歌单 Tab */}
      {activeTab === 'playlists' && (
        <div className="space-y-6">
          {/* 平台列表 */}
          <div>
            <p className="text-xs text-[var(--text-tertiary)] mb-3">
              按平台浏览歌单分类（汽水 → 酷我 → 咪咕 → 网易云 → QQ → 酷狗）
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {PLATFORM_DISPLAY_ORDER.map((plat) => {
                const meta = PLATFORM_META[plat];
                return (
                  <button
                    key={plat}
                    onClick={() => {
                      toast.info('歌单分类', `${meta.name} 歌单分类待「分类数据」子任务接入`);
                    }}
                    className="yinliu-card-hover text-left p-4 group"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)] font-mono">
                        {plat}
                      </span>
                    </div>
                    <div className="text-sm font-medium text-[var(--text-primary)]">{meta.name}歌单</div>
                    <div className="text-[10px] text-[var(--text-tertiary)] mt-1">
                      待接入
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 融合分类 */}
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3">融合分类</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {PLAYLIST_CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => {
                    navigate(`/search?q=${encodeURIComponent(cat.name)}`);
                  }}
                  className="yinliu-card-hover text-left p-3 text-sm text-[var(--text-primary)]"
                >
                  <span className="mr-1">{PLAYLIST_ICONS[cat.id] || '🎵'}</span>
                  {cat.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
