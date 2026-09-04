import { useEffect, useState, useCallback } from 'react';
import { Clock, Play, Plus, ListPlus, Trash2, Music, X, Heart, Search } from 'lucide-react';
import { usePlayHistoryStore, type HistoryRecord } from '../shared/store/playHistoryStore';
import { usePlaylistStore, type PlaylistSongInput } from '../shared/store/playlistStore';
import { usePlayerStore } from '../shared/store/playerStore';
import { playerEngine } from '../core/player';
import { useGuardedAction } from '../shared/hooks/useGuardedAction';

const SOURCE_COLORS: Record<string, string> = {
  netease: 'bg-red-500',
  qq: 'bg-green-500',
  kuwo: 'bg-blue-500',
  kugou: 'bg-cyan-500',
  migu: 'bg-orange-500',
};

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDuration(s?: number): string {
  if (!s || !isFinite(s)) return '--:--';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export default function HistoryPage() {
  const { records, isLoading, loadRecords, clearHistory, removeRecord } = usePlayHistoryStore();
  const { playlists, addSongToPlaylist, toggleFavorite, isFavorite } = usePlaylistStore();
  const [pickerFor, setPickerFor] = useState<HistoryRecord | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const { currentQuality } = usePlayerStore();

  // E4: 清空历史守卫（进行中禁用 + 300ms 防抖，防双击重复清空）
  const handleClearHistory = async () => {
    await clearHistory();
    setConfirmClear(false);
  };
  const { run: guardedClearHistory, busy: clearingBusy } = useGuardedAction(handleClearHistory);

  useEffect(() => {
    loadRecords();
  }, [loadRecords]);

  const handlePlay = useCallback(
    async (record: HistoryRecord) => {
      const track = {
        id: record.songId,
        title: record.title,
        artist: record.artist,
        sourceId: record.source || 'netease',
        sourceSongId: record.songId,
        uri: `stream://${record.source || 'netease'}/${record.songId}`,
        duration: record.duration,
      };
      // 设置队列为单首
      usePlayerStore.getState().setQueue([track], 0);
      try {
        await playerEngine.playTrack(track, currentQuality);
      } catch (err) {
        console.error('Failed to play history record:', err);
      }
    },
    [currentQuality]
  );

  const handleAddToQueue = useCallback((record: HistoryRecord) => {
    const track = {
      id: record.songId,
      title: record.title,
      artist: record.artist,
      sourceId: record.source || 'netease',
      sourceSongId: record.songId,
      uri: `stream://${record.source || 'netease'}/${record.songId}`,
      duration: record.duration,
    };
    usePlayerStore.getState().addToQueue(track);
  }, []);

  const handleAddToPlaylist = useCallback(
    async (record: HistoryRecord, playlistId: string) => {
      const song: PlaylistSongInput = {
        songId: record.songId,
        title: record.title,
        artist: record.artist,
        source: record.source || 'netease',
        quality: 'standard',
      };
      try {
        await addSongToPlaylist(playlistId, song);
        setPickerFor(null);
      } catch (err) {
        console.error('Failed to add to playlist:', err);
      }
    },
    [addSongToPlaylist]
  );

  const handleToggleFavorite = useCallback(
    async (record: HistoryRecord) => {
      const song: PlaylistSongInput = {
        songId: record.songId,
        title: record.title,
        artist: record.artist,
        source: record.source || 'netease',
        quality: 'standard',
      };
      try {
        await toggleFavorite(song);
      } catch (err) {
        console.error('Failed to toggle favorite:', err);
      }
    },
    [toggleFavorite]
  );

  return (
    <div className="max-w-4xl mx-auto pb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-[var(--accent-soft)] flex items-center justify-center">
            <Clock className="w-5 h-5 text-[var(--accent)]" />
          </div>
          <div>
            <h1 className="text-2xl font-light text-[var(--text-primary)]">最近播放</h1>
            <p className="text-xs text-[var(--text-tertiary)] mt-0.5">共 {records.length} 首</p>
          </div>
        </div>
        {records.length > 0 && (
          <button
            onClick={() => setConfirmClear(true)}
            className="yinliu-btn-secondary flex items-center gap-2 text-sm"
            title="清空历史"
          >
            <Trash2 className="w-4 h-4" />
            清空
          </button>
        )}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 rounded-2xl skeleton-shimmer" />
          ))}
        </div>
      ) : records.length === 0 ? (
        <div className="yinliu-card text-center py-16">
          <div className="w-16 h-16 mx-auto mb-4 rounded-3xl bg-[var(--bg-tertiary)] flex items-center justify-center">
            <Clock className="w-7 h-7 text-[var(--text-tertiary)]" />
          </div>
          <h3 className="text-base font-medium text-[var(--text-primary)] mb-1">还没有播放记录</h3>
          <p className="text-sm text-[var(--text-tertiary)]">去发现页搜索并播放一首歌试试</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {records.map((record) => {
            const isFav = isFavorite({ title: record.title, artist: record.artist });
            return (
              <div
                key={record.id}
                className="group flex items-center gap-3 p-3 rounded-2xl bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors border border-transparent hover:border-[var(--border-subtle)]"
              >
                {/* Cover / Icon */}
                <button
                  onClick={() => handlePlay(record)}
                  className="w-12 h-12 flex-shrink-0 rounded-2xl bg-[var(--bg-tertiary)] flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--accent)] hover:text-white transition-colors focus-ring"
                  title="播放"
                >
                  <Play className="w-5 h-5 ml-0.5" />
                </button>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate text-[var(--text-primary)]">{record.title}</div>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-[var(--text-tertiary)]">
                    <span className="truncate max-w-[8rem]">{record.artist || '未知歌手'}</span>
                    {record.source && (
                      <span
                        className={`px-1.5 py-0.5 rounded text-[9px] text-white flex-shrink-0 ${
                          SOURCE_COLORS[record.source] || 'bg-gray-500'
                        }`}
                      >
                        {record.source}
                      </span>
                    )}
                    <span className="flex-shrink-0">·</span>
                    <span className="flex-shrink-0">{formatRelativeTime(record.playedAt)}</span>
                    <span className="flex-shrink-0">·</span>
                    <span className="flex-shrink-0 tabular-nums">{formatDuration(record.duration)}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleToggleFavorite(record)}
                    className={`p-2 rounded-full hover:bg-[var(--bg-tertiary)] transition-colors focus-ring ${
                      isFav ? 'text-red-500' : 'text-[var(--text-tertiary)]'
                    }`}
                    title={isFav ? '取消收藏' : '收藏'}
                  >
                    <Heart className={`w-4 h-4 ${isFav ? 'fill-current' : ''}`} />
                  </button>
                  <button
                    onClick={() => handleAddToQueue(record)}
                    className="p-2 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] transition-colors focus-ring"
                    title="加入队列"
                  >
                    <ListPlus className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setPickerFor(record)}
                    className="p-2 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] transition-colors focus-ring"
                    title="添加到歌单"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => removeRecord(record.id)}
                    className="p-2 rounded-full hover:bg-red-500/10 text-[var(--text-tertiary)] hover:text-red-400 transition-colors focus-ring"
                    title="删除"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Playlist picker modal */}
      {pickerFor && (
        <div
          className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setPickerFor(null)}
        >
          <div
            className="w-full sm:max-w-md bg-[var(--bg-secondary)] rounded-t-[2rem] sm:rounded-3xl border border-[var(--border-subtle)] shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-subtle)]">
              <h3 className="font-semibold text-[var(--text-primary)]">添加到歌单</h3>
              <button
                onClick={() => setPickerFor(null)}
                className="p-2 rounded-xl hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] focus-ring"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="max-h-80 overflow-y-auto p-2 scrollbar-hide">
              {playlists.length === 0 ? (
                <div className="text-center py-8 text-sm text-[var(--text-tertiary)]">
                  还没有歌单，请先创建
                </div>
              ) : (
                playlists.map((pl) => (
                  <button
                    key={pl.id}
                    onClick={() => handleAddToPlaylist(pickerFor, pl.id)}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-2xl hover:bg-[var(--bg-tertiary)] transition-colors text-left focus-ring"
                  >
                    <div className="w-10 h-10 rounded-xl bg-[var(--bg-tertiary)] flex items-center justify-center flex-shrink-0">
                      {pl.id === 'favorites' ? (
                        <Heart className="w-4 h-4 text-red-500 fill-current" />
                      ) : (
                        <Music className="w-4 h-4 text-[var(--text-tertiary)]" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[var(--text-primary)] truncate">{pl.name}</div>
                      <div className="text-xs text-[var(--text-tertiary)]">{pl.songCount} 首</div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Confirm clear modal */}
      {confirmClear && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={() => setConfirmClear(false)}
        >
          <div
            className="w-full max-w-sm yinliu-card"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-semibold text-[var(--text-primary)] mb-2">清空播放历史？</h3>
            <p className="text-sm text-[var(--text-tertiary)] mb-5">此操作不可撤销，确定清空全部播放记录？</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmClear(false)} className="yinliu-btn-secondary text-sm">
                取消
              </button>
              <button
                onClick={guardedClearHistory}
                disabled={clearingBusy}
                className="px-5 py-3 rounded-2xl bg-red-500 text-white text-sm font-medium hover:bg-red-600 transition-colors focus-ring disabled:opacity-40"
              >
                {clearingBusy ? '清空中…' : '清空'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
