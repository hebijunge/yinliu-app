import { useEffect, useState } from 'react';
import { Trophy, ListMusic, Loader2 } from 'lucide-react';
import { getAllChartGroups, type ChartCategoryGroup, type ClassifiedChart } from '../core/charts';
import { PLAYLIST_CATEGORIES, getCategoryPlaylists, type SourcePlaylistGroup } from '../core/playlistCategories';
import { sourceRegistry } from '@providers/music/registry';
import { PLATFORM_SHORT_NAMES } from '../core/platformPriority';
import type { PlaylistSummary, SearchResult } from '../core/types';
import type { AggregatedSearchResult } from '../core/search';
import SongRow from '../components/song/SongRow';
import QualitySizeSheet from '../components/song/QualitySizeSheet';
import { playerEngine } from '../core/player';
import { useSearchStore } from '../shared/store/searchStore';
import { toast } from '../shared/components/Toast';

/**
 * 曲库页：榜单 / 歌单 两个 Tab
 * - 榜单：6 源榜单按 20 个固定融合分类归类
 * - 歌单：固定融合分类，展示顺序 汽水>酷我>咪咕>网易云>QQ>酷狗
 */
type DetailSong = { song: SearchResult; sourceId: string; sourceName: string };

export default function LibraryPage() {
  const { selectedQuality } = useSearchStore();
  const [tab, setTab] = useState<'charts' | 'playlists'>('charts');

  // 榜单
  const [chartGroups, setChartGroups] = useState<ChartCategoryGroup[]>([]);
  const [chartsLoading, setChartsLoading] = useState(true);
  const [chartSongs, setChartSongs] = useState<DetailSong[]>([]);
  const [chartDetailTitle, setChartDetailTitle] = useState('');

  // 歌单
  const [activeCat, setActiveCat] = useState('hot');
  const [playlistGroups, setPlaylistGroups] = useState<SourcePlaylistGroup[]>([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  const [playlistSongs, setPlaylistSongs] = useState<DetailSong[]>([]);
  const [playlistDetailTitle, setPlaylistDetailTitle] = useState('');

  const [sheetSong, setSheetSong] = useState<AggregatedSearchResult | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const groups = await getAllChartGroups();
        if (alive) setChartGroups(groups);
      } catch (err) {
        console.error('榜单拉取失败:', err);
      } finally {
        if (alive) setChartsLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setPlaylistsLoading(true);
    (async () => {
      try {
        const groups = await getCategoryPlaylists(activeCat === 'hot' ? '热门推荐' : activeCat);
        if (alive) setPlaylistGroups(groups);
      } finally {
        if (alive) setPlaylistsLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeCat]);

  const toDetail = (song: SearchResult, sourceId: string): AggregatedSearchResult => ({
    ...song,
    sources: [
      {
        sourceId,
        sourceName: PLATFORM_SHORT_NAMES[sourceId] || sourceId,
        sourceSongId: song.sourceSongId,
        maxQuality: song.quality || 0,
        available: true,
      },
    ],
  } as AggregatedSearchResult);

  const play = async (ds: DetailSong) => {
    try {
      await playerEngine.playTrack(
        {
          id: ds.song.id,
          title: ds.song.title,
          artist: ds.song.artist,
          album: ds.song.album,
          coverUrl: ds.song.coverUrl,
          duration: ds.song.duration,
          sourceId: ds.sourceId,
          sourceSongId: ds.song.sourceSongId,
          uri: `stream://${ds.sourceId}/${ds.song.sourceSongId}`,
          availableSources: [{ sourceId: ds.sourceId, sourceSongId: ds.song.sourceSongId }],
        },
        selectedQuality
      );
    } catch (err) {
      toast.error('播放失败', err instanceof Error ? err.message : String(err));
    }
  };

  const openChart = async (chart: ClassifiedChart) => {
    setChartDetailTitle(`${chart.sourceName} · ${chart.chartName}`);
    setChartSongs([]);
    try {
      const source = sourceRegistry.get(chart.sourceId);
      if (!source?.getChartDetail) return;
      const detail = await source.getChartDetail(chart.chartId);
      setChartSongs((detail?.songs || []).map((s) => ({ song: s, sourceId: chart.sourceId, sourceName: chart.sourceName })));
    } catch (err) {
      toast.error('榜单详情拉取失败', err instanceof Error ? err.message : String(err));
    }
  };

  const openPlaylist = async (sourceId: string, sourceName: string, pl: PlaylistSummary) => {
    setPlaylistDetailTitle(pl.title);
    setPlaylistSongs([]);
    try {
      const source = sourceRegistry.get(sourceId);
      if (!source?.getPlaylist) return;
      const detail = await source.getPlaylist(pl.id);
      setPlaylistSongs((detail?.songs || []).map((s) => ({ song: s, sourceId, sourceName })));
    } catch (err) {
      toast.error('歌单详情拉取失败', err instanceof Error ? err.message : String(err));
    }
  };

  const detail = (title: string, songs: DetailSong[]) =>
    songs.length === 0 && !title ? null : (
      <div className="mt-6">
        {title && <h3 className="text-base font-bold mb-2">{title}</h3>}
        {songs.length === 0 ? (
          <div className="flex justify-center py-8 text-[var(--text-tertiary)]">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : (
          songs.map((ds, i) => (
            <SongRow
              key={`${ds.song.id}-${i}`}
              song={toDetail(ds.song, ds.sourceId)}
              onPlay={() => play(ds)}
              onMore={() => setSheetSong(toDetail(ds.song, ds.sourceId))}
            />
          ))
        )}
      </div>
    );

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">曲库</h1>

      {/* Tab 切换 */}
      <div className="flex gap-2 mb-4">
        {(
          [
            { key: 'charts', label: '榜单', icon: Trophy },
            { key: 'playlists', label: '歌单', icon: ListMusic },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-medium ${
              tab === t.key
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]'
            }`}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'charts' && (
        <div>
          {chartsLoading ? (
            <div className="flex justify-center py-16 text-[var(--text-tertiary)]">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : (
            chartGroups.map((g) => (
              <div key={g.categoryId} className="mb-5">
                <h3 className="text-sm font-bold text-[var(--text-secondary)] mb-2">{g.categoryName}</h3>
                <div className="flex flex-wrap gap-2">
                  {g.charts.length === 0 ? (
                    <span className="text-xs text-[var(--text-tertiary)]">暂无</span>
                  ) : (
                    g.charts.map((c) => (
                      <button
                        key={`${c.sourceId}-${c.chartId}`}
                        onClick={() => openChart(c)}
                        className="px-3 py-1.5 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-xs hover:border-[var(--accent)]"
                      >
                        <span className="text-[10px] text-[var(--text-tertiary)] mr-1">[{c.sourceName}]</span>
                        {c.chartName}
                      </button>
                    ))
                  )}
                </div>
              </div>
            ))
          )}
          {detail(chartDetailTitle, chartSongs)}
        </div>
      )}

      {tab === 'playlists' && (
        <div>
          <div className="flex flex-wrap gap-2 mb-4">
            {PLAYLIST_CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveCat(c.id)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium ${
                  activeCat === c.id
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]'
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>
          {playlistsLoading ? (
            <div className="flex justify-center py-16 text-[var(--text-tertiary)]">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : playlistGroups.length === 0 ? (
            <div className="py-10 text-center text-sm text-[var(--text-tertiary)]">
              该分类下暂无各源歌单数据（部分音源未提供此分类）
            </div>
          ) : (
            playlistGroups.map((g) => (
              <div key={g.sourceId} className="mb-5">
                <h3 className="text-sm font-bold text-[var(--text-secondary)] mb-2">{g.sourceName}</h3>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                  {g.playlists.map((pl) => (
                    <button
                      key={`${g.sourceId}-${pl.id}`}
                      onClick={() => openPlaylist(g.sourceId, g.sourceName, pl)}
                      className="text-left"
                    >
                      <div className="aspect-square rounded-lg overflow-hidden bg-[var(--bg-secondary)] mb-1">
                        {pl.coverUrl ? (
                          <img src={pl.coverUrl} alt={pl.title} className="w-full h-full object-cover" loading="lazy" />
                        ) : null}
                      </div>
                      <div className="text-xs line-clamp-2 text-[var(--text-primary)]">{pl.title}</div>
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
          {detail(playlistDetailTitle, playlistSongs)}
        </div>
      )}

      {sheetSong && (
        <QualitySizeSheet song={sheetSong} open onClose={() => setSheetSong(null)} />
      )}
    </div>
  );
}
