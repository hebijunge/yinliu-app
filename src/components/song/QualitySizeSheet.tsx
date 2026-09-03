import { useState, useEffect, useMemo } from 'react';
import { Play, X, Check, Download, Loader2 } from 'lucide-react';
import { toast } from '../../shared/components/Toast';
import { downloadEngine } from '../../core/download';
import { sourceRegistry } from '../../providers/music/registry';
import {
  QUALITY_TIER_ORDER,
  QUALITY_TIER_LABELS,
  tierToQuality,
  qualityToTier,
} from '../../core/types';
import type { QualityTier, QualityOption } from '../../core/types';
import type { AggregatedSearchResult } from '../../core/search';
import {
  PLATFORM_DISPLAY_NAMES,
} from '../../core/platformPriority';

/**
 * 音质弹窗（v20：按参考图重做——档位横排区块 + 平台逐行列表）：
 * 底部抽屉「下载音质（多平台）」：
 * - 头部：标题 + ▶ 播放按钮 + × 关闭
 * - 按 Hi-Res/无损/320K/192K/128K 分区块，每区块左侧色块标识
 *   区块内逐行列出「平台名 + 文件大小」，整行可选中
 * - 底部：全选 + 「下载选中 (n)」
 *
 * 数据来源（保留 v19.x 逻辑）：
 * 1. 首屏快照：聚合结果里各源自带的 sizes
 * 2. 打开弹窗时对全部源并行调 getQualityOptions 实时取真实档位与大小
 * 3. 实时结果按源整块替换快照；取不到的源保留快照
 */

/** 弹窗内单个可选项 */
interface OptionBlock {
  key: string;           // sourceId:tier
  sourceId: string;
  sourceName: string;
  tier: QualityTier;
  sizeBytes?: number;
}

interface QualitySizeSheetProps {
  song: AggregatedSearchResult | null;
  open: boolean;
  onClose: () => void;
  onPlay?: (song: AggregatedSearchResult) => void;
}

/** 档位左侧色块（参考图：Hi-Res/无损 黄、320K 红、192K 紫、128K 蓝） */
const TIER_COLORS: Record<QualityTier, string> = {
  master: 'bg-gradient-to-b from-fuchsia-500 to-amber-500',
  dolby: 'bg-gradient-to-b from-violet-500 to-fuchsia-500',
  zhizhen: 'bg-gradient-to-b from-emerald-500 to-teal-500',
  hires: 'bg-amber-500',
  lossless: 'bg-yellow-500',
  '320k': 'bg-red-500',
  '192k': 'bg-purple-500',
  '128k': 'bg-blue-500',
};

