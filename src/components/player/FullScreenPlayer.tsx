import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, Play, Pause, SkipBack, SkipForward, Volume2, ChevronDown,
  Mic2, ListMusic, Repeat, Repeat1, Shuffle, AudioLines, Heart,
} from 'lucide-react';
import { usePlayerStore } from '../../shared/store/playerStore';
import { usePlaylistStore } from '../../shared/store/playlistStore';
import { useResponsiveLayout } from '../../shared/hooks/useResponsiveLayout';
import { playerEngine } from '../../core/player';
import { lyricsManager } from '../../modules/music/lyrics';
import QueuePanel from './QueuePanel';
import QualitySelector, { qualityLabel } from './QualitySelector';
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
  const { state, currentTrack, currentTime, duration, volume, queue, repeatMode, currentQuality, actualQuality, isPreview, actualSourceId } = usePlayerStore();
  const isPlaying = state === 'playing';
  const { isLandscape } = useResponsiveLayout();

  const [showLyrics, setShowLyrics] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  const [lyrics, setLyrics] = useState<ParsedLyrics | null>(null);
  const [currentLineIndex, setCurrentLineIndex] = useState(-1);

  const lyricsScrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const progressTouchRef = useRef<HTMLDivElement>(null);
  const volumeTouchRef = useRef<HTMLDivElement>(null);

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

  const { toggleFavorite, favorites } = usePlaylistStore();
  const isFav = currentTrack ? favorites.has(currentTrack.sourceSongId) : false;

  const handlePrev = useCallback(() => playerEngine.playPrevious(), []);
  const handleNext = useCallback(() => playerEngine.playNext(), []);
  const handleCycleMode = useCallback(() => usePlayerStore.getState().cycleRepeatMode(), []);

  const handleToggleFavorite = useCallback(() => {
    if (!currentTrack) return;
    const song = {
      songId: currentTrack.sourceSongId,
      title: currentTrack.title,
      artist: currentTrack.artist,
      source: currentTrack.sourceId,
      quality: currentQuality,
    };
    void toggleFavorite(song);
  }, [currentTrack, toggleFavorite]);

  const ModeIcon = MODE_ICONS[repeatMode];

  // ===== 进度条拖拽逻辑（支持扩展热区） =====
  const handleProgressClick = useCallback((clientX: number, rect: DOMRect) => {
    const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    playerEngine.seek(percent * duration);
  }, [duration]);

  const handleProgressTouchStart = useCallback((e: React.TouchEvent) => {
    if (!progressTouchRef.current) return;
    const rect = progressTouchRef.current.getBoundingClientRect();
    handleProgressClick(e.touches[0].clientX, rect);
  }, [handleProgressClick]);

  const handleProgressTouchMove = useCallback((e: React.TouchEvent) => {
    if (!progressTouchRef.current) return;
    const rect = progressTouchRef.current.getBoundingClientRect();
    handleProgressClick(e.touches[0].clientX, rect);
  }, [handleProgressClick]);

  // ===== 音量条拖拽逻辑 =====
  const handleVolumeClick = useCallback((clientX: number, rect: DOMRect) => {
    const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    playerEngine.setVolume(percent);
  }, []);

  const handleVolumeTouchStart = useCallback((e: React.TouchEvent) => {
    if (!volumeTouchRef.current) return;
    const rect = volumeTouchRef.current.getBoundingClientRect();
    handleVolumeClick(e.touches[0].clientX, rect);
  }, [handleVolumeClick]);

  const handleVolumeTouchMove = useCallback((e: React.TouchEvent) => {
    if (!volumeTouchRef.current) return;
    const rect = volumeTouchRef.current.getBoundingClientRect();
    handleVolumeClick(e.touches[0].clientX, rect);
  }, [handleVolumeClick]);

  // ===== 封面区域 =====
  const CoverArea = (
    <div className={`flex items-center justify-center ${isLandscape ? 'h-full px-6' : 'px-10 py-4'}`}>
      <div
        key={currentTrack?.id || 'no-track'}
        className={`cover-crossfade bg-[var(--bg-tertiary)] flex items-center justify-center border border-[var(--border-subtle)] overflow-hidden ${isPlaying ? 'animate-pulse-slow' : ''} ${
          isLandscape
            ? 'w-full max-w-[320px] aspect-square rounded-[1.5rem]'
            : 'w-64 h-64 md:w-80 md:h-80 rounded-[2rem]'
        }`}
        style={!isLandscape ? { maxHeight: '50vh' } : undefined}
      >
        {currentTrack?.coverUrl ? (
          <img src={currentTrack.coverUrl} alt="" className="w-full h-full object-cover" />
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
  );

  // ===== 歌词区域 =====
  const LyricsArea = lyrics ? (
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
              onClick={() => {
                playerEngine.seek(line.time);
              }}
              className={`transition-all duration-500 py-1 cursor-pointer select-none ${
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
    <div className="absolute inset-0 flex flex-col items-center justify-center px-8">
      <Mic2 className="w-12 h-12 text-[var(--text-tertiary)] opacity-30 mb-4" />
      <p className="text-[var(--text-tertiary)] text-sm">暂无歌词</p>
      <p className="text-[var(--text-tertiary)] text-xs opacity-60 mt-1">该曲目暂未匹配到歌词</p>
    </div>
  );

  // ===== 信息区 =====
  const InfoArea = (
    <div className={`text-center ${isLandscape ? 'text-left' : ''}`}>
      <h2 className="text-xl font-semibold truncate text-[var(--text-primary)]">{currentTrack?.title || '未在播放'}</h2>
      <p className="text-[var(--text-secondary)] mt-1.5 text-sm">
        {currentTrack?.artist || '选择一首歌'}
        {actualSourceId && (
          <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
            {actualSourceId}
          </span>
        )}
      </p>
      <button
        onClick={() => setShowQuality(true)}
        className="mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors focus-ring"
        title="切换音质"
      >
        <AudioLines className="w-3.5 h-3.5" />
        {qualityLabel(currentQuality)}
        {actualQuality && actualQuality !== currentQuality && (
          <span className="text-amber-500">实际 {qualityLabel(actualQuality)}</span>
        )}
        {isPreview && <span className="text-amber-500">试听</span>}
      </button>
    </div>
  );

  // ===== 进度条区（44px 触控热区） =====
  const ProgressArea = (
    <div className="px-10 py-2">
      <div
        ref={progressTouchRef}
        className="w-full rounded-full cursor-pointer group relative"
        style={{ height: '44px', display: 'flex', alignItems: 'center' }}
        onClick={(e) => {
          const rect = progressTouchRef.current!.getBoundingClientRect();
          handleProgressClick(e.clientX, rect);
        }}
        onTouchStart={handleProgressTouchStart}
        onTouchMove={handleProgressTouchMove}
      >
        {/* 视觉进度条（保持细线） */}
        <div className="w-full h-[3px] bg-[var(--bg-tertiary)] rounded-full relative">
          <div className="h-full bg-[var(--accent)] rounded-full progress-bar-smooth relative" style={{ width: `${progressPercent}%` }}>
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-white rounded-full border-2 border-[var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>
      </div>
      <div className="flex justify-between text-xs text-[var(--text-tertiary)] mt-1 tabular-nums">
        <span>{formatTime(currentTime)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );

  // ===== 控制按钮区 =====
  const ControlsArea = (
    <div className="flex items-center justify-center gap-8 py-5">
      <button
        onClick={handlePrev}
        className="p-3 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
        style={{ minWidth: '48px', minHeight: '48px' }}
        title="上一首"
      >
        <SkipBack className="w-6 h-6" />
      </button>
      <button
        onClick={() => {
          if (isPlaying) playerEngine.pause();
          else if (currentTrack) playerEngine.resume();
        }}
        className="p-5 rounded-full bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] play-btn-transition focus-ring"
        style={{ minWidth: '56px', minHeight: '56px' }}
        title={isPlaying ? '暂停' : '播放'}
      >
        {isPlaying ? <Pause className="w-8 h-8 transition-transform duration-200" /> : <Play className="w-8 h-8 ml-1 transition-transform duration-200" />}
      </button>
      <button
        onClick={handleNext}
        className="p-3 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
        style={{ minWidth: '48px', minHeight: '48px' }}
        title="下一首"
      >
        <SkipForward className="w-6 h-6" />
      </button>
    </div>
  );

  // ===== 音量区（44px 触控热区） =====
  const VolumeArea = (
    <div className="px-10 pb-8 flex items-center gap-4">
      <Volume2 className="w-5 h-5 text-[var(--text-secondary)]" />
      <div
        ref={volumeTouchRef}
        className="flex-1 rounded-full cursor-pointer group relative"
        style={{ height: '44px', display: 'flex', alignItems: 'center' }}
        onClick={(e) => {
          const rect = volumeTouchRef.current!.getBoundingClientRect();
          handleVolumeClick(e.clientX, rect);
        }}
        onTouchStart={handleVolumeTouchStart}
        onTouchMove={handleVolumeTouchMove}
      >
        <div className="w-full h-[3px] bg-[var(--bg-tertiary)] rounded-full relative">
          <div className="h-full bg-[var(--accent)] rounded-full relative" style={{ width: `${volume * 100}%` }}>
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-white rounded-full border-2 border-[var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 bg-[var(--bg-primary)] flex flex-col">
      {/* Queue Panel overlay */}
      {showQueue && <QueuePanel onClose={() => setShowQueue(false)} />}
      {/* Quality Selector overlay */}
      {showQuality && <QualitySelector onClose={() => setShowQuality(false)} />}

      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 flex-shrink-0">
        <button onClick={onClose} className="p-2 rounded-2xl hover:bg-[var(--bg-tertiary)] transition-colors focus-ring" style={{ minWidth: '40px', minHeight: '40px' }}>
          <ChevronDown className="w-6 h-6 text-[var(--text-secondary)]" />
        </button>
        <span className="text-sm font-medium text-[var(--text-secondary)]">正在播放</span>
        <div className="flex items-center gap-2">
          {/* Favorite toggle */}
          {currentTrack && (
            <button
              onClick={handleToggleFavorite}
              className={`p-2 rounded-2xl hover:bg-[var(--bg-tertiary)] transition-colors focus-ring ${
                isFav ? 'text-red-500' : 'text-[var(--text-secondary)]'
              }`}
              style={{ minWidth: '40px', minHeight: '40px' }}
              title={isFav ? '取消收藏' : '收藏'}
            >
              <Heart className={`w-5 h-5 ${isFav ? 'fill-current' : ''}`} />
            </button>
          )}
          {/* Mode toggle */}
          <button
            onClick={handleCycleMode}
            className={`p-2 rounded-2xl hover:bg-[var(--bg-tertiary)] transition-colors focus-ring ${
              repeatMode !== 'sequence' ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
            }`}
            style={{ minWidth: '40px', minHeight: '40px' }}
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
            style={{ minWidth: '40px', minHeight: '40px' }}
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
            style={{ minWidth: '40px', minHeight: '40px' }}
            title="播放队列"
          >
            <ListMusic className="w-5 h-5" />
            {queue.length > 0 && (
              <span className="absolute top-0.5 right-0.5 min-w-[14px] h-[14px] px-0.5 bg-[var(--accent)] text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                {queue.length}
              </span>
            )}
          </button>
          <button onClick={onClose} className="p-2 rounded-2xl hover:bg-[var(--bg-tertiary)] transition-colors focus-ring" style={{ minWidth: '40px', minHeight: '40px' }}>
            <X className="w-5 h-5 text-[var(--text-secondary)]" />
          </button>
        </div>
      </div>

      {/* ===== 横屏布局：封面左 + 内容右 ===== */}
      {isLandscape ? (
        <div className="flex-1 flex overflow-hidden gesture-safe-area">
          {/* 左侧：封面 */}
          <div className="w-[40%] flex items-center justify-center">
            {CoverArea}
          </div>
          {/* 右侧：信息 + 歌词/封面切换 + 控制 */}
          <div className="w-[60%] flex flex-col overflow-hidden pr-6">
            {/* 歌词或信息区 */}
            <div className="flex-1 overflow-hidden relative">
              {showLyrics ? LyricsArea : (
                <div className="h-full flex flex-col items-center justify-center">
                  {InfoArea}
                </div>
              )}
            </div>
            {ProgressArea}
            {ControlsArea}
            {VolumeArea}
          </div>
        </div>
      ) : (
        /* ===== 竖屏布局：原有弹性布局 ===== */
        <>
          {/* Main content: Cover or Lyrics */}
          <div className="flex-1 overflow-hidden relative">
            {showLyrics ? LyricsArea : (
              /* Cover view */
              <div className="flex-1 flex items-center justify-center px-10 h-full">
                {CoverArea}
              </div>
            )}
          </div>

          {/* Info */}
          <div className="px-10 py-4 text-center flex-shrink-0">
            {InfoArea}
          </div>

          {ProgressArea}
          {ControlsArea}
          {VolumeArea}
        </>
      )}
    </div>
  );
}
