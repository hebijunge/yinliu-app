import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

interface UseInfiniteListOptions {
  /** 触底判定距离（px），默认 240 */
  threshold?: number;
  /** 每次触底追加的条数，默认 30 */
  step?: number;
  /**
   * D9 修复：数据集标识（如「关键词+搜索类型」）。
   * 传入时仅在该标识变化时重置可见条数——数据总量变化（如搜索流式
   * onPartial 增量到达）只做上限收敛，不再把用户已加载的分页数打回首页。
   * 不传时保持旧行为：total 变化即重置。
   */
  resetKey?: string | number;
}

/**
 * P12/P3 触底分帧挂载：接近滚动底部时按 step 递增可见条数，
 * 将大量列表项的挂载摊到多次滚动交互中，避免一次性渲染造成的卡顿。
 *
 * 滚动容器：传入 scrollRef 用内部视口滚动；传 null 时监听 window 页面级滚动。
 */
export function useInfiniteList(
  total: number,
  scrollRef: RefObject<HTMLElement | null> | null,
  options: UseInfiniteListOptions = {},
) {
  const { threshold = 240, step = 30, resetKey } = options;
  const [visibleCount, setVisibleCount] = useState(Math.min(step, Math.max(total, 0)));
  const tickingRef = useRef(false);
  // 用 ref 镜像最新值，避免 resetKey 分支里把 visibleCount 列进依赖造成额外重跑
  const visibleRef = useRef(visibleCount);
  visibleRef.current = visibleCount;
  const prevResetKeyRef = useRef<string | number | undefined>(resetKey);

  // resetKey 传入：仅标识变化（新数据集）时重置；同数据集内 total 增长只收敛上限
  // resetKey 未传：保持旧行为，total 变化即重置
  useEffect(() => {
    if (resetKey !== undefined) {
      if (prevResetKeyRef.current !== resetKey) {
        prevResetKeyRef.current = resetKey;
        setVisibleCount(Math.min(step, Math.max(total, 0)));
      } else if (visibleRef.current > total) {
        setVisibleCount(Math.max(total, 0));
      }
    } else {
      setVisibleCount(Math.min(step, Math.max(total, 0)));
    }
  }, [resetKey, total, step]);

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
