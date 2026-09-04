import { useCallback, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/**
 * P3 长列表虚拟化：@tanstack/react-virtual 的轻封装。
 * 页面提供固定行高的内部滚动视口（h-full overflow-y-auto），
 * 由本 hook 返回虚拟行与视口 ref，避免长列表全量渲染造成卡顿。
 */
export function useVirtualList<T>(
  items: T[],
  rowHeight: number,
  overscan = 6,
) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  const virtualItems = virtualizer.getVirtualItems();
  // D9 修复：行高固定（estimateSize 恒为 rowHeight），总高 = count × rowHeight。
  // 旧实现渲染期读 virtualizer.getTotalSize()，items 异步加载/替换后的首帧
  // 会拿到内部缓存的陈旧总高，容器高度闪烁/截断。
  const totalSize = items.length * rowHeight;

  /** 供行容器定位使用的公共样式：绝对定位 + 固定行高 */
  const rowStyle = useCallback(
    (virtualRow: { index: number; start: number }): React.CSSProperties => ({
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: rowHeight,
      transform: `translateY(${virtualRow.start}px)`,
    }),
    [rowHeight],
  );

  return { scrollRef, virtualItems, totalSize, rowStyle, virtualizer };
}
