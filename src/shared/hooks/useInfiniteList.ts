import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

interface UseInfiniteListOptions {
  /** 触底判定距离（px），默认 240 */
  threshold?: number;
  /** 每次触底追加的条数，默认 30 */
  step?: number;
}

/**
 * P12/P3 触底分帧挂载：接近滚动底部时按 step 递增可见条数，
 * 将大量列表项的挂载摊到多次滚动交互中，避免一次性渲染造成的卡顿。
 * 数据源变化（total 变化）时自动重置可见条数。
 *
 * 滚动容器：传入 scrollRef 用内部视口滚动；传 null 时监听 window 页面级滚动。
 */
export function useInfiniteList(
  total: number,
  scrollRef: RefObject<HTMLElement | null> | null,
  options: UseInfiniteListOptions = {},
) {
  const { threshold = 240, step = 30 } = options;
  const [visibleCount, setVisibleCount] = useState(Math.min(step, Math.max(total, 0)));
  const tickingRef = useRef(false);

  // 数据源变化时重置可见条数
  useEffect(() => {
    setVisibleCount(Math.min(step, Math.max(total, 0)));
  }, [total, step]);

  useEffect(() => {
    const el = scrollRef ? scrollRef.current : null;
    // 窗口滚动模式（scrollRef 为 null）
    const useWindow = !scrollRef;
    const target: HTMLElement | Window | null = useWindow ? window : el;
    if (!target) return;

    const isNearBottom = () => {
      if (useWindow) {
        const doc = document.documentElement;
        return window.scrollY + window.innerHeight >= doc.scrollHeight - threshold;
      }
      const box = el as HTMLElement;
      return box.scrollTop + box.clientHeight >= box.scrollHeight - threshold;
    };

    const onScroll = () => {
      if (tickingRef.current) return;
      tickingRef.current = true;
      // rAF 分帧：滚动事件高频触发，每帧只处理一次
      requestAnimationFrame(() => {
        tickingRef.current = false;
        if (isNearBottom()) {
          setVisibleCount((c) => Math.min(c + step, total));
        }
      });
    };

    target.addEventListener('scroll', onScroll, { passive: true } as AddEventListenerOptions);
    return () => target.removeEventListener('scroll', onScroll);
  }, [scrollRef, threshold, step, total]);

  return { visibleCount };
}
