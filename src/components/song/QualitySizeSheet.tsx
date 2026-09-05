import { useState, useEffect, useMemo, useCallback } from 'react';
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
import { PLATFORM_DISPLAY_NAMES } from '../../core/platformPriority';
import { qualityOptionsCache, runWithConcurrency } from '../../shared/utils/qualityOptionsCache';
import type { OptionBlock } from './QualitySizeSheetTypes';

/**
 * 下载音质弹窗（v24 重做）
 *
 * 性能（修复用户反馈「卡的要死」）：
 * 1. 实时探测结果接入 qualityOptionsCache——TTL 内二次打开零请求直接命中，
 *    不再每次打开都对全部源并发 15~25 个请求（Android 端走 CapacitorHttp 原生桥，洪峰会挤卡 JS 线程）；
 * 2. 未命中缓存的源走固定并发池（3 路）探测，削平瞬时洪峰；
 * 3. 批量下载改并行建任务（并发 4），不再逐个 await 数据库写导致按钮长时间假死。
 *
 * UI（修复「难看」）：
 * - 真底部抽屉：拖拽把手 + 遮罩淡入 + 面板滑入动画（复用 panel-slide-up）+ 安全区适配；
 * - 档位区块改为「徽章 + 平台行」两级结构，去掉霓虹色文字，选中态用主题色统一表达；
 * - 底部操作栏常驻：全选 + 主按钮（带选中计数与 loading 态）。
 */

interface QualitySizeSheetProps {
  song: AggregatedSearchResult | null;
  open: boolean;
  onClose: () => void;
  onPlay?: (song: AggregatedSearchResult) => void;
}

/** 档位徽章：低饱和底色 + 深色文字，替代旧版霓虹色标题 */
const TIER_BADGE: Record<QualityTier, string> = {
  master: 'bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400',
  dolby: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  zhizhen: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  hires: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  lossless: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
  '320k': 'bg-red-500/10 text-red-600 dark:text-red-400',
  '192k': 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
  '128k': 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
};

