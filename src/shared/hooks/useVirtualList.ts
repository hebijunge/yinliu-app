import { useRef, useMemo, useCallback } from 'react';
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';

/**
 * useVirtualList —— 长列表虚拟化统一封装（P0/P3 基础件）
 *
 * 基于 @tanstack/react-virtual：包小、无滚动锚定问题。
 * 统一供 歌单详情/播放历史/本地音乐 等长列表替换全量渲染。
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
  /** 视口上下额外渲染行数 */
  overscan?: number;
  /** 视口是否随内容自适应（false=由外部给定高度） */
  enabled?: boolean;
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
  /** 内部 virtualizer 实例（特殊场景直用） */
  instance: Virtualizer<HTMLDivElement, HTMLElement>;
}

export function useVirtualList(options: UseVirtualListOptions): VirtualListController {
  const { count, estimateSize, overscan = 6 } = options;

  const containerElRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
    count,
    getScrollElement: () => containerElRef.current,
    estimateSize: () => estimateSize,
    overscan,
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
        virtualizer.scrollToIndex(index, { align });
      },
      instance: virtualizer,
    }),
    [virtualizer, containerRef]
  );
}
