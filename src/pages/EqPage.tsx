import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, SlidersHorizontal, Plus, X, Check, RotateCcw } from 'lucide-react';
import {
  useEqStore,
  EQ_BANDS,
  EQ_PRESETS,
  EQ_GAIN_MIN,
  EQ_GAIN_MAX,
  flushEqPersist,
} from '@core/player/equalizer';
import ConfirmDialog from '../components/common/ConfirmDialog';

export default function EqPage() {
  const navigate = useNavigate();
  const { enabled, presetId, gains, customPresets, setEnabled, applyPreset, setBandGain, saveCustomPreset, deleteCustomPreset } = useEqStore();
  const [showSave, setShowSave] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [savedTip, setSavedTip] = useState('');
  // P2：savedTip 定时器清理——卸载时不残留 setTimeout
  const savedTipTimerRef = useRef<number | null>(null);
  // P2：删除自定义预设二次确认
  const [deletePresetName, setDeletePresetName] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (savedTipTimerRef.current !== null) {
        window.clearTimeout(savedTipTimerRef.current);
        savedTipTimerRef.current = null;
      }
      // 卸载前冲刷滑杆防抖中未落盘的增益
      flushEqPersist();
    };
  }, []);

  const isBuiltIn = presetId in EQ_PRESETS;
  const currentLabel = presetId.startsWith('custom:')
    ? presetId.slice('custom:'.length)
    : EQ_PRESETS[presetId]?.label || '自定义';

  const handleSave = () => {
    if (saveCustomPreset(presetName)) {
      setSavedTip(presetName.trim());
      setPresetName('');
      setShowSave(false);
      if (savedTipTimerRef.current !== null) {
        window.clearTimeout(savedTipTimerRef.current);
      }
      savedTipTimerRef.current = window.setTimeout(() => {
        setSavedTip('');
        savedTipTimerRef.current = null;
      }, 2000);
    }
  };

  const confirmDeletePreset = () => {
    if (deletePresetName) {
      deleteCustomPreset(deletePresetName);
      setDeletePresetName(null);
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/settings')}
            className="p-2 rounded-2xl hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
            aria-label="返回设置"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-2xl font-light text-[var(--text-primary)]">均衡器</h1>
            <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
              {enabled ? `当前：${currentLabel}` : '已关闭，播放保持原声直出'}
            </p>
          </div>
        </div>
        <button
          onClick={() => setEnabled(!enabled)}
          className={`px-4 py-2 rounded-2xl text-sm font-medium transition-all focus-ring ${
            enabled
              ? 'bg-[var(--accent)] text-white'
              : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }`}
        >
          {enabled ? '已开启' : '已关闭'}
        </button>
      </div>

      {/* 预设 */}
      <div className="yinliu-card mb-4">
        <div className="flex items-center gap-2 mb-3">
          <SlidersHorizontal className="w-4 h-4 text-[var(--text-tertiary)]" />
          <span className="text-sm font-medium text-[var(--text-primary)]">预设</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(EQ_PRESETS).map(([id, preset]) => (
            <button
              key={id}
              onClick={() => applyPreset(id)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all focus-ring ${
                presetId === id
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {preset.label}
            </button>
          ))}
          {customPresets.map((p) => (
            <span
              key={p.name}
              className={`inline-flex items-center gap-1 pl-3 pr-1.5 py-1.5 rounded-full text-sm font-medium transition-all ${
                presetId === `custom:${p.name}`
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
              }`}
            >
              <button onClick={() => applyPreset(`custom:${p.name}`)} className="focus-ring rounded-full">
                {p.name}
              </button>
              <button
                onClick={() => setDeletePresetName(p.name)}
                className={`p-1 rounded-full transition-colors ${
                  presetId === `custom:${p.name}` ? 'hover:bg-white/20' : 'hover:bg-[var(--bg-primary)]'
                }`}
                aria-label={`删除预设 ${p.name}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* 5 段滑杆 */}
      <div className={`yinliu-card mb-4 ${enabled ? '' : 'opacity-50 pointer-events-none'}`}>
        <div className="space-y-4">
          {EQ_BANDS.map((band, i) => (
            <div key={band.freq} className="flex items-center gap-3">
              <span className="w-16 text-xs font-mono text-[var(--text-tertiary)] shrink-0">{band.label}</span>
              <input
                type="range"
                min={EQ_GAIN_MIN}
                max={EQ_GAIN_MAX}
                step={1}
                value={gains[i]}
                onChange={(e) => setBandGain(i, Number(e.target.value))}
                className="flex-1 accent-[var(--accent)]"
                aria-label={`${band.label} 增益`}
              />
              <span className="w-12 text-right text-xs font-mono text-[var(--text-secondary)] shrink-0">
                {gains[i] > 0 ? '+' : ''}{gains[i]}dB
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between mt-4 pt-3 border-t border-[var(--border-subtle)]">
          <span className="text-xs text-[var(--text-tertiary)]">
            {isBuiltIn ? '手动拖动会自动切换为自定义' : '自定义曲线'}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => applyPreset('flat')}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors focus-ring"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              归零
            </button>
            <button
              onClick={() => setShowSave(!showSave)}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors focus-ring"
            >
              <Plus className="w-3.5 h-3.5" />
              保存为预设
            </button>
          </div>
        </div>
        {showSave && (
          <div className="flex items-center gap-2 mt-3">
            <input
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              placeholder="输入预设名称"
              maxLength={12}
              className="flex-1 px-3 py-2 rounded-xl bg-[var(--bg-tertiary)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
            <button
              onClick={handleSave}
              disabled={!presetName.trim()}
              className="inline-flex items-center gap-1 px-4 py-2 rounded-xl text-sm font-medium bg-[var(--accent)] text-white disabled:opacity-40 transition-opacity focus-ring"
            >
              <Check className="w-4 h-4" />
              保存
            </button>
          </div>
        )}
        {savedTip && (
          <p className="text-xs text-[var(--accent)] mt-2">已保存预设「{savedTip}」</p>
        )}
      </div>

      <div className="yinliu-card">
        <p className="text-xs text-[var(--text-tertiary)] leading-relaxed">
          均衡器基于 Web Audio API 实现，对流式播放（边下边播）与本地播放同时生效。开关与预设会自动保存；
          若个别播放路径无法安全接入均衡器，会自动保持原声直出，不影响播放。
        </p>
      </div>

      {/* P2：删除自定义预设二次确认 */}
      <ConfirmDialog
        open={!!deletePresetName}
        title="删除自定义预设"
        message={`确定要删除预设「${deletePresetName || ''}」吗？删除后不可恢复。`}
        confirmText="删除"
        onConfirm={confirmDeletePreset}
        onCancel={() => setDeletePresetName(null)}
      />
    </div>
  );
}
