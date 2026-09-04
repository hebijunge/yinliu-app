import { useState } from 'react';
import { X, Timer, Check, Moon, Music } from 'lucide-react';
import {
  useSleepTimerStore,
  formatSleepTimerRemaining,
  type SleepTimerMode,
} from '../../shared/store/sleepTimerStore';

interface Props {
  onClose: () => void;
}

const PRESET_MINUTES = [15, 30, 45, 60];

export default function SleepTimerPanel({ onClose }: Props) {
  const { active, mode, remainingSeconds, totalSeconds, startDuration, startEndOfTrack, cancel } =
    useSleepTimerStore();

  const [customMinutes, setCustomMinutes] = useState('');
  const [selectedMode, setSelectedMode] = useState<SleepTimerMode>('duration');

  const handlePreset = (minutes: number) => {
    startDuration(minutes);
    onClose();
  };

  const handleCustom = () => {
    const min = parseInt(customMinutes, 10);
    if (!isNaN(min) && min > 0) {
      startDuration(min);
      onClose();
    }
  };

  const handleEndOfTrack = () => {
    startEndOfTrack();
    onClose();
  };

  const progressPercent =
    active && mode === 'duration' && totalSeconds > 0
      ? (remainingSeconds / totalSeconds) * 100
      : 0;

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-end justify-center sm:items-center">
      <div className="w-full max-w-md bg-[var(--bg-primary)] rounded-t-3xl sm:rounded-3xl p-6 max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Moon className="w-5 h-5 text-[var(--accent)]" />
            <h3 className="text-lg font-semibold text-[var(--text-primary)]">睡眠定时</h3>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-2xl hover:bg-[var(--bg-tertiary)] transition-colors focus-ring"
          >
            <X className="w-5 h-5 text-[var(--text-secondary)]" />
          </button>
        </div>

        {/* Active status */}
        {active && (
          <div className="mb-6 p-4 rounded-2xl bg-[var(--accent)]/10 border border-[var(--accent)]/20">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-[var(--accent)]">
                {mode === 'duration' ? '倒计时进行中' : '播完当前曲'}
              </span>
              <button
                onClick={cancel}
                className="text-xs px-3 py-1 rounded-full bg-[var(--accent)]/15 text-[var(--accent)] hover:bg-[var(--accent)]/25 transition-colors"
              >
                取消定时
              </button>
            </div>
            {mode === 'duration' && (
              <>
                <div className="text-3xl font-light text-[var(--text-primary)] tabular-nums">
                  {formatSleepTimerRemaining(remainingSeconds)}
                </div>
                <div className="w-full h-1.5 bg-[var(--bg-tertiary)] rounded-full mt-3">
                  <div
                    className="h-full bg-[var(--accent)] rounded-full transition-all duration-1000"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </>
            )}
            {mode === 'end-of-track' && (
              <div className="text-sm text-[var(--text-secondary)] flex items-center gap-2">
                <Music className="w-4 h-4" />
                当前曲目播放完毕后自动暂停
              </div>
            )}
          </div>
        )}

        {/* Mode selector */}
        <div className="flex gap-2 mb-5">
          <button
            onClick={() => setSelectedMode('duration')}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-2xl text-sm font-medium transition-all focus-ring ${
              selectedMode === 'duration'
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)]'
            }`}
          >
            <Timer className="w-4 h-4" />
            倒计时
          </button>
          <button
            onClick={() => setSelectedMode('end-of-track')}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-2xl text-sm font-medium transition-all focus-ring ${
              selectedMode === 'end-of-track'
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)]'
            }`}
          >
            <Music className="w-4 h-4" />
            播完当前曲
          </button>
        </div>

        {selectedMode === 'duration' && (
          <>
            {/* Presets */}
            <div className="grid grid-cols-4 gap-2 mb-4">
              {PRESET_MINUTES.map((min) => (
                <button
                  key={min}
                  onClick={() => handlePreset(min)}
                  className="flex flex-col items-center gap-1 p-3 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] hover:border-[var(--accent)]/30 hover:text-[var(--accent)] transition-colors focus-ring"
                >
                  <span className="text-lg font-semibold">{min}</span>
                  <span className="text-[10px] text-[var(--text-tertiary)]">分钟</span>
                </button>
              ))}
            </div>

            {/* Custom input */}
            <div className="flex items-center gap-2 mb-4">
              <div className="flex-1 flex items-center gap-2 p-3 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
                <input
                  type="number"
                  min={1}
                  max={999}
                  placeholder="自定义分钟"
                  value={customMinutes}
                  onChange={(e) => setCustomMinutes(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCustom()}
                  className="flex-1 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
                />
                <span className="text-xs text-[var(--text-tertiary)]">分钟</span>
              </div>
              <button
                onClick={handleCustom}
                disabled={!customMinutes || parseInt(customMinutes, 10) <= 0}
                className="p-3 rounded-2xl bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-ring"
              >
                <Check className="w-5 h-5" />
              </button>
            </div>
          </>
        )}

        {selectedMode === 'end-of-track' && (
          <button
            onClick={handleEndOfTrack}
            className="w-full flex items-center justify-center gap-2 p-4 rounded-2xl bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors focus-ring"
          >
            <Music className="w-5 h-5" />
            开启播完当前曲
          </button>
        )}

        <p className="text-[11px] text-[var(--text-tertiary)] mt-4 text-center leading-relaxed">
          到点时间会渐弱音量 3 秒后自动暂停，保护听力
        </p>
      </div>
    </div>
  );
}
