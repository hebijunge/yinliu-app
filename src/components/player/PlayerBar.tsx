import { useState, useEffect, useCallback } from 'react';
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, ListMusic, Mic2, Download } from 'lucide-react';
import { usePlayerStore } from '../../shared/store/playerStore';
import { playerEngine } from '../../core/player';
import { lyricsManager } from '../../modules/music/lyrics';
import { downloadEngine } from '../../core/download';
import FullScreenPlayer from './FullScreenPlayer';
import type { ParsedLyrics } from '../../modules/music/lyrics';

export default function PlayerBar() {
  const { state, currentTrack, currentTime, duration, volume, isMuted } = usePlayerStore();
  const [showFullScreen, setShowFullScreen] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);
  const [lyrics, setLyrics] = useState<ParsedLyrics | null>(null);
  const [currentLineIndex, setCurrentLineIndex] = useState(-1);
  const isPlaying = state === 'playing';

  // 加载歌词
  useEffect(() => {
    if (!currentTrack) {
      setLyrics(null);
      return;
    }

    lyricsManager.getLyrics(currentTrack.sourceSongId, currentTrack.sourceId).then((parsed) => {
      setLyrics(parsed);
    });
  }, [currentTrack]);

  // 更新当前歌词行
  useEffect(() => {
    if (!lyrics) return;
    const index = lyricsManager.getCurrentLineIndex(lyrics, currentTime);
    setCurrentLineIndex(index);
  }, [lyrics, currentTime]);

  const formatTime = (t: number) => {
    if (!isFinite(t)) return '0:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  const handleDownload = useCallback(() => {
    if (!currentTrack) return;
    const { usePlayerStore } = require('../../shared/store/playerStore');
    const quality = usePlayerStore.getState().currentQuality;
    downloadEngine.addDownload(
      currentTrack.sourceSongId,
      currentTrack.sourceId,
      quality
    );
  }, [currentTrack]);

  return (
    <>
      {/* Lyrics Panel */}
      {showLyrics && lyrics && (
        <div className="fixed inset-x-0 bottom-[var(--player-height)] lg:bottom-[var(--player-height)] z-50 bg-[var(--bg-secondary)]/95 backdrop-blur border-t border-[var(--border)] max-h-64 overflow-y-auto">
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-medium text-sm">歌词</h3>
              <button
                onClick={() => setShowLyrics(false)}
                className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              >
                关闭
              </button>
            </div>
            <div className="space-y-1 text-center">
              {lyrics.lines.map((line, index) => (
                <div
                  key={index}
                  className={`py-1 transition-colors ${
                    index === currentLineIndex
                      ? 'text-[var(--accent)] font-medium text-lg'
                      : 'text-[var(--text-secondary)] text-sm'
                  }`}
                >
                  {line.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="bg-[var(--bg-secondary)] border-t border-[var(--border)] px-4 py-2">
        {/* Progress bar */}
        <div className="w-full h-1 bg-[var(--bg-tertiary)] rounded-full mb-2 cursor-pointer group"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const percent = (e.clientX - rect.left) / rect.width;
            playerEngine.seek(percent * duration);
          }}
        >
          <div
            className="h-full bg-[var(--accent)] rounded-full group-hover:bg-[var(--accent-hover)] transition-all relative"
            style={{ width: `${progressPercent}%` }}
          >
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-[var(--accent)] rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Track info */}
          <div
            className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer"
            onClick={() => setShowFullScreen(true)}
          >
            <div className="w-10 h-10 rounded-lg bg-[var(--bg-tertiary)] flex-shrink-0 overflow-hidden">
              {currentTrack?.coverUrl ? (
                <img src={currentTrack.coverUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <ListMusic className="w-5 h-5 text-[var(--text-tertiary)]" />
                </div>
              )}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">
                {currentTrack?.title || '未在播放'}
              </div>
              <div className="text-xs text-[var(--text-tertiary)] truncate">
                {currentTrack?.artist || '选择一首歌开始播放'}
              </div>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => playerEngine.seek(Math.max(0, currentTime - 10))}
              className="p-2 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
            >
              <SkipBack className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                if (isPlaying) playerEngine.pause();
                else if (currentTrack) playerEngine.resume();
              }}
              className="p-2.5 rounded-full bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] active:scale-95 transition-all"
            >
              {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
            </button>
            <button
              onClick={() => playerEngine.seek(Math.min(duration, currentTime + 10))}
              className="p-2 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
            >
              <SkipForward className="w-4 h-4" />
            </button>
          </div>

          {/* Extra Controls */}
          <div className="hidden md:flex items-center gap-2">
            <button
              onClick={() => setShowLyrics(!showLyrics)}
              className={`p-1.5 rounded-full hover:bg-[var(--bg-tertiary)] ${showLyrics ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`}
              title="歌词"
            >
              <Mic2 className="w-4 h-4" />
            </button>
            <button
              onClick={handleDownload}
              className="p-1.5 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
              title="下载"
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                if (isMuted) playerEngine.setVolume(volume);
                else playerEngine.setVolume(0);
                usePlayerStore.getState().toggleMute();
              }}
              className="p-1.5 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
            >
              {isMuted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <span className="text-xs text-[var(--text-tertiary)] tabular-nums">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>
        </div>
      </div>

      {/* Full Screen Player */}
      {showFullScreen && (
        <FullScreenPlayer onClose={() => setShowFullScreen(false)} />
      )}
    </>
  );
}
