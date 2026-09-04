import { useState, useMemo } from 'react';
import { X, Check, Play } from 'lucide-react';
import { PLATFORM_ABBREVS } from '@core/platformPriority';

export interface QualityOption {
  sourceId: string;
  sourceName: string;
  quality: string; // 'Hi-Res' | '无损' | '320K' | '192K' | '128K'
  bitrateLabel: string;
  fileSize?: string; // e.g. '51.2MB'
  url?: string;
}

export interface DownloadQualitySheetProps {
  songTitle: string;
  songArtist?: string;
  options: QualityOption[];
  onClose: () => void;
  onDownload: (selected: QualityOption[]) => void | Promise<void>;
  onPlay?: () => void;
}

const QUALITY_ORDER = ['Hi-Res', '无损', '320K', '192K', '128K'];

export default function DownloadQualitySheet({
  songTitle,
  songArtist,
  options,
  onClose,
  onDownload,
  onPlay,
}: DownloadQualitySheetProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 按音质分组
  const grouped = useMemo(() => {
    const map = new Map<string, QualityOption[]>();
    for (const q of QUALITY_ORDER) {
      map.set(q, []);
    }
    for (const opt of options) {
      const group = map.get(opt.quality) || [];
      group.push(opt);
      map.set(opt.quality, group);
    }
    return Array.from(map.entries()).filter(([, items]) => items.length > 0);
  }, [options]);

  const allKeys = useMemo(() => options.map((o) => `${o.sourceId}-${o.quality}`), [options]);

  const isAllSelected = selected.size === allKeys.length && allKeys.length > 0;

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    if (isAllSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allKeys));
    }
  };

  const handleDownload = () => {
    const sel = options.filter((o) => selected.has(`${o.sourceId}-${o.quality}`));
    onDownload(sel);
  };

  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end" onClick={onClose}>
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

      {/* 底部弹窗 */}
      <div
        className="relative bg-[var(--bg-secondary)] rounded-t-3xl max-h-[85vh] flex flex-col panel-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-[var(--border-subtle)]">
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-[var(--text-primary)] truncate">
              下载音质（多平台）
            </h3>
            <p className="text-xs text-[var(--text-tertiary)] truncate">
              {songArtist ? `${songTitle} - ${songArtist}` : songTitle}
            </p>
          </div>
          <div className="flex items-center gap-2 ml-3">
            {onPlay && (
              <button
                onClick={onPlay}
                className="p-2 rounded-full text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--accent)]"
                title="播放"
              >
                <Play className="w-5 h-5" />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 rounded-full text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              title="关闭"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {grouped.map(([quality, items]) => (
            <div key={quality}>
              <div className="text-sm font-semibold text-[var(--text-primary)] mb-2.5 flex items-center gap-2">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    quality === 'Hi-Res'
                      ? 'bg-purple-500'
                      : quality === '无损'
                      ? 'bg-amber-500'
                      : quality === '320K'
                      ? 'bg-blue-500'
                      : quality === '192K'
                      ? 'bg-green-500'
                      : 'bg-gray-400'
                  }`}
                />
                {quality}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {items.map((opt) => {
                  const key = `${opt.sourceId}-${opt.quality}`;
                  const isSel = selected.has(key);
                  const abbrev = PLATFORM_ABBREVS[opt.sourceId] || opt.sourceId;
                  return (
                    <button
                      key={key}
                      onClick={() => toggle(key)}
                      className={`relative rounded-xl border p-3 text-left transition-all ${
                        isSel
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                          : 'border-[var(--border-subtle)] bg-[var(--bg-tertiary)] hover:border-[var(--border)]'
                      }`}
                    >
                      {isSel && (
                        <div className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-[var(--accent)] flex items-center justify-center">
                          <Check className="w-2.5 h-2.5 text-white" />
                        </div>
                      )}
                      <div className="text-sm font-medium text-[var(--text-primary)]">
                        {abbrev}
                      </div>
                      {opt.fileSize && (
                        <div className="text-[10px] text-[var(--text-tertiary)] mt-0.5">
                          {opt.fileSize}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {options.length === 0 && (
            <div className="text-center py-8 text-[var(--text-tertiary)] text-sm">
              暂无可用下载选项
            </div>
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="px-5 py-4 border-t border-[var(--border-subtle)] flex items-center justify-between gap-3">
          <button
            onClick={toggleAll}
            disabled={options.length === 0}
            className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40 transition-colors flex items-center gap-1.5"
          >
            <div
              className={`w-4 h-4 rounded border flex items-center justify-center ${
                isAllSelected
                  ? 'bg-[var(--accent)] border-[var(--accent)]'
                  : 'border-[var(--text-tertiary)]'
              }`}
            >
              {isAllSelected && <Check className="w-3 h-3 text-white" />}
            </div>
            全选
          </button>
          <button
            onClick={handleDownload}
            disabled={selected.size === 0}
            className="yinliu-btn px-6 py-2.5 text-sm disabled:opacity-40"
          >
            下载选中 ({selected.size})
          </button>
        </div>
      </div>
    </div>
  );
}
