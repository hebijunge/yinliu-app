import { useState, useEffect, useMemo } from 'react';
import { Play, X, Check, Download, Loader2, Music } from 'lucide-react';
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
  PLATFORM_COLORS,
} from '../../core/platformPriority';

/**
 * 音质弹窗（v19.2，骨架屏 + UI 升级）：
 * 底部抽屉「下载音质（多平台）」：
 * - 头部：▶ 播放按钮 + 标题 + × 关闭
 * - 按 Hi-Res/无损/320K/192K/128K 分组，每组内为「平台名 + 文件大小」的可选块
 * - 底部：全选 + 「下载选中 (n)」
 *
 * 数据来源（v19.1 修正：各源音质/大小必须按源区分）：
 * 1. 首屏快照：聚合结果里各源自带的 sizes（搜索/榜单时已抓到，仅用于立即展示）
 * 2. 打开弹窗时对【全部源】并行调 getQualityOptions 实时取真实档位与大小
 *    （酷我=musicpay MINFO、网易云=v3/song/detail、咪咕=resourceinfo.do、
 *     酷狗=v3/song/info、QQ=resolve-url level取链、汽水=分享页Range探测）
 * 3. 实时结果按源整块替换快照；取不到的源保留快照；两者皆无的源不显示（不编造数据）
 */

/** 弹窗内单个可选块 */
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

/** 分组色（参考图：Hi-Res/无损 黄、320K 红、192K 紫、128K 蓝） */
const TIER_COLORS: Record<QualityTier, string> = {
  hires: 'bg-amber-500',
  lossless: 'bg-yellow-500',
  '320k': 'bg-red-500',
  '192k': 'bg-purple-500',
  '128k': 'bg-blue-500',
};

/** 平台图标背景色（浅色底） */
const PLATFORM_ICON_BG: Record<string, string> = {
  kuwo: 'bg-blue-100 text-blue-600',
  migu: 'bg-amber-100 text-amber-700',
  netease: 'bg-red-100 text-red-600',
  kugou: 'bg-cyan-100 text-cyan-600',
  qq: 'bg-green-100 text-green-600',
  qishui: 'bg-purple-100 text-purple-600',
};

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)}GB`;
  if (mb >= 1) return `${mb.toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** 骨架屏：与真实布局一致的分组 + 卡片占位 */
function QualitySizeSheetSkeleton() {
  return (
    <div className="px-4 py-3 space-y-4">
      {QUALITY_TIER_ORDER.map((tier) => (
        <div key={tier}>
          <div className="flex items-center gap-2 mb-2">
            <div className={`w-2.5 h-2.5 rounded-sm ${TIER_COLORS[tier]} opacity-30`} />
            <div className="h-3.5 w-14 rounded-md bg-[var(--bg-tertiary)] skeleton-shimmer" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {[0, 1].map((i) => (
              <div
                key={`${tier}-${i}`}
                className="flex flex-col gap-1.5 px-3 py-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]"
              >
                <div className="flex items-center gap-1.5">
                  <div className="w-5 h-5 rounded-md bg-[var(--bg-tertiary)] skeleton-shimmer" />
                  <div className="h-4 w-16 rounded-md bg-[var(--bg-tertiary)] skeleton-shimmer" />
                </div>
                <div className="h-3 w-10 rounded-md bg-[var(--bg-tertiary)] skeleton-shimmer opacity-50" />
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

    // v19.1：对全部源实时取真实音质/大小（并行、best-effort），成功则按源整块替换快照
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
        {/* 头部：▶ 标题 × */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
          <button
            onClick={() => onPlay?.(song)}
            className="p-1.5 rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="播放"
            aria-label="播放"
          >
            <Play className="w-4 h-4" />
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-[var(--text-primary)] truncate">下载音质（多平台）</div>
            <div className="text-xs text-[var(--text-tertiary)] truncate">
              {song.title} {song.artist && `· ${song.artist}`}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="关闭"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 分组列表 */}
        <div className="flex-1 overflow-y-auto">
          {loading && grouped.length === 0 ? (
            <QualitySizeSheetSkeleton />
          ) : grouped.length === 0 ? (
            <div className="text-center py-8 text-sm text-[var(--text-tertiary)]">
              暂无可用的音质信息
            </div>
          ) : (
            <div className="px-4 py-3 space-y-4">
              {grouped.map(({ tier, items }) => (
                <div key={tier}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`w-2.5 h-2.5 rounded-sm ${TIER_COLORS[tier]}`} />
                    <span className="text-xs font-medium text-[var(--text-secondary)]">
                      {QUALITY_TIER_LABELS[tier]}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {items.map((b) => {
                      const isSel = selected.has(b.key);
                      const iconStyle = PLATFORM_ICON_BG[b.sourceId] || 'bg-gray-100 text-gray-500';
                      const displayName = PLATFORM_DISPLAY_NAMES[b.sourceId] || b.sourceName;
                      const firstChar = displayName.charAt(0);
                      return (
                        <button
                          key={b.key}
                          onClick={() => toggle(b.key)}
                          className={`relative flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-xl border text-left transition-all active:scale-[0.98] ${
                            isSel
                              ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-sm'
                              : 'border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)]'
                          }`}
                        >
                          {isSel && (
                            <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-[var(--accent)] flex items-center justify-center shadow-sm">
                              <Check className="w-3 h-3 text-white" />
                            </span>
                          )}
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`inline-flex items-center justify-center w-5 h-5 rounded-md text-[10px] font-bold flex-shrink-0 ${iconStyle}`}
                            >
                              {firstChar}
                            </span>
                            <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                              {displayName}
                            </span>
                          </div>
                          <span className="text-[10px] text-[var(--text-tertiary)] pl-7">
                            {formatSize(b.sizeBytes) || QUALITY_TIER_LABELS[b.tier]}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底部：全选 + 下载选中 */}
        <div className="flex items-center gap-3 px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-primary)]">
          <button
            onClick={handleSelectAll}
            disabled={blocks.length === 0}
            className="px-4 py-2 rounded-full text-sm font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-40 transition-colors"
          >
            {selected.size === blocks.length && blocks.length > 0 ? '取消全选' : '全选'}
          </button>
          <button
            onClick={handleDownload}
            disabled={selected.size === 0 || downloading}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-full text-sm font-medium text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 transition-colors shadow-sm"
          >
            {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            下载选中 ({selected.size})
          </button>
        </div>
      </div>
    </div>
  );
}
