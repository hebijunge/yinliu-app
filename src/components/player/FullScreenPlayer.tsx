import { X, Play, Pause, SkipBack, SkipForward, Volume2, ChevronDown } from 'lucide-react';
import { usePlayerStore } from '../../shared/store/playerStore';
import { playerEngine } from '../../core/player';

interface Props {
  onClose: () => void;
}

export default function FullScreenPlayer({ onClose }: Props) {
  const { state, currentTrack, currentTime, duration, volume } = usePlayerStore();
  const isPlaying = state === 'playing';

  const formatTime = (t: number) => {
    if (!isFinite(t)) return '0:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="fixed inset-0 z-50 bg-[var(--bg-primary)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button onClick={onClose} className="p-2 rounded-xl hover:bg-[var(--bg-tertiary)] transition-colors focus-ring">
          <ChevronDown className="w-6 h-6" />
        </button>
        <span className="text-sm font-medium text-[var(--text-secondary)]">正在播放</span>
        <button onClick={onClose} className="p-2 rounded-xl hover:bg-[var(--bg-tertiary)] transition-colors focus-ring">
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Cover */}
      <div className="flex-1 flex items-center justify-center px-8">
        <div className={`w-64 h-64 md:w-80 md:h-80 rounded-3xl bg-gradient-to-br from-[var(--accent)]/30 to-[var(--accent-hover)]/20 flex items-center justify-center shadow-2xl ring-1 ring-[var(--border-subtle)] ${isPlaying ? 'animate-pulse-slow' : ''}`}>
          {currentTrack?.coverUrl ? (
            <img src={currentTrack.coverUrl} alt="" className="w-full h-full rounded-3xl object-cover" />
          ) : (
            <div className="flex flex-col items-center">
              <svg className="w-20 h-20 text-[var(--accent)]/40" viewBox="0 0 64 64" fill="none">
                <path d="M22 48V20l24-4v24" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="18" cy="48" r="6" stroke="currentColor" strokeWidth="2.5" />
                <circle cx="42" cy="44" r="6" stroke="currentColor" strokeWidth="2.5" />
              </svg>
              <span className="text-2xl font-bold text-[var(--text-tertiary)] mt-4">音流</span>
            </div>
          )}
        </div>
      </div>

      {/* Info */}
      <div className="px-8 py-4 text-center">
        <h2 className="text-xl font-bold truncate">{currentTrack?.title || '未在播放'}</h2>
        <p className="text-[var(--text-secondary)] mt-1">{currentTrack?.artist || '选择一首歌'}</p>
      </div>

      {/* Progress */}
      <div className="px-8 py-2">
        <div
          className="w-full h-1.5 bg-[var(--bg-tertiary)] rounded-full cursor-pointer group relative"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const percent = (e.clientX - rect.left) / rect.width;
            playerEngine.seek(percent * duration);
          }}
        >
          <div className="h-full bg-[var(--accent)] rounded-full relative" style={{ width: `${progressPercent}%` }}>
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>
        <div className="flex justify-between text-xs text-[var(--text-tertiary)] mt-1.5 tabular-nums">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-6 py-6">
        <button
          onClick={() => playerEngine.seek(Math.max(0, currentTime - 10))}
          className="p-3 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
          title="后退 10 秒"
        >
          <SkipBack className="w-6 h-6" />
        </button>
        <button
          onClick={() => {
            if (isPlaying) playerEngine.pause();
            else if (currentTrack) playerEngine.resume();
          }}
          className="p-5 rounded-full bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] active:scale-95 transition-all shadow-lg shadow-[var(--accent)]/20 focus-ring"
          title={isPlaying ? '暂停' : '播放'}
        >
          {isPlaying ? <Pause className="w-8 h-8" /> : <Play className="w-8 h-8 ml-1" />}
        </button>
        <button
          onClick={() => playerEngine.seek(Math.min(duration, currentTime + 10))}
          className="p-3 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
          title="前进 10 秒"
        >
          <SkipForward className="w-6 h-6" />
        </button>
      </div>

      {/* Volume */}
      <div className="px-8 pb-8 flex items-center gap-3">
        <Volume2 className="w-5 h-5 text-[var(--text-secondary)]" />
        <div className="flex-1 h-1.5 bg-[var(--bg-tertiary)] rounded-full cursor-pointer group relative"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const percent = (e.clientX - rect.left) / rect.width;
            playerEngine.setVolume(percent);
          }}
        >
          <div className="h-full bg-[var(--accent)] rounded-full relative" style={{ width: `${volume * 100}%` }}>
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-white rounded-full shadow-sm opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>
      </div>
    </div>
  );
}
