import { useEffect, useRef, useState } from 'react';
import { Loader2, Music2, ListMusic } from 'lucide-react';
import { ZONES, getZoneChartGroups, getZonePlaylists, type Zone } from '../core/zones';
import type { ClassifiedChart } from '../core/charts';
import type { SourcePlaylistGroup } from '../core/playlistCategories';
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
 * 专区页（v20）：粤语专区 / DJ 专区
 * - 榜单：chartCategories 固定分类聚合（与曲库榜单同一取数链路）
 * - 歌单：按分类名 best-effort 映射各源（与曲库歌单同一取数链路），无对应分类的源如实缺省
 */
type DetailSong = { song: SearchResult; sourceId: string; sourceName: string };

interface DetailState {
  title: string;
  loading: boolean;
  songs: DetailSong[];
}

export default function ZonePage() {
  const { selectedQuality } = useSearchStore();
  const [activeZoneId, setActiveZoneId] = useState(ZONES[0]?.id || 'cantonese');
  const activeZone = ZONES.find((z) => z.id === activeZoneId) || ZONES[0];

  // 榜单：一次拉取全部源榜单，按专区分类切分
  const [chartsByZone, setChartsByZone] = useState<Record<string, ClassifiedChart[]> | null>(null);
  const [chartsLoading, setChartsLoading] = useState(true);

  // 歌单：按专区缓存各源分组
  const [playlistsByZone, setPlaylistsByZone] = useState<Record<string, SourcePlaylistGroup[]>>({});
  const [playlistsLoading, setPlaylistsLoading] = useState(false);

  // 详情歌曲列表（点榜单/歌单后展开）
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [sheetSong, setSheetSong] = useState<AggregatedSearchResult | null>(null);
  // 详情区锚点：点击榜单/歌单后平滑滚动到详情列表，给出「点了有反应」的引导
  const detailRef = useRef<HTMLDivElement | null>(null);
  const scrollToDetail = () => {
    setTimeout(() => {
      detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const groups = await getZoneChartGroups();
        if (alive) setChartsByZone(groups);
      } catch (err) {
        console.error('专区榜单拉取失败:', err);
      } finally {
        if (alive) setChartsLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!activeZone || playlistsByZone[activeZone.id]) return;
    let alive = true;
    setPlaylistsLoading(true);
    (async () => {
      try {
        const groups = await getZonePlaylists(activeZone);
        if (alive) setPlaylistsByZone((prev) => ({ ...prev, [activeZone.id]: groups }));
      } finally {
        if (alive) setPlaylistsLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeZoneId]);

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
    setDetail({ title: `${chart.sourceName} · ${chart.chartName}`, loading: true, songs: [] });
    scrollToDetail();
    try {
      const source = sourceRegistry.get(chart.sourceId);
      if (!source?.getChartDetail) {
        setDetail({ title: `${chart.sourceName} · ${chart.chartName}`, loading: false, songs: [] });
        return;
      }
      const d = await source.getChartDetail(chart.chartId);
      setDetail({
        title: `${chart.sourceName} · ${chart.chartName}`,
        loading: false,
        songs: (d?.songs || []).map((s) => ({ song: s, sourceId: chart.sourceId, sourceName: chart.sourceName })),
      });
    } catch (err) {
      toast.error('榜单详情拉取失败', err instanceof Error ? err.message : String(err));
      setDetail({ title: `${chart.sourceName} · ${chart.chartName}`, loading: false, songs: [] });
    }
  };

  const openPlaylist = async (sourceId: string, sourceName: string, pl: PlaylistSummary) => {
    setDetail({ title: pl.title, loading: true, songs: [] });
    scrollToDetail();
    try {
      const source = sourceRegistry.get(sourceId);
      if (!source?.getPlaylist) {
        setDetail({ title: pl.title, loading: false, songs: [] });
        return;
      }
      const d = await source.getPlaylist(pl.id);
      setDetail({
        title: pl.title,
        loading: false,
        songs: (d?.songs || []).map((s) => ({ song: s, sourceId, sourceName })),
      });
    } catch (err) {
      toast.error('歌单详情拉取失败', err instanceof Error ? err.message : String(err));
      setDetail({ title: pl.title, loading: false, songs: [] });
    }
  };

  const zoneCharts = (activeZone && chartsByZone?.[activeZone.id]) || [];
  const zonePlaylistGroups = (activeZone && playlistsByZone[activeZone.id]) || [];
  const zonePlaylistsLoaded = !!(activeZone && playlistsByZone[activeZone.id]);

  const Spinner = ({ className = 'py-10' }: { className?: string }) => (
    <div className={`flex justify-center text-[var(--text-tertiary)] ${className}`}>
      <Loader2 className="w-5 h-5 animate-spin" />
    </div>
  );

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">专区</h1>

      {/* 专区入口切换 */}
      <div className="flex gap-2 mb-5">
        {ZONES.map((z: Zone) => (
          <button
            key={z.id}
            onClick={() => {
              setActiveZoneId(z.id);
              setDetail(null);
            }}
            className={`flex items-center gap-1.5 px-5 py-2 rounded-full text-sm font-medium ${
              activeZoneId === z.id
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]'
            }`}
          >
            <Music2 className="w-4 h-4" />
            {z.name}
          </button>
        ))}
      </div>

      {/* 榜单区：专区对应分类下的各源榜单 */}
      <div className="mb-6">
        <h3 className="text-sm font-bold text-[var(--text-secondary)] mb-2">榜单 · 多源聚合</h3>
        {chartsLoading ? (
          <Spinner />
        ) : zoneCharts.length === 0 ? (
          <div className="text-xs text-[var(--text-tertiary)]">暂无对应榜单</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {zoneCharts.map((c) => (
              <button
                key={`${c.sourceId}-${c.chartId}`}
                onClick={() => openChart(c)}
                className="px-3 py-1.5 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-xs hover:border-[var(--accent)]"
              >
                <span className="text-[10px] text-[var(--text-tertiary)] mr-1">[{c.sourceName}]</span>
                {c.chartName}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 歌单区：专区对应分类下的各源歌单 */}
      <div className="mb-6">
        <h3 className="text-sm font-bold text-[var(--text-secondary)] mb-2">歌单</h3>
        {playlistsLoading && !zonePlaylistsLoaded ? (
          <Spinner />
        ) : zonePlaylistGroups.length === 0 ? (
          <div className="text-xs text-[var(--text-tertiary)]">暂无对应歌单</div>
        ) : (
          zonePlaylistGroups.map((g) => (
            <div key={g.sourceId} className="mb-4">
              <h4 className="text-xs font-bold text-[var(--text-tertiary)] mb-2">{g.sourceName}</h4>
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
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[var(--text-tertiary)]">
                          <ListMusic className="w-6 h-6" />
                        </div>
                      )}
                    </div>
                    <div className="text-xs line-clamp-2 text-[var(--text-primary)]">{pl.title}</div>
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 榜单/歌单详情歌曲列表 */}
      {detail && (
        <div className="mt-6" ref={detailRef}>
          {detail.title && <h3 className="text-base font-bold mb-2">{detail.title}</h3>}
          {detail.loading ? (
            <Spinner />
          ) : detail.songs.length === 0 ? (
            <div className="text-xs text-[var(--text-tertiary)]">暂无歌曲</div>
          ) : (
            detail.songs.map((ds, i) => (
              <SongRow
                key={`${ds.song.id}-${i}`}
                song={toDetail(ds.song, ds.sourceId)}
                onPlay={() => play(ds)}
                onMore={() => setSheetSong(toDetail(ds.song, ds.sourceId))}
              />
            ))
          )}
        </div>
      )}

      {sheetSong && <QualitySizeSheet song={sheetSong} open onClose={() => setSheetSong(null)} />}
    </div>
  );
}