/** 档位左侧竖条颜色（与徽章同色系，仅作分组视觉锚点） */
const TIER_BAR: Record<QualityTier, string> = {
  master: 'bg-fuchsia-500',
  dolby: 'bg-violet-500',
  zhizhen: 'bg-emerald-500',
  hires: 'bg-amber-500',
  lossless: 'bg-yellow-500',
  '320k': 'bg-red-500',
  '192k': 'bg-purple-500',
  '128k': 'bg-blue-500',
};

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)}GB`;
  if (mb >= 1) return `${mb.toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** 骨架屏：与新布局一致的档位徽章 + 平台行占位 */
function QualitySizeSheetSkeleton() {
  return (
    <div className="px-4 py-4 space-y-5" aria-hidden>
      {QUALITY_TIER_ORDER.slice(0, 4).map((tier) => (
        <div key={tier}>
          <div className="flex items-center gap-2 mb-2">
            <div className={`w-1 h-4 rounded-full ${TIER_BAR[tier]} opacity-30`} />
            <div className="h-5 w-20 rounded-md bg-[var(--bg-tertiary)] skeleton-shimmer" />
          </div>
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

  /** 从单个源的单次探测结果构建去重后的档位块 */
  const buildBlocksFromOptions = useCallback(
    (sourceId: string, sourceName: string, options: QualityOption[]): OptionBlock[] => {
      const seen = new Set<QualityTier>();
      const out: OptionBlock[] = [];
      for (const opt of options) {
        if (seen.has(opt.tier)) continue;
        seen.add(opt.tier);
        out.push({
          key: `${sourceId}:${opt.tier}`,
          sourceId,
          sourceName,
          tier: opt.tier,
          sizeBytes: opt.sizeBytes,
        });
      }
      return out;
    },
    []
  );

  // 打开时构建选项：快照 → 缓存命中即时替换 → 仅未命中的源走并发池探测
  useEffect(() => {
    if (!open || !song) return;

    setSelected(new Set());

    const initial: OptionBlock[] = [];
    for (const s of song.sources) {
      const name = PLATFORM_DISPLAY_NAMES[s.sourceId] || s.sourceName;
      const cached = qualityOptionsCache.get(s.sourceId, s.sourceSongId);
      if (cached) {
        initial.push(...cached);
        continue;
      }
      const fromSizes: OptionBlock[] = [];
      const seen = new Set<QualityTier>();
      for (const tier of QUALITY_TIER_ORDER) {
        const size = s.sizes?.[tier];
        if (size && !seen.has(tier)) {
          seen.add(tier);
          fromSizes.push({ key: `${s.sourceId}:${tier}`, sourceId: s.sourceId, sourceName: name, tier, sizeBytes: size });
        }
      }
      if (fromSizes.length > 0) {
        initial.push(...fromSizes);
      } else {
        // 快照兜底：无任何大小信息 → 按该源最高音质归一个无大小块（实时结果返回后整块替换）
        const tier = qualityToTier(s.maxQuality) || '128k';
        initial.push({ key: `${s.sourceId}:${tier}`, sourceId: s.sourceId, sourceName: name, tier });
      }
    }
    setBlocks(initial);

    // 仅对缓存未命中的源探测，且跨源走并发池削峰
    let cancelled = false;
    const sourcesToProbe = song.sources.filter(
      (s) => qualityOptionsCache.get(s.sourceId, s.sourceSongId) === null
    );
    if (sourcesToProbe.length === 0) return;

    setLoading(true);
    (async () => {
      const fetchedBySource = new Map<string, OptionBlock[]>();
      await runWithConcurrency(
        sourcesToProbe.map((s) => async () => {
          const source = sourceRegistry.get(s.sourceId);
          if (!source || typeof source.getQualityOptions !== 'function') return;
          try {
            const options: QualityOption[] = await source.getQualityOptions(s.sourceSongId);
            if (!options || options.length === 0) return;
            const name = PLATFORM_DISPLAY_NAMES[s.sourceId] || s.sourceName;
            const probed = buildBlocksFromOptions(s.sourceId, name, options);
            if (probed.length > 0) {
              fetchedBySource.set(s.sourceId, probed);
              qualityOptionsCache.set(s.sourceId, s.sourceSongId, probed);
            }
          } catch {
            // 静默失败：该源保留快照数据
          }
        }),
        3
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
  }, [open, song, buildBlocksFromOptions]);

  // 按音质分组（高→低）
  const grouped = useMemo(() => {
    const groups: { tier: QualityTier; items: OptionBlock[] }[] = [];
    for (const tier of QUALITY_TIER_ORDER) {
      const items = blocks.filter((b) => b.tier === tier);
      if (items.length > 0) groups.push({ tier, items });
    }
    return groups;
  }, [blocks]);

  const blocksByKey = useMemo(() => {
    const map = new Map<string, OptionBlock>();
    for (const b of blocks) map.set(b.key, b);
    return map;
  }, [blocks]);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const allSelected = blocks.length > 0 && selected.size === blocks.length;
  const handleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(blocks.map((b) => b.key)));
  };

  const handleDownload = async () => {
    if (!song || selected.size === 0 || downloading) return;
    setDownloading(true);
    let queued = 0;
    let failed = 0;

    // v24 性能修复：并行建任务（并发 4）——旧实现逐个 await createTask（含数据库写），
    // 全选十几个档位时按钮会假死数秒；建好后再统一起跑下载。
    const selectedBlocks = Array.from(selected)
      .map((key) => blocksByKey.get(key))
      .filter((b): b is OptionBlock => !!b);
    const CREATE_CONCURRENCY = 4;
    let cursor = 0;
    const createdTaskIds: string[] = [];
    const workers = Array.from({ length: Math.min(CREATE_CONCURRENCY, selectedBlocks.length) }, async () => {
      while (cursor < selectedBlocks.length) {
        const block = selectedBlocks[cursor++];
        const source = song.sources.find((s) => s.sourceId === block.sourceId);
        if (!source) continue;
        try {
          const task = await downloadEngine.createTask({
            songId: source.sourceSongId,
            sourceId: source.sourceId,
            quality: tierToQuality(block.tier),
            title: song.title,
            artist: song.artist,
            durationSec: song.duration || undefined,
            availableSources: [
              { sourceId: source.sourceId, sourceSongId: source.sourceSongId },
            ],
          });
          createdTaskIds.push(task.id);
          queued++;
        } catch {
          failed++;
        }
      }
    });
    await Promise.all(workers);
    for (const id of createdTaskIds) downloadEngine.startDownload(id);

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
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sheet-backdrop-fade"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="下载音质"
    >
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/50" />

      {/* 底部抽屉 */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-lg bg-[var(--bg-primary)] rounded-t-3xl shadow-2xl max-h-[85vh] flex flex-col panel-slide-up"
      >
        {/* 顶部拖拽把手 */}
        <div className="pt-2.5 pb-1 flex justify-center flex-shrink-0">
          <span className="w-10 h-1 rounded-full bg-[var(--border)]" aria-hidden />
        </div>

        {/* 头部：歌曲信息 + ▶ + × */}
        <div className="flex items-center gap-3 px-5 pb-3 pt-1 border-b border-[var(--border-subtle)] flex-shrink-0">
          <div className="w-10 h-10 rounded-xl bg-[var(--accent-soft)] flex items-center justify-center flex-shrink-0">
            <Music className="w-5 h-5 text-[var(--accent)]" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-base font-semibold text-[var(--text-primary)] truncate">
              {song.title}
            </div>
            <div className="text-xs text-[var(--text-tertiary)] truncate">
              {song.artist}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {onPlay && (
              <button
                onClick={() => onPlay?.(song)}
                className="p-2 rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--accent)] transition-colors"
                title="播放"
                aria-label="播放"
              >
                <Play className="w-5 h-5" />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] transition-colors"
              title="关闭"
              aria-label="关闭"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* 分组列表：档位徽章 + 平台逐行 */}
        <div className="flex-1 overflow-y-auto overscroll-contain">
          {loading && grouped.length === 0 ? (
            <QualitySizeSheetSkeleton />
          ) : grouped.length === 0 ? (
            <div className="text-center py-12">
              <Music className="w-8 h-8 text-[var(--text-tertiary)] opacity-40 mx-auto mb-2" />
              <div className="text-sm text-[var(--text-tertiary)]">暂无可用的音质信息</div>
            </div>
          ) : (
            <div className="px-4 py-4 space-y-5">
              {loading && (
                <div className="flex items-center gap-2 px-1 text-xs text-[var(--text-tertiary)]">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  正在获取实时文件大小…
                </div>
              )}
              {grouped.map(({ tier, items }) => (
                <div key={tier}>
                  {/* 档位徽章行 */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`w-1 h-4 rounded-full ${TIER_BAR[tier]}`} aria-hidden />
                    <span
                      className={`text-xs font-semibold px-2 py-0.5 rounded-full ${TIER_BADGE[tier]}`}
                    >
                      {QUALITY_TIER_LABELS[tier]}
                    </span>
                    <span className="text-xs text-[var(--text-tertiary)]">{items.length} 个来源</span>
                  </div>
                  {/* 平台列表：逐行选择 */}
                  <div className="space-y-1.5">
                    {items.map((b) => {
                      const isSel = selected.has(b.key);
                      const displayName = PLATFORM_DISPLAY_NAMES[b.sourceId] || b.sourceName;
                      return (
                        <button
                          key={b.key}
                          onClick={() => toggle(b.key)}
                          aria-pressed={isSel}
                          className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-left transition-colors active:scale-[0.99] ${
                            isSel
                              ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]'
                              : 'bg-[var(--bg-secondary)] ring-1 ring-transparent hover:bg-[var(--bg-tertiary)]'
                          }`}
                        >
                          {/* 选择指示器：方框勾选，选中态主题色 */}
                          <span
                            className={`w-[18px] h-[18px] rounded-md flex items-center justify-center flex-shrink-0 transition-colors ${
                              isSel
                                ? 'bg-[var(--accent)]'
                                : 'border-[1.5px] border-[var(--border)]'
                            }`}
                          >
                            {isSel && <Check className="w-3.5 h-3.5 text-white" />}
                          </span>
                          <span className="flex-1 text-sm truncate text-[var(--text-primary)]">
                            {displayName}
                          </span>
                          <span className="text-xs tabular-nums text-[var(--text-tertiary)] flex-shrink-0">
                            {formatSize(b.sizeBytes) || '—'}
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

        {/* 底部操作区：全选 + 下载选中（常驻 + 安全区适配） */}
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-[var(--border-subtle)] bg-[var(--bg-primary)] safe-area-bottom flex-shrink-0">
          <button
            onClick={handleSelectAll}
            disabled={blocks.length === 0}
            className="flex items-center gap-2 px-3 py-2 rounded-full text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40 transition-colors"
          >
            <span
              className={`w-[18px] h-[18px] rounded flex items-center justify-center transition-colors ${
                allSelected
                  ? 'bg-[var(--accent)]'
                  : 'border-[1.5px] border-[var(--text-tertiary)]'
              }`}
            >
              {allSelected && <Check className="w-3 h-3 text-white" />}
            </span>
            {allSelected ? '取消全选' : '全选'}
          </button>
          <button
            onClick={handleDownload}
            disabled={selected.size === 0 || downloading}
            className="flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-medium text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 transition-colors shadow-sm play-btn-transition"
          >
            {downloading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            下载{selected.size > 0 ? ` (${selected.size})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
