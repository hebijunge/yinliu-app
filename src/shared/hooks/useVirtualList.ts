import { useRef, useMemo, useCallback, useEffect, useState } from 'react';
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';

/**
 * useVirtualList —— 长列表虚拟化统一封装（P0/P3 基础件，P1 深化）
 *
 * 基于 @tanstack/react-virtual：包小、无滚动锚定问题。
 * 统一供 歌单详情/播放历史/本地音乐 等长列表替换全量渲染。
 *
 * P1 深化（本批次）：
 * 1. 滚动方向预判 + 动态缓冲区：监听 virtualizer onChange，按滚动速度分层
 *    放大 overscan（静止 6 → 快滚 12 → 极速 18），让快速滚动方向的未渲染区
 *    提前挂载，减少触边白屏；滚动停止后自动回落，避免常驻多渲染。
 * 2. 极端长列表（>500 行）分片渲染：virtualizer 的 count 从首个 500 行分片
 *    起步，剩余行经 requestIdleCallback 逐片补齐，避免一次挂载超大列表的
 *    长任务阻塞首帧；列表增长（加歌）时不回退已揭示的分片数。
 *
 * 用法：
 *   const listRef = useRef<HTMLDivElement>(null);
 *   const vl = useVirtualList({ count: songs.length, estimateSize: 64 });
 *   <div ref={listRef} className="overflow-y-auto" style={{ height: viewportHeight }}>
 *     <div style={{ height: vl.totalSize, position: 'relative' }}>
 *       {vl.getVirtualItems().map((vi) => (
 *         <div key={key} ref={vl.measureElement} style={{ position:'absolute', top:0, transform:`translateY(${vi.start}px)` }}>
 *           {renderItem(items[vi.index], vi.index)}
 *         </div>
 *       ))}
 *     </div>
 *   </div>
 *
 * 关键约束：行内容应保持固定高度（estimateSize 与实际一致），以保证
 * 滚动流畅与 500+ 行 55fps 的验收目标；不要在行内做动态高度布局。
 */

export interface UseVirtualListOptions {
  /** 列表总行数 */
  count: number;
  /** 预估行高（px）；配合 measureElement 自动校正 */
  estimateSize: number;
  /** 静止状态的基础 overscan（滚动时会按速度分层放大） */
  overscan?: number;
}

export interface VirtualListController {
  /** 挂到滚动视口元素上 */
  containerRef: (node: HTMLDivElement | null) => void;
  /** 当前应渲染的虚拟行 */
  getVirtualItems: () => Array<{ index: number; start: number; size: number; key: unknown }>;
  /** 行总高度（占位容器用） */
  totalSize: number;
  /** 挂到每行根元素上（动态高度测量；固定高度可不挂） */
  measureElement: (node: HTMLElement | null) => void;
  /** 滚动到指定行 */
  scrollToIndex: (index: number, align?: 'start' | 'center' | 'end') => void;
  /** 当前已揭示（可渲染）的行数：>500 行分片揭示时小于 count */
  renderedCount: number;
  /** 内部 virtualizer 实例（特殊场景直用） */
  instance: Virtualizer<HTMLDivElement, HTMLElement>;
}

/** 极端长列表分片阈值：超过该行数按分片逐步揭示 */
const CHUNK_SIZE = 500;

/** 滚动速度分层阈值（px/ms）：>1.2 快滚、>3 极速 */
const VELOCITY_FAST = 1.2;
const VELOCITY_VERY_FAST = 3;

export function useVirtualList(options: UseVirtualListOptions): VirtualListController {
  const { count, estimateSize, overscan: baseOverscan = 6 } = options;

  const containerElRef = useRef<HTMLDivElement | null>(null);

  // === 动态缓冲区：速度感知的 overscan 分层 ===
  const [overscanTier, setOverscanTier] = useState(0);
  const tierRef = useRef(0);
  const lastOffsetRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const velocityRef = useRef(0);

  // === 分片揭示（>500 行）===
  const [revealedCount, setRevealedCount] = useState(() => Math.min(count, CHUNK_SIZE));

  useEffect(() => {
    setRevealedCount((prev) => {
      if (count < prev) return Math.min(count, CHUNK_SIZE); // 列表收缩（过滤/删歌）：收敛到首个分片
      // 列表增长：至少补足首个分片，已揭示部分不回退
      return Math.min(Math.max(prev, CHUNK_SIZE), count);
    });
  }, [count]);

  useEffect(() => {
    if (revealedCount >= count) return;
    let cancelled = false;
    let idleHandle: number | null = null;
    let timerHandle: number | null = null;
    const revealNext = () => {
      if (cancelled) return;
      setRevealedCount((r) => Math.min(r + CHUNK_SIZE, count));
    };
    if (typeof requestIdleCallback === 'function') {
      idleHandle = requestIdleCallback(revealNext, { timeout: 200 }) as unknown as number;
    } else {
      timerHandle = window.setTimeout(revealNext, 32);
    }
    return () => {
      cancelled = true;
      if (idleHandle !== null && typeof cancelIdleCallback === 'function') cancelIdleCallback(idleHandle);
      if (timerHandle !== null) clearTimeout(timerHandle);
    };
  }, [revealedCount, count]);

  const handleVirtualizerChange = useCallback(
    (instance: Virtualizer<HTMLDivElement, HTMLElement>) => {
      // 速度估计：指数平滑，避免单帧抖动误判
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const offset = instance.scrollOffset ?? 0;
      if (lastOffsetRef.current !== null && instance.isScrolling) {
        const dt = now - lastTimeRef.current;
        if (dt > 0) {
          const inst = Math.abs(offset - lastOffsetRef.current) / dt;
          velocityRef.current = velocityRef.current * 0.6 + inst * 0.4;
          const nextTier =
            velocityRef.current > VELOCITY_VERY_FAST ? 2 : velocityRef.current > VELOCITY_FAST ? 1 : 0;
          if (nextTier !== tierRef.current) {
            tierRef.current = nextTier;
            setOverscanTier(nextTier);
          }
        }
      }
      if (!instance.isScrolling && tierRef.current !== 0) {
        // 滚动停止（isScrollingResetDelay 后）：回落基础缓冲
        tierRef.current = 0;
        velocityRef.current = 0;
        setOverscanTier(0);
      }
      lastOffsetRef.current = offset;
      lastTimeRef.current = now;
    },
    []
  );

  const overscan = [baseOverscan, baseOverscan * 2, baseOverscan * 3][overscanTier];

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
    count: revealedCount,
    getScrollElement: () => containerElRef.current,
    estimateSize: () => estimateSize,
    overscan,
    onChange: handleVirtualizerChange,
  });

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    containerElRef.current = node;
  }, []);

  return useMemo(
    () => ({
      containerRef,
      getVirtualItems: () =>
        virtualizer.getVirtualItems().map((vi) => ({
          index: vi.index,
          start: vi.start,
          size: vi.size,
          key: vi.key,
        })),
      totalSize: virtualizer.getTotalSize(),
      measureElement: (node: HTMLElement | null) => {
        if (node) virtualizer.measureElement(node);
      },
      scrollToIndex: (index, align = 'start') => {
        // 分片揭示未完成时夹到已揭示范围，避免滚动越界
        virtualizer.scrollToIndex(Math.min(index, revealedCount - 1), { align });
      },
      renderedCount: revealedCount,
      instance: virtualizer,
    }),
    [virtualizer, containerRef, revealedCount]
  );
}
