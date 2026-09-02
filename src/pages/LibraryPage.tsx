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

/** 20 个合并榜单分类（来自《6平台音乐榜单名称与分类完整梳理.md》第四章） */
const CHART_CATEGORIES = [
  { id: 'hot', name: '热歌榜', icon: '🔥' },
  { id: 'new', name: '新歌榜', icon: '🆕' },
  { id: 'soaring', name: '飙升榜', icon: '📈' },
  { id: 'original', name: '原创榜', icon: '✨' },
  { id: 'viral', name: '网络热歌榜', icon: '🌐' },
  { id: 'western', name: '欧美榜', icon: '🌍' },
  { id: 'jpk', name: '日韩榜', icon: '🇯🇵' },
  { id: 'chinese', name: '华语榜', icon: '🇨🇳' },
  { id: 'cantonese', name: '粤语榜', icon: '🎤' },
  { id: 'guofeng', name: '国风榜', icon: '🏮' },
  { id: 'dj', name: 'DJ电音榜', icon: '🎧' },
  { id: 'rap', name: '说唱榜', icon: '🎤' },
  { id: 'rock', name: '摇滚民谣榜', icon: '🎸' },
  { id: 'movie', name: '影视综艺榜', icon: '🎬' },
  { id: 'acg', name: 'ACG游戏榜', icon: '🎮' },
  { id: 'global', name: '全球榜', icon: '🌎' },
  { id: 'classic', name: '经典怀旧榜', icon: '📻' },
  { id: 'vip', name: '会员榜', icon: '👑' },
  { id: 'scene', name: '场景榜', icon: '🚗' },
  { id: 'others', name: '其他特色榜', icon: '🎁' },
];

/** 歌单平台分类（按 汽水→酷我→咪咕→网易云→QQ→酷狗） */
const PLAYLIST_PLATFORM_ORDER = [
  { id: 'qishui', name: '汽水', abbrev: 'qi' },
  { id: 'kuwo', name: '酷我', abbrev: 'kw' },
  { id: 'migu', name: '咪咕', abbrev: 'mg' },
  { id: 'netease', name: '网易云', abbrev: 'wy' },
  { id: 'qq', name: 'QQ', abbrev: 'qq' },
  { id: 'kugou', name: '酷狗', abbrev: 'kg' },
];

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

    // v17: 分类占位 — 真实数据待「分类数据」子任务接入各平台 chart API
    // 目前用搜索对应关键词模拟榜单内容
    const keywordMap: Record<string, string> = {
      hot: '热门',
      new: '新歌',
      soaring: '飙升',
      original: '原创',
      viral: '网络歌曲',
      western: '欧美',
      jpk: '日韩',
      chinese: '华语',
      cantonese: '粤语',
      guofeng: '国风',
      dj: 'DJ',
      rap: '说唱',
      rock: '摇滚',
      movie: '影视',
      acg: 'ACG',
      global: '全球',
      classic: '经典',
      vip: 'VIP',
      scene: '车载',
      others: '轻音乐',
    };

    try {
      const { searchEngine } = await import('../core/search');
      const { results } = await searchEngine.search(
        { keyword: keywordMap[categoryId] || '热门', page: 0, pageSize: 30 },
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
    const category = CHART_CATEGORIES.find((c) => c.id === selectedCategory);
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
            {category?.icon} {category?.name}
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
          {CHART_CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              onClick={() => handleCategoryClick(cat.id)}
              className="yinliu-card-hover text-left p-4 group"
            >
              <div className="text-2xl mb-2">{cat.icon}</div>
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
        <div className="space-y-4">
          <p className="text-xs text-[var(--text-tertiary)]">
            按平台浏览歌单分类（汽水 → 酷我 → 咪咕 → 网易云 → QQ → 酷狗）
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {PLAYLIST_PLATFORM_ORDER.map((plat) => (
              <button
                key={plat.id}
                onClick={() => {
                  toast.info('歌单分类', `${plat.name} 歌单分类待「分类数据」子任务接入`);
                }}
                className="yinliu-card-hover text-left p-4 group"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)] font-mono">
                    {plat.abbrev}
                  </span>
                </div>
                <div className="text-sm font-medium text-[var(--text-primary)]">{plat.name}歌单</div>
                <div className="text-[10px] text-[var(--text-tertiary)] mt-1">
                  待接入
                </div>
              </button>
            ))}
          </div>

          {/* 固定融合分类占位 */}
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3">融合分类</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {['流行', '摇滚', '民谣', '电子', '说唱', '国风', '轻音乐', '影视原声'].map((tag) => (
                <button
                  key={tag}
                  onClick={() => {
                    navigate(`/search?q=${encodeURIComponent(tag)}`);
                  }}
                  className="yinliu-card-hover text-left p-3 text-sm text-[var(--text-primary)]"
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
