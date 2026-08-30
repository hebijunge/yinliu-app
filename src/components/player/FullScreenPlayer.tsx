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
        <button onClick={onClose} className="p-2 rounded-full hover:bg-[var(--bg-tertiary)]">
          <ChevronDown className="w-6 h-6" />
        </button>
        <span className="text-sm text-[var(--text-secondary)]">正在播放</span>
        <button onClick={onClose} className="p-2 rounded-full hover:bg-[var(--bg-tertiary)]">
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Cover */}
      <div className="flex-1 flex items-center justify-center px-8">
        <div className={`w-64 h-64 md:w-80 md:h-80 rounded-2xl bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center shadow-2xl ${isPlaying ? 'animate-pulse-slow' : ''}`}>
          {currentTrack?.coverUrl ? (
            <img src={currentTrack.coverUrl} alt="" className="w-full h-full rounded-2xl object-cover" />
          ) : (
            <span className="text-6xl font-bold text-white/50">音流</span>
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
        <div className="w-full h-1.5 bg-[var(--bg-tertiary)] rounded-full cursor-pointer"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const percent = (e.clientX - rect.left) / rect.width;
            playerEngine.seek(percent * duration);
          }}
        >
          <div className="h-full bg-[var(--accent)] rounded-full" style={{ width: `${progressPercent}%` }} />
        </div>
        <div className="flex justify-between text-xs text-[var(--text-tertiary)] mt-1">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-6 py-6">
        <button onClick={() => playerEngine.seek(Math.max(0, currentTime - 10))} className="p-3 rounded-full hover:bg-[var(--bg-tertiary)]">
          <SkipBack className="w-6 h-6" />
        </button>
        <button
          onClick={() => {
            if (isPlaying) playerEngine.pause();
            else if (currentTrack) playerEngine.resume();
          }}
          className="p-4 rounded-full bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] active:scale-95 transition-all"
        >
          {isPlaying ? <Pause className="w-8 h-8" /> : <Play className="w-8 h-8 ml-1" />}
        </button>
        <button onClick={() => playerEngine.seek(Math.min(duration, currentTime + 10))} className="p-3 rounded-full hover:bg-[var(--bg-tertiary)]">
          <SkipForward className="w-6 h-6" />
        </button>
      </div>

      {/* Volume */}
      <div className="px-8 pb-8 flex items-center gap-3">
        <Volume2 className="w-5 h-5 text-[var(--text-secondary)]" />
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          onChange={(e) => playerEngine.setVolume(parseFloat(e.target.value))}
          className="flex-1 h-1 bg-[var(--bg-tertiary)] rounded-full appearance-none cursor-pointer accent-[var(--accent)]"
        />
      </div>
    </div>
  );
}
