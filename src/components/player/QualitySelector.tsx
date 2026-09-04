import { useState } from 'react';
import { X, Check, AudioLines, TriangleAlert } from 'lucide-react';
import { usePlayerStore } from '../../shared/store/playerStore';
import { playerEngine } from '../../core/player';
import { Quality } from '../../core/types';

interface Props {
  onClose: () => void;
}

const QUALITY_OPTIONS: Array<{
  value: Quality;
  label: string;
  desc: string;
}> = [
  { value: Quality.MASTER, label: '超无损母带', desc: '20900k 母带级 · 酷我专供' },
  { value: Quality.DOLBY, label: '至臻全景声', desc: '20501k 空间音频 · 酷我专供' },
  { value: Quality.ZHIZHEN, label: '至臻音质 2.0', desc: '20201k 超清母带 · 酷我专供' },
  { value: Quality.STANDARD, label: '标准', desc: '128K MP3 · 省流量' },
  { value: Quality.HIGH, label: '高品', desc: '320K MP3 · 推荐均衡' },
  { value: Quality.LOSSLESS, label: '无损', desc: 'FLAC · 音质优先' },
  { value: Quality.HIRES, label: 'Hi-Res', desc: '高解析度 · 依音源支持' },
];

export function qualityLabel(q: Quality): string {
  return QUALITY_OPTIONS.find((o) => o.value === q)?.label ?? q;
}

export default function QualitySelector({ onClose }: Props) {
  const { currentQuality, actualQuality, currentTrack } = usePlayerStore();
  const [switching, setSwitching] = useState(false);

  const qualityMismatch = actualQuality && actualQuality !== currentQuality;

  const handleSelect = async (q: Quality) => {
    if (q === currentQuality || switching) return;
    const prevQuality = currentQuality;
    usePlayerStore.getState().setQuality(q);
    if (currentTrack) {
      setSwitching(true);
      try {
        await playerEngine.switchQuality(q);
        onClose();
      } catch {
        // 切档失败：回滚到原档位（engine 已弹 Toast 提示原因），弹窗保持打开供用户重选
        usePlayerStore.getState().setQuality(prevQuality);
      } finally {
        setSwitching(false);
      }
    } else {
      onClose();
    }
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] bg-[var(--bg-secondary)] rounded-t-[2rem] shadow-lg border-t border-[var(--border-subtle)] max-h-[70vh] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-subtle)]">
        <div>
          <h3 className="font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <AudioLines className="w-4 h-4 text-[var(--accent)]" />
            音质
          </h3>
          <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
            {switching ? '正在切换音质…' : '切换后立即重新取链播放当前曲目'}
          </p>
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-xl hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] transition-colors focus-ring"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Actual quality notice */}
      {(qualityMismatch || usePlayerStore.getState().isPreview) && (
        <div className="mx-4 mt-3 p-3 rounded-2xl bg-amber-500/5 border border-amber-500/15 flex items-start gap-2">
          <TriangleAlert className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-500/90 leading-relaxed">
            {qualityMismatch && `音源未提供所选档位，实际生效：${qualityLabel(actualQuality)}`}
            {usePlayerStore.getState().isPreview && (qualityMismatch ? '；当前为试听片段' : '当前为试听片段（VIP 歌曲）')}
          </p>
        </div>
      )}

      {/* Options */}
      <div className="flex-1 overflow-y-auto px-4 py-3 scrollbar-hide">
        <div className="space-y-1">
          {QUALITY_OPTIONS.map((option) => {
            const isCurrent = option.value === currentQuality;
            return (
              <button
                key={option.value}
                onClick={() => handleSelect(option.value)}
                disabled={switching}
                className={`w-full flex items-center justify-between px-4 py-3.5 rounded-2xl transition-colors text-left disabled:opacity-60 ${
                  isCurrent ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-tertiary)]'
                }`}
              >
                <div>
                  <div className={`text-sm font-medium ${isCurrent ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
                    {option.label}
                  </div>
                  <div className="text-xs text-[var(--text-tertiary)] mt-0.5">{option.desc}</div>
                </div>
                {isCurrent && <Check className="w-4 h-4 text-[var(--accent)] flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
