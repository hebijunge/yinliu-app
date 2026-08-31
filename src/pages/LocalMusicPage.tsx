import { useState, useCallback } from 'react';
import { HardDrive, RefreshCw, Music, Play, FolderOpen } from 'lucide-react';
import { scanLocalMusic, localSongToSearchResult } from '../modules/music/localScanner';
import type { ScannedSong } from '../modules/music/localScanner';
import { playerEngine } from '../core/player';

export default function LocalMusicPage() {
  const [songs, setSongs] = useState<ScannedSong[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanPath, setScanPath] = useState('');

  const handleScan = useCallback(async () => {
    setIsScanning(true);
    try {
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

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <HardDrive className="w-6 h-6" />
          本地音乐
        </h1>
      </div>

      {/* Scan Controls */}
      <div className="yinliu-card mb-6">
        <div className="flex gap-2 mb-3">
          <div className="flex-1 relative">
            <FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" />
            <input
              type="text"
              value={scanPath}
              onChange={(e) => setScanPath(e.target.value)}
              placeholder="输入扫描目录（留空使用默认）..."
              className="yinliu-input w-full pl-9"
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
        <div className="text-sm text-[var(--text-secondary)] mb-4">
          共找到 {songs.length} 首本地歌曲
        </div>
      )}

      {/* Song List */}
      <div className="space-y-2">
        {songs.map((song) => (
          <div
            key={song.id}
            className="flex items-center gap-3 p-3 rounded-lg bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors group"
          >
            <div className="w-12 h-12 rounded-lg bg-[var(--bg-tertiary)] flex-shrink-0 flex items-center justify-center overflow-hidden">
              {song.coverUrl ? (
                <img src={song.coverUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <Music className="w-5 h-5 text-[var(--text-tertiary)]" />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{song.title}</div>
              <div className="text-sm text-[var(--text-secondary)] truncate">
                {song.artist} {song.album && `· ${song.album}`}
              </div>
            </div>

            <div className="text-xs text-[var(--text-tertiary)] hidden sm:block">
              {song.format.toUpperCase()}
            </div>

            <div className="text-xs text-[var(--text-tertiary)] tabular-nums hidden md:block">
              {formatDuration(song.duration)}
            </div>

            <button
              onClick={() => handlePlay(song)}
              className="p-2 rounded-full bg-[var(--accent)] text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--accent-hover)]"
            >
              <Play className="w-4 h-4 ml-0.5" />
            </button>
          </div>
        ))}
      </div>

      {songs.length === 0 && !isScanning && (
        <div className="text-center py-12 text-[var(--text-tertiary)]">
          点击「扫描」按钮发现本地音乐文件
        </div>
      )}
    </div>
  );
}
