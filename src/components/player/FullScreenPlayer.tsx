import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, Play, Pause, SkipBack, SkipForward, Volume2, ChevronDown,
  Mic2, ListMusic, Repeat, Repeat1, Shuffle,
} from 'lucide-react';
import { usePlayerStore } from '../../shared/store/playerStore';
import { playerEngine } from '../../core/player';
import { lyricsManager } from '../../modules/music/lyrics';
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

interface Props {
  onClose: () => void;
}

export default function FullScreenPlayer({ onClose }: Props) {
  const { state, currentTrack, currentTime, duration, volume, queue, repeatMode } = usePlayerStore();
  const isPlaying = state === 'playing';

  const [showLyrics, setShowLyrics] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [lyrics, setLyrics] = useState<ParsedLyrics | null>(null);
  const [currentLineIndex, setCurrentLineIndex] = useState(-1);

  const lyricsScrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Load lyrics
  useEffect(() => {
    if (!currentTrack) {
      setLyrics(null);
      return;
    }
    lyricsManager.getLyrics(currentTrack.sourceSongId, currentTrack.sourceId).then((parsed) => {
      setLyrics(parsed);
    });
  }, [currentTrack]);

  // Update current lyric line
  useEffect(() => {
    if (!lyrics) return;
    const index = lyricsManager.getCurrentLineIndex(lyrics, currentTime);
    setCurrentLineIndex(index);
  }, [lyrics, currentTime]);

  // Auto-scroll to current lyric line
  useEffect(() => {
    if (!showLyrics || currentLineIndex < 0) return;
    const el = lineRefs.current[currentLineIndex];
    const container = lyricsScrollRef.current;
    if (el && container) {
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const relativeTop = elRect.top - containerRect.top;
      const target = container.scrollTop + relativeTop - containerRect.height / 2 + elRect.height / 2;
      container.scrollTo({ top: target, behavior: 'smooth' });
    }
  }, [currentLineIndex, showLyrics]);

  const formatTime = (t: number) => {
    if (!isFinite(t)) return '0:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  const handlePrev = useCallback(() => playerEngine.playPrevious(), []);
  const handleNext = useCallback(() => playerEngine.playNext(), []);
  const handleCycleMode = useCallback(() => usePlayerStore.getState().cycleRepeatMode(), []);

  const ModeIcon = MODE_ICONS[repeatMode];

  return (
    <div className="fixed inset-0 z-50 bg-[var(--bg-primary)] flex flex-col">
      {/* Queue Panel overlay */}
      {showQueue && <QueuePanel onClose={() => setShowQueue(false)} />}

      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4">
        <button onClick={onClose} className="p-2 rounded-2xl hover:bg-[var(--bg-tertiary)] transition-colors focus-ring">
          <ChevronDown className="w-6 h-6 text-[var(--text-secondary)]" />
        </button>
        <span className="text-sm font-medium text-[var(--text-secondary)]">正在播放</span>
        <div className="flex items-center gap-2">
          {/* Mode toggle */}
          <button
            onClick={handleCycleMode}
            className={`p-2 rounded-2xl hover:bg-[var(--bg-tertiary)] transition-colors focus-ring ${
              repeatMode !== 'sequence' ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
            }`}
            title={MODE_LABELS[repeatMode]}
          >
            <ModeIcon className="w-5 h-5" />
          </button>
          {/* Lyrics toggle */}
          <button
            onClick={() => setShowLyrics(!showLyrics)}
            className={`p-2 rounded-2xl hover:bg-[var(--bg-tertiary)] transition-colors focus-ring ${
              showLyrics ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
            }`}
            title="歌词"
          >
            <Mic2 className="w-5 h-5" />
          </button>
          {/* Queue toggle */}
          <button
            onClick={() => setShowQueue(!showQueue)}
            className={`p-2 rounded-2xl hover:bg-[var(--bg-tertiary)] transition-colors focus-ring relative ${
              showQueue ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
            }`}
            title="播放队列"
          >
            <ListMusic className="w-5 h-5" />
            {queue.length > 0 && (
              <span className="absolute top-0.5 right-0.5 min-w-[14px] h-[14px] px-0.5 bg-[var(--accent)] text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                {queue.length}
              </span>
            )}
          </button>
          <button onClick={onClose} className="p-2 rounded-2xl hover:bg-[var(--bg-tertiary)] transition-colors focus-ring">
            <X className="w-5 h-5 text-[var(--text-secondary)]" />
          </button>
        </div>
      </div>

      {/* Main content: Cover or Lyrics */}
      <div className="flex-1 overflow-hidden relative">
        {showLyrics && lyrics ? (
          /* Lyrics view */
          <div
            ref={lyricsScrollRef}
            className="absolute inset-0 overflow-y-auto px-8 py-6 scrollbar-hide"
          >
            <div className="space-y-4 text-center min-h-full flex flex-col justify-center">
              {lyrics.lines.map((line, index) => {
                const isActive = index === currentLineIndex;
                const distance = Math.abs(index - currentLineIndex);
                return (
                  <div
                    key={index}
                    ref={(el) => { lineRefs.current[index] = el; }}
                    className={`transition-all duration-500 py-1 ${
                      isActive
                        ? 'text-[var(--accent)] font-bold text-xl scale-105'
                        : distance === 1
                        ? 'text-[var(--text-secondary)] text-base opacity-70'
                        : 'text-[var(--text-tertiary)] text-sm opacity-40'
                    }`}
                  >
                    {line.text}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          /* Cover view */
          <div className="flex-1 flex items-center justify-center px-10 h-full">
            <div className={`w-64 h-64 md:w-80 md:h-80 rounded-[2rem] bg-[var(--bg-tertiary)] flex items-center justify-center border border-[var(--border-subtle)] ${isPlaying ? 'animate-pulse-slow' : ''}`}>
              {currentTrack?.coverUrl ? (
                <img src={currentTrack.coverUrl} alt="" className="w-full h-full rounded-[2rem] object-cover" />
              ) : (
                <div className="flex flex-col items-center">
                  <svg className="w-16 h-16 text-[var(--text-tertiary)]" viewBox="0 0 64 64" fill="none">
                    <rect x="6" y="6" width="52" height="52" rx="18" stroke="currentColor" strokeWidth="2" opacity="0.2" />
                    <path d="M24 46V22l20-4v20" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                    <circle cx="20" cy="46" r="5" stroke="currentColor" strokeWidth="2" />
                    <circle cx="40" cy="42" r="5" stroke="currentColor" strokeWidth="2" />
                  </svg>
                  <span className="text-xl font-light text-[var(--text-tertiary)] mt-5 tracking-widest">音流</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="px-10 py-5 text-center">
        <h2 className="text-xl font-semibold truncate text-[var(--text-primary)]">{currentTrack?.title || '未在播放'}</h2>
        <p className="text-[var(--text-secondary)] mt-1.5 text-sm">{currentTrack?.artist || '选择一首歌'}</p>
      </div>

      {/* Progress */}
      <div className="px-10 py-2">
        <div
          className="w-full h-1 bg-[var(--bg-tertiary)] rounded-full cursor-pointer group relative"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const percent = (e.clientX - rect.left) / rect.width;
            playerEngine.seek(percent * duration);
          }}
        >
          <div className="h-full bg-[var(--accent)] rounded-full relative" style={{ width: `${progressPercent}%` }}>
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full border-2 border-[var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>
        <div className="flex justify-between text-xs text-[var(--text-tertiary)] mt-2 tabular-nums">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-8 py-7">
        <button
          onClick={handlePrev}
          className="p-3 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
          title="上一首"
        >
          <SkipBack className="w-6 h-6" />
        </button>
        <button
          onClick={() => {
            if (isPlaying) playerEngine.pause();
            else if (currentTrack) playerEngine.resume();
          }}
          className="p-5 rounded-full bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] active:scale-95 transition-all focus-ring"
          title={isPlaying ? '暂停' : '播放'}
        >
          {isPlaying ? <Pause className="w-8 h-8" /> : <Play className="w-8 h-8 ml-1" />}
        </button>
        <button
          onClick={handleNext}
          className="p-3 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
          title="下一首"
        >
          <SkipForward className="w-6 h-6" />
        </button>
      </div>

      {/* Volume */}
      <div className="px-10 pb-10 flex items-center gap-4">
        <Volume2 className="w-5 h-5 text-[var(--text-secondary)]" />
        <div className="flex-1 h-1 bg-[var(--bg-tertiary)] rounded-full cursor-pointer group relative"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const percent = (e.clientX - rect.left) / rect.width;
            playerEngine.setVolume(percent);
          }}
        >
          <div className="h-full bg-[var(--accent)] rounded-full relative" style={{ width: `${volume * 100}%` }}>
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-white rounded-full border-2 border-[var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>
      </div>
    </div>
  );
}
