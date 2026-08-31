import { useState, useEffect, useCallback } from 'react';
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX,
  ListMusic, Mic2, Download, Repeat, Repeat1, Shuffle,
} from 'lucide-react';
import { usePlayerStore } from '../../shared/store/playerStore';
import { playerEngine } from '../../core/player';
import { lyricsManager } from '../../modules/music/lyrics';
import { downloadEngine } from '../../core/download';
import { useSettingsStore } from '../../shared/store/settingsStore';
import FullScreenPlayer from './FullScreenPlayer';
import QueuePanel from './QueuePanel';
import type { ParsedLyrics } from '../../modules/music/lyrics';
import type { RepeatMode } from '../../shared/store/playerStore';

const MODE_ICONS: Record<RepeatMode, typeof Repeat> = {
  sequence: ListMusic,
  'repeat-all': Repeat,
  'repeat-one': Repeat1,
  shuffle: Shuffle,
};

const MODE_LABELS: Record<RepeatMode, string> = {
  sequence: '顺序播放',
  'repeat-all': '列表循环',
  'repeat-one': '单曲循环',
  shuffle: '随机播放',
};

export default function PlayerBar() {
  const { state, currentTrack, currentTime, duration, volume, isMuted, queue, repeatMode } = usePlayerStore();
  const [showFullScreen, setShowFullScreen] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
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
    // 使用设置页的默认下载音质（真实生效）
    const quality = useSettingsStore.getState().downloadQuality;
    downloadEngine.addDownload(
      currentTrack.sourceSongId,
      currentTrack.sourceId,
      quality,
      {
        title: currentTrack.title,
        artist: currentTrack.artist,
        album: currentTrack.album,
      }
    );
  }, [currentTrack]);

  const handlePrev = () => playerEngine.playPrevious();
  const handleNext = () => playerEngine.playNext();
  const handleCycleMode = () => usePlayerStore.getState().cycleRepeatMode();

  const ModeIcon = MODE_ICONS[repeatMode];

  return (
    <>
      {/* Lyrics Panel */}
      {showLyrics && lyrics && (
        <div className="fixed inset-x-0 bottom-[var(--player-height)] lg:bottom-[var(--player-height)] z-50 bg-[var(--bg-secondary)]/95 backdrop-blur-lg border-t border-[var(--border-subtle)] max-h-64 overflow-y-auto">
          <div className="p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-sm text-[var(--text-primary)]">歌词</h3>
              <button
                onClick={() => setShowLyrics(false)}
                className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] px-3 py-1.5 rounded-xl hover:bg-[var(--bg-tertiary)] transition-colors"
              >
                关闭
              </button>
            </div>
            <div className="space-y-1 text-center">
              {lyrics.lines.map((line, index) => (
                <div
                  key={index}
                  className={`py-1.5 transition-all duration-300 ${
                    index === currentLineIndex
                      ? 'text-[var(--accent)] font-semibold text-lg scale-[1.02]'
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

      {/* Queue Panel */}
      {showQueue && <QueuePanel onClose={() => setShowQueue(false)} />}

      <div className="bg-[var(--bg-secondary)]/95 backdrop-blur-md border-t border-[var(--border-subtle)] px-5 py-2.5">
        {/* Progress bar */}
        <div
          className="w-full h-[3px] bg-[var(--bg-tertiary)] rounded-full mb-2.5 cursor-pointer group relative"
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
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-white rounded-full border-2 border-[var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Track info */}
          <div
            className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer group"
            onClick={() => setShowFullScreen(true)}
          >
            <div className="w-10 h-10 rounded-2xl bg-[var(--bg-tertiary)] flex-shrink-0 overflow-hidden border border-[var(--border-subtle)] group-hover:border-[var(--accent)]/30 transition-all">
              {currentTrack?.coverUrl ? (
                <img src={currentTrack.coverUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <ListMusic className="w-5 h-5 text-[var(--text-tertiary)]" />
                </div>
              )}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate group-hover:text-[var(--accent)] transition-colors text-[var(--text-primary)]">
                {currentTrack?.title || '未在播放'}
              </div>
              <div className="text-xs text-[var(--text-tertiary)] truncate">
                {currentTrack?.artist || '选择一首歌开始播放'}
              </div>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={handlePrev}
              className="p-2 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
              title="上一首"
            >
              <SkipBack className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                if (isPlaying) playerEngine.pause();
                else if (currentTrack) playerEngine.resume();
              }}
              className="p-2.5 rounded-full bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] active:scale-95 transition-all focus-ring"
              title={isPlaying ? '暂停' : '播放'}
            >
              {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
            </button>
            <button
              onClick={handleNext}
              className="p-2 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
              title="下一首"
            >
              <SkipForward className="w-4 h-4" />
            </button>
          </div>

          {/* Extra Controls */}
          <div className="hidden md:flex items-center gap-1.5">
            {/* Playback mode */}
            <button
              onClick={handleCycleMode}
              className={`p-1.5 rounded-full hover:bg-[var(--bg-tertiary)] transition-colors focus-ring ${
                repeatMode !== 'sequence' ? 'text-[var(--accent)] bg-[var(--accent-soft)]' : 'text-[var(--text-secondary)]'
              }`}
              title={MODE_LABELS[repeatMode]}
            >
              <ModeIcon className="w-4 h-4" />
            </button>

            {/* Queue */}
            <button
              onClick={() => setShowQueue(!showQueue)}
              className={`p-1.5 rounded-full hover:bg-[var(--bg-tertiary)] transition-colors focus-ring relative ${
                showQueue ? 'text-[var(--accent)] bg-[var(--accent-soft)]' : 'text-[var(--text-secondary)]'
              }`}
              title="播放队列"
            >
              <ListMusic className="w-4 h-4" />
              {queue.length > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 bg-[var(--accent)] text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                  {queue.length}
                </span>
              )}
            </button>

            <button
              onClick={() => setShowLyrics(!showLyrics)}
              className={`p-1.5 rounded-full hover:bg-[var(--bg-tertiary)] transition-colors focus-ring ${showLyrics ? 'text-[var(--accent)] bg-[var(--accent-soft)]' : 'text-[var(--text-secondary)]'}`}
              title="歌词"
            >
              <Mic2 className="w-4 h-4" />
            </button>
            <button
              onClick={handleDownload}
              className="p-1.5 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
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
              className="p-1.5 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
              title={isMuted || volume === 0 ? '取消静音' : '静音'}
            >
              {isMuted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <span className="text-xs text-[var(--text-tertiary)] tabular-nums min-w-[4.5rem] text-right">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>
        </div>
      </div>

      {/* Full Screen Player */}
      {showFullScreen && <FullScreenPlayer onClose={() => setShowFullScreen(false)} />}
    </>
  );
}
