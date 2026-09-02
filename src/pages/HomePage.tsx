import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search as SearchIcon, Loader2, Flame } from 'lucide-react';
import { getAggregatedHotSongs } from '../core/charts';
import type { AggregatedSearchResult } from '../core/search';
import SongRow from '../components/song/SongRow';
import QualitySizeSheet from '../components/song/QualitySizeSheet';
import { playerEngine } from '../core/player';
import { useSearchStore } from '../shared/store/searchStore';
import { toast } from '../shared/components/Toast';

/**
 * 首页：搜索入口 + 多源聚合热歌榜
 * 聚合排序：权重1=支持的源越多越靠前；权重2=展示优先级（汽水>酷我>咪咕>网易云>QQ>酷狗）
 * 取链播放按播放优先级（酷我>咪咕>网易云>QQ>酷狗>汽水），与展示序并存
 */
export default function HomePage() {
  const navigate = useNavigate();
  const { selectedQuality } = useSearchStore();
  const [kw, setKw] = useState('');
  const [songs, setSongs] = useState<AggregatedSearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [qualitySheetSong, setQualitySheetSong] = useState<AggregatedSearchResult | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await getAggregatedHotSongs();
        if (alive) setSongs(list);
      } catch (err) {
        console.error('热歌榜拉取失败:', err);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const handlePlay = async (result: AggregatedSearchResult) => {
    if (!result.sources || result.sources.length === 0) {
      toast.error('暂无可用音源', '该歌曲在所有平台均无播放链接');
      return;
    }
    try {
      await playerEngine.playTrack(
        {
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
        },
        selectedQuality
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : '播放失败';
      toast.error('播放失败', msg);
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">首页</h1>

      {/* 搜索入口 */}
      <form
        className="mb-6"
        onSubmit={(e) => {
          e.preventDefault();
          navigate('/search');
        }}
      >
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-tertiary)]" />
          <input
            type="text"
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            onFocus={() => navigate('/search')}
            placeholder="搜索歌曲、歌手"
            className="w-full pl-10 pr-4 py-2.5 rounded-full bg-[var(--bg-secondary)] border border-[var(--border)] text-sm outline-none focus:border-[var(--accent)]"
          />
        </div>
      </form>

      {/* 多源聚合热歌榜 */}
      <div className="flex items-center gap-2 mb-3">
        <Flame className="w-5 h-5 text-red-500" />
        <h2 className="text-lg font-bold">热歌榜</h2>
        <span className="text-xs text-[var(--text-tertiary)]">多源聚合</span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-[var(--text-tertiary)]">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : songs.length === 0 ? (
        <div className="text-center py-12 text-[var(--text-tertiary)]">热歌榜暂无数据</div>
      ) : (
        songs.slice(0, 100).map((result) => (
          <SongRow
            key={result.id}
            song={result}
            onPlay={() => handlePlay(result)}
            onMore={() => setQualitySheetSong(result)}
          />
        ))
      )}

      {qualitySheetSong && (
        <QualitySizeSheet
          song={qualitySheetSong}
          open
          onClose={() => setQualitySheetSong(null)}
        />
      )}
    </div>
  );
}