/** 档位文字颜色（与色块对应，用于标题） */
const TIER_TEXT_COLORS: Record<QualityTier, string> = {
  master: 'text-fuchsia-400',
  dolby: 'text-violet-400',
  zhizhen: 'text-emerald-400',
  hires: 'text-amber-400',
  lossless: 'text-yellow-400',
  '320k': 'text-red-400',
  '192k': 'text-purple-400',
  '128k': 'text-blue-400',
};

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)}GB`;
  if (mb >= 1) return `${mb.toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** 骨架屏：与新布局一致的档位区块 + 逐行占位 */
function QualitySizeSheetSkeleton() {
  return (
    <div className="px-4 py-3 space-y-5">
      {QUALITY_TIER_ORDER.map((tier) => (
        <div key={tier}>
          {/* 档位标题占位 */}
          <div className="flex items-center gap-2 mb-2">
            <div className={`w-3 h-3 rounded-sm ${TIER_COLORS[tier]} opacity-30`} />
            <div className="h-4 w-16 rounded-md bg-[var(--bg-tertiary)] skeleton-shimmer" />
          </div>
          {/* 平台行占位 */}
          <div className="space-y-1.5">
            {[0, 1].map((i) => (
              <div
                key={`${tier}-${i}`}
                className="flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-[var(--bg-secondary)]"
              >
                <div className="h-4 w-16 rounded-md bg-[var(--bg-tertiary)] skeleton-shimmer" />
                <div className="h-3 w-12 rounded-md bg-[var(--bg-tertiary)] skeleton-shimmer opacity-50" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function QualitySizeSheet({ song, open, onClose, onPlay }: QualitySizeSheetProps) {
  const [blocks, setBlocks] = useState<OptionBlock[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // 打开时构建选项（先用聚合携带的 sizes 做首屏快照，再对全部源实时取真实数据）
  useEffect(() => {
    if (!open || !song) return;

    setSelected(new Set());

    const buildFromSizes = (
      sourceId: string,
      sourceName: string,
      sizes?: Partial<Record<QualityTier, number>>
    ): OptionBlock[] => {
      const blocks: OptionBlock[] = [];
      const seen = new Set<QualityTier>();
      for (const tier of QUALITY_TIER_ORDER) {
        const size = sizes?.[tier];
        if (size) {
          if (seen.has(tier)) continue;
          seen.add(tier);
          blocks.push({ key: `${sourceId}:${tier}`, sourceId, sourceName, tier, sizeBytes: size });
        }
      }
      return blocks;
    };

    const initial: OptionBlock[] = [];
    for (const s of song.sources) {
      const name = PLATFORM_DISPLAY_NAMES[s.sourceId] || s.sourceName;
      const blocks = buildFromSizes(s.sourceId, name, s.sizes);
      if (blocks.length > 0) {
        initial.push(...blocks);
      } else {
        // 快照兜底：无任何大小信息 → 按该源最高音质归一个无大小块（实时结果返回后整块替换）
        const tier = qualityToTier(s.maxQuality) || '128k';
        initial.push({ key: `${s.sourceId}:${tier}`, sourceId: s.sourceId, sourceName: name, tier });
      }
    }
    setBlocks(initial);

    // 对全部源实时取真实音质/大小（并行、best-effort），成功则按源整块替换快照
    let cancelled = false;
    setLoading(true);
    (async () => {
      const fetchedBySource = new Map<string, OptionBlock[]>();
      await Promise.allSettled(
        song.sources.map(async (s) => {
          const source = sourceRegistry.get(s.sourceId);
          if (!source || typeof source.getQualityOptions !== 'function') return;
          try {
            const options: QualityOption[] = await source.getQualityOptions(s.sourceSongId);
            if (!options || options.length === 0) return;
            const name = PLATFORM_DISPLAY_NAMES[s.sourceId] || s.sourceName;
            const seen = new Set<QualityTier>();
            const blocks: OptionBlock[] = [];
            for (const opt of options) {
              if (seen.has(opt.tier)) continue;
              seen.add(opt.tier);
              blocks.push({
                key: `${s.sourceId}:${opt.tier}`,
                sourceId: s.sourceId,
                sourceName: name,
                tier: opt.tier,
                sizeBytes: opt.sizeBytes,
              });
            }
            if (blocks.length > 0) fetchedBySource.set(s.sourceId, blocks);
          } catch {
            // 静默失败：该源保留快照数据
          }
        })
      );
      if (cancelled) return;
      setBlocks((prev) => {
        const pending = new Map(fetchedBySource);
        const out: OptionBlock[] = [];
        for (const b of prev) {
          const replacement = pending.get(b.sourceId);
          if (replacement) {
            out.push(...replacement);
            pending.delete(b.sourceId);
          } else {
            out.push(b);
          }
        }
        for (const replacement of pending.values()) out.push(...replacement);
        return out;
      });
      setLoading(false);
    })();

    return () => {
      cancelled = true;
      setLoading(false);
    };
  }, [open, song]);

  // 按音质分组（高→低）
  const grouped = useMemo(() => {
    const groups: { tier: QualityTier; items: OptionBlock[] }[] = [];
    for (const tier of QUALITY_TIER_ORDER) {
      const items = blocks.filter((b) => b.tier === tier);
      if (items.length > 0) groups.push({ tier, items });
    }
    return groups;
  }, [blocks]);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selected.size === blocks.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(blocks.map((b) => b.key)));
    }
  };

  const handleDownload = async () => {
    if (!song || selected.size === 0 || downloading) return;
    setDownloading(true);
    let queued = 0;
    let failed = 0;

    for (const key of selected) {
      const block = blocks.find((b) => b.key === key);
      if (!block) continue;
      const source = song.sources.find((s) => s.sourceId === block.sourceId);
      if (!source) continue;
      try {
        const task = await downloadEngine.createTask({
          songId: source.sourceSongId,
          sourceId: source.sourceId,
          quality: tierToQuality(block.tier),
          title: song.title,
          artist: song.artist,
          availableSources: [
            { sourceId: source.sourceId, sourceSongId: source.sourceSongId },
          ],
        });
        downloadEngine.startDownload(task.id);
        queued++;
      } catch {
        failed++;
      }
    }

    setDownloading(false);
    if (queued > 0) {
      toast.success('已加入下载队列', `${song.title} · ${queued} 个文件`);
      onClose();
    }
    if (failed > 0 && queued === 0) {
      toast.error('下载失败', '所选音质暂不可用');
    }
  };

  if (!open || !song) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/50" />

      {/* 底部抽屉 */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-lg bg-[var(--bg-primary)] rounded-t-2xl shadow-2xl max-h-[80vh] flex flex-col"
      >
        {/* 头部：标题 + ▶ + × */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <div className="flex-1 min-w-0">
            <div className="text-base font-semibold text-[var(--text-primary)] truncate">
              下载音质（多平台）
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onPlay?.(song)}
              className="p-2 rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
              title="播放"
              aria-label="播放"
            >
              <Play className="w-5 h-5" />
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
              title="关闭"
              aria-label="关闭"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* 分组列表：档位区块 + 平台逐行 */}
        <div className="flex-1 overflow-y-auto">
          {loading && grouped.length === 0 ? (
            <QualitySizeSheetSkeleton />
          ) : grouped.length === 0 ? (
            <div className="text-center py-8 text-sm text-[var(--text-tertiary)]">
              暂无可用的音质信息
            </div>
          ) : (
            <div className="px-4 py-3 space-y-5">
              {grouped.map(({ tier, items }) => (
                <div key={tier}>
                  {/* 档位标题：色块 + 档位名 */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`w-3 h-3 rounded-sm ${TIER_COLORS[tier]}`} />
                    <span className={`text-sm font-semibold ${TIER_TEXT_COLORS[tier]}`}>
                      {QUALITY_TIER_LABELS[tier]}
                    </span>
                  </div>
                  {/* 平台列表：逐行排列 */}
                  <div className="space-y-1.5">
                    {items.map((b) => {
                      const isSel = selected.has(b.key);
                      const displayName = PLATFORM_DISPLAY_NAMES[b.sourceId] || b.sourceName;
                      return (
                        <button
                          key={b.key}
                          onClick={() => toggle(b.key)}
                          className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-left transition-all active:scale-[0.98] ${
                            isSel
                              ? 'bg-[var(--accent-soft)] border border-[var(--accent)]'
                              : 'bg-[var(--bg-secondary)] border border-transparent hover:bg-[var(--bg-tertiary)]'
                          }`}
                        >
                          <span className="text-sm font-medium text-[var(--text-primary)]">
                            {displayName}
                          </span>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-[var(--text-tertiary)]">
                              {formatSize(b.sizeBytes) || QUALITY_TIER_LABELS[b.tier]}
                            </span>
                            {isSel && (
                              <span className="w-5 h-5 rounded-full bg-[var(--accent)] flex items-center justify-center flex-shrink-0">
                                <Check className="w-3 h-3 text-white" />
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底部操作区：全选 + 下载选中 */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-primary)]">
          <button
            onClick={handleSelectAll}
            disabled={blocks.length === 0}
            className="px-4 py-2 rounded-full text-sm font-medium text-[var(--text-secondary)] bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] disabled:opacity-40 transition-colors"
          >
            {selected.size === blocks.length && blocks.length > 0 ? '取消全选' : '全选'}
          </button>
          <button
            onClick={handleDownload}
            disabled={selected.size === 0 || downloading}
            className="flex items-center gap-2 px-5 py-2 rounded-full text-sm font-medium text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 transition-colors shadow-sm"
          >
            {downloading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            下载选中 ({selected.size})
          </button>
        </div>
      </div>
    </div>
  );
}
