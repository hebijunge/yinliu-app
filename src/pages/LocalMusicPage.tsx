import { useState, useCallback, useEffect } from 'react';
import { HardDrive, RefreshCw, Music, Play, FolderOpen } from 'lucide-react';
import { scanLocalMusic, revokeScannedCoverUrls } from '../modules/music/localScanner';
import type { ScannedSong } from '../modules/music/localScanner';
import { playerEngine } from '../core/player';
import { SkeletonList } from '../components/ui/Skeleton';
import { useVirtualList } from '../shared/hooks/useVirtualList';
import SmartCover from '../components/ui/SmartCover';

export default function LocalMusicPage() {
  const [songs, setSongs] = useState<ScannedSong[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanPath, setScanPath] = useState('');

  // C8：封面 Blob URL 生命周期管理 —— 卸载时统一 revoke，防内存泄漏
  useEffect(() => {
    return () => revokeScannedCoverUrls();
  }, []);

  const handleScan = useCallback(async () => {
    setIsScanning(true);
    try {
      // 重新扫描前撤销上一批封面 URL
      revokeScannedCoverUrls();
      const dirs = scanPath ? [scanPath] : undefined;
      const scanned = await scanLocalMusic(dirs);
      setSongs(scanned);
    } catch (err) {
      console.error('扫描失败:', err);
    } finally {
      setIsScanning(false);
    }
  }, [scanPath]);

  const handlePlay = async (song: ScannedSong) => {
    await playerEngine.playTrack({
      id: song.id,
      title: song.title,
      artist: song.artist,
      album: song.album,
      duration: song.duration,
      coverUrl: song.coverUrl,
      sourceId: 'local',
      sourceSongId: song.filePath,
      uri: `file://${song.filePath}`,
    });
  };

  const formatDuration = (seconds: number) => {
    if (!seconds) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // P3：本地音乐列表虚拟化（固定行高 100px）
  const { scrollRef, virtualItems, totalSize, rowStyle } = useVirtualList(songs, 100);

  return (
    <div className="max-w-4xl mx-auto w-full h-full flex flex-col">
      <div className="flex items-center justify-between mb-8 flex-shrink-0">
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
          支持格式：MP3、FLAC、AAC、M4A、OGG、WAV、WMA
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
        <SkeletonList count={5} />
      )}

      {/* Song List（P3 虚拟化：固定行高 100px 内部滚动视口） */}
      {!isScanning && songs.length > 0 && (
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto pr-1">
          <div style={{ height: totalSize, position: 'relative' }}>
            {virtualItems.map((vRow) => {
              const song = songs[vRow.index];
              return (
                <div
                  key={song.id}
                  style={rowStyle(vRow)}
                  className="flex items-center gap-4 p-4 rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] hover:border-[var(--accent)]/30 transition-all duration-200 group"
                >
                  <div className="w-14 h-14 rounded-2xl bg-[var(--bg-tertiary)] flex-shrink-0 flex items-center justify-center overflow-hidden border border-[var(--border-subtle)]">
                    <SmartCover src={song.coverUrl} alt="" className="w-full h-full" />
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

                  <button
                    onClick={() => handlePlay(song)}
                    className="p-2 rounded-full bg-[var(--accent)] text-white opacity-0 group-hover:opacity-100 transition-all hover:bg-[var(--accent-hover)] active:scale-95 focus-ring"
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
