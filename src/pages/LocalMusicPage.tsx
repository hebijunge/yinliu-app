import { useState, useCallback, useEffect, useRef } from 'react';
import { HardDrive, RefreshCw, Play, FolderOpen } from 'lucide-react';
import { scanLocalMusic } from '../modules/music/localScanner';
import type { ScannedSong } from '../modules/music/localScanner';
import { playerEngine } from '../core/player';
import { usePlayerStore } from '../shared/store/playerStore';
import { toast } from '../shared/components/Toast';
import { SkeletonList } from '../components/ui/Skeleton';
import { useVirtualList } from '../shared/hooks/useVirtualList';
import SmartCover from '../components/ui/SmartCover';
import type { PlayerTrack } from '../core/player';

/** 本地音乐虚拟行固定行高（px）：卡片 88 + 间距 12 */
const ROW_HEIGHT = 100;

/** 回收扫描结果里的封面 blob URL（扫描产生 createObjectURL，页面负责 revoke 防泄漏） */
function revokeCoverUrls(songs: ScannedSong[]): void {
  for (const song of songs) {
    if (song.coverUrl && song.coverUrl.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(song.coverUrl);
      } catch {
        // ignore
      }
    }
  }
}

export default function LocalMusicPage() {
  const [songs, setSongs] = useState<ScannedSong[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanPath, setScanPath] = useState('');
  // P2：扫描进度反馈（onProgress 接入）
  const [scanProgress, setScanProgress] = useState<{ current: number; total: number } | null>(null);
  // 持有当前列表引用，供卸载清理使用
  const songsRef = useRef<ScannedSong[]>([]);
  // P2 竞态守卫：连点扫描/卸载时只让最后一次扫描写状态
  const scanReqRef = useRef(0);

  const vl = useVirtualList({ count: songs.length, estimateSize: ROW_HEIGHT });

  // P2：卸载时回收本轮扫描产生的封面 blob URL
  useEffect(() => {
    return () => {
      scanReqRef.current++;
      revokeCoverUrls(songsRef.current);
    };
  }, []);

  const handleScan = useCallback(async () => {
    const reqId = ++scanReqRef.current;
    setIsScanning(true);
    setScanProgress(null);
    try {
      const dirs = scanPath ? [scanPath] : undefined;
      // P2：接入 onProgress，扫描期间反馈「x / y」
      const scanned = await scanLocalMusic(dirs, (progress) => {
        if (reqId !== scanReqRef.current) return;
        if (progress.phase === 'parsing') {
          setScanProgress({ current: progress.current, total: progress.total });
        }
      });
      if (reqId !== scanReqRef.current) {
        // 已有更新的扫描或已卸载：丢弃结果并回收本次产生的 blob URL
        revokeCoverUrls(scanned);
        return;
      }
      // P2：换新结果前回收旧列表的 blob URL，防多次扫描累积泄漏
      revokeCoverUrls(songsRef.current);
      songsRef.current = scanned;
      setSongs(scanned);
    } catch (err) {
      console.error('扫描失败:', err);
      if (reqId !== scanReqRef.current) return;
      toast.error('扫描失败', err instanceof Error ? err.message : '请检查扫描目录后重试');
    } finally {
      if (reqId === scanReqRef.current) {
        setIsScanning(false);
        setScanProgress(null);
      }
    }
  }, [scanPath]);

  // P2：播放错误处理 + 入队语义——把整份本地列表设为播放队列，从点击曲开始播
  const handlePlay = async (song: ScannedSong) => {
    const tracks: PlayerTrack[] = songs.map((s) => ({
      id: s.id,
      title: s.title,
      artist: s.artist,
      album: s.album,
      duration: s.duration,
      coverUrl: s.coverUrl,
      sourceId: 'local',
      sourceSongId: s.filePath,
      uri: `file://${s.filePath}`,
    }));
    if (tracks.length === 0) return;
    const startIndex = Math.max(0, tracks.findIndex((t) => t.id === song.id));
    usePlayerStore.getState().setQueue(tracks, startIndex);
    try {
      await playerEngine.playTrack(tracks[startIndex]);
    } catch (err) {
      console.error('[LocalMusicPage] play failed:', err);
      toast.error('播放失败', err instanceof Error ? err.message : '本地文件可能已被移动或删除');
    }
  };

  const formatDuration = (seconds: number) => {
    if (!seconds) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="max-w-4xl mx-auto h-full flex flex-col">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-light flex items-center gap-3 text-[var(--text-primary)]">
          <HardDrive className="w-6 h-6" />
          本地音乐
        </h1>
      </div>

      {/* Scan Controls */}
      <div className="yinliu-card mb-6">
        <div className="flex gap-2 mb-3">
          <div className="flex-1 relative">
            <FolderOpen className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" />
            <input
              type="text"
              value={scanPath}
              onChange={(e) => setScanPath(e.target.value)}
              placeholder="输入扫描目录（留空使用默认）..."
              className="yinliu-input w-full pl-10"
            />
          </div>
          <button
            onClick={handleScan}
            disabled={isScanning}
            className="yinliu-btn flex items-center gap-2"
          >
            {isScanning ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            扫描
          </button>
        </div>
        <div className="text-xs text-[var(--text-tertiary)]">
          {isScanning && scanProgress
            ? `正在扫描 ${scanProgress.current} / ${scanProgress.total} …`
            : '支持格式：MP3、FLAC、AAC、M4A、OGG、WAV、WMA'}
        </div>
      </div>

      {/* Stats */}
      {songs.length > 0 && (
        <div className="text-sm font-medium text-[var(--text-secondary)] mb-4">
          共找到 {songs.length} 首本地歌曲
        </div>
      )}

      {/* Skeleton Loading */}
      {isScanning && (
        <>
          <div className="text-xs text-[var(--text-tertiary)] mb-3">
            {scanProgress
              ? `已解析 ${scanProgress.current} / ${scanProgress.total} 个文件`
              : '正在枚举音频文件…'}
          </div>
          <SkeletonList count={5} />
        </>
      )}

      {/* Song List（P3 虚拟化） */}
      {!isScanning && (
        <div ref={vl.containerRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-hide" data-testid="local-music-list">
          <div style={{ height: vl.totalSize, position: 'relative' }}>
            {vl.getVirtualItems().map((vi) => {
              const song = songs[vi.index];
              return (
                <div
                  key={song.id}
                  ref={vl.measureElement}
                  data-index={vi.index}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW_HEIGHT, transform: `translateY(${vi.start}px)` }}
                  className="flex items-center gap-4 p-4 mb-3 rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] hover:border-[var(--accent)]/30 transition-all duration-200 group"
                >
                  <div className="w-14 h-14 flex-shrink-0">
                    <SmartCover src={song.coverUrl} alt={song.title} className="w-14 h-14 rounded-2xl border border-[var(--border-subtle)]" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate text-[var(--text-primary)]">{song.title}</div>
                    <div className="text-sm text-[var(--text-secondary)] truncate">
                      {song.artist} {song.album && `· ${song.album}`}
                    </div>
                  </div>

                  <div className="text-xs text-[var(--text-tertiary)] hidden sm:block font-medium">
                    {song.format.toUpperCase()}
                  </div>

                  <div className="text-xs text-[var(--text-tertiary)] tabular-nums hidden md:block">
                    {formatDuration(song.duration)}
                  </div>

                  {/* P2：移动端无 hover，播放按钮常显；桌面端保留 hover 出现 */}
                  <button
                    onClick={() => handlePlay(song)}
                    className="p-2 rounded-full bg-[var(--accent)] text-white opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-all hover:bg-[var(--accent-hover)] active:scale-95 focus-ring"
                    title="播放"
                  >
                    <Play className="w-4 h-4 ml-0.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {songs.length === 0 && !isScanning && (
        <div className="text-center py-20">
          <div className="w-16 h-16 mx-auto mb-5 rounded-3xl bg-[var(--bg-tertiary)] flex items-center justify-center">
            <FolderOpen className="w-8 h-8 text-[var(--text-tertiary)]" />
          </div>
          <p className="text-[var(--text-tertiary)]">点击「扫描」按钮发现本地音乐文件</p>
        </div>
      )}
    </div>
  );
}
