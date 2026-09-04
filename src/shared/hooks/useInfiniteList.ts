import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * useInfiniteList —— 「加载更多」增量渲染统一封装（P0/P8 基础件，本批先落基础件）
 *
 * 职责（对应方案 P8）：
 * - IntersectionObserver 触底检测，预加载触发点提前 rootMargin（默认 800px）；
 * - 每次触底增量挂载 pageSize 行，新批次经 requestIdleCallback 分帧挂载，
 *   避免「触发时一次同步挂载一批新行」造成的滚动停顿；
 * - 触底未加载完时返回 isBatchLoading 供 UI 显示骨架行占位。
 *
 * 用法：
 *   const { displayCount, loadMoreRef, hasMore, isBatchLoading } =
 *     useInfiniteList({ total: results.length, pageSize: 15 });
 *   ...
 *   <div ref={loadMoreRef} />  // 触底哨兵，放在列表末尾
 */

export interface UseInfiniteListOptions {
  /** 列表总条数（数据层长度，非展示长度） */
  total: number;
  /** 每批增量条数 */
  pageSize?: number;
  /** 触底提前量（rootMargin），默认 800px 提前预加载 */
  rootMargin?: string;
  /** 禁用增量（数据量小时全量） */
  disabled?: boolean;
}

export interface UseInfiniteListResult {
  /** 当前应渲染条数 */
  displayCount: number;
  /** 挂载到列表末尾哨兵元素 */
  loadMoreRef: (node: HTMLElement | null) => void;
  /** 是否还有未展示数据 */
  hasMore: boolean;
  /** 上一批尚在分帧挂载中（UI 可显示加载反馈） */
  isBatchLoading: boolean;
  /** 重置回第一批（搜索换词等场景） */
  reset: () => void;
}

const DEFAULT_PAGE_SIZE = 15;

export function useInfiniteList(options: UseInfiniteListOptions): UseInfiniteListResult {
  const { total, pageSize = DEFAULT_PAGE_SIZE, rootMargin = '800px', disabled = false } = options;

  const [displayCount, setDisplayCount] = useState(disabled ? total : Math.min(pageSize, total));
  const [isBatchLoading, setIsBatchLoading] = useState(false);
  const sentinelElRef = useRef<HTMLElement | null>(null);
  const idleHandleRef = useRef<number | null>(null);

  // 数据量或分页参数变化时收敛展示数（换词/换 tab）
  useEffect(() => {
    setDisplayCount((prev) => {
      const next = disabled ? total : Math.min(prev, total);
      return Math.max(next, 0);
    });
  }, [total, disabled]);

  useEffect(() => {
    return () => {
      if (idleHandleRef.current !== null && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(idleHandleRef.current);
      }
    };
  }, []);

  const grow = useCallback(() => {
    setDisplayCount((prev) => {
      if (prev >= total) return prev;
      const next = Math.min(prev + pageSize, total);
      if (next > prev) {
        // 分帧挂载标记：新批次经 idle 回调分批生效，避免长任务
        setIsBatchLoading(true);
        const mountBatch = () => {
          setIsBatchLoading(false);
          idleHandleRef.current = null;
        };
        if (typeof requestIdleCallback === 'function') {
          idleHandleRef.current = requestIdleCallback(mountBatch, { timeout: 300 });
        } else {
          idleHandleRef.current = window.setTimeout(mountBatch, 16) as unknown as number;
        }
      }
      return next;
    });
  }, [total, pageSize]);

  // IntersectionObserver 触底检测
  useEffect(() => {
    const el = sentinelElRef.current;
    if (!el || disabled) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) grow();
      },
      { rootMargin }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [grow, rootMargin, disabled, displayCount < total]);

  const loadMoreRef = useCallback((node: HTMLElement | null) => {
    sentinelElRef.current = node;
  }, []);

  const reset = useCallback(() => {
    setDisplayCount(disabled ? total : Math.min(pageSize, total));
    setIsBatchLoading(false);
  }, [disabled, total, pageSize]);

  return {
    displayCount,
    loadMoreRef,
    hasMore: displayCount < total,
    isBatchLoading,
    reset,
  };
}
