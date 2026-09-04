/**
 * 空闲调度工具（P1/E1）：
 * 非关键工作（chunk 预取、数据恢复、缓存预热）推迟到首帧之后的浏览器空闲期执行，
 * 不与首屏渲染争抢主线程。requestIdleCallback 不可用时退化为微任务级 setTimeout。
 */
export function scheduleIdle(cb: () => void, timeout = 2000): void {
  if (typeof window === 'undefined') {
    cb();
    return;
  }
  const w = window as Window & {
    requestIdleCallback?: (cb: (deadline: IdleDeadline) => void, opts?: { timeout: number }) => number;
  };
  if (typeof w.requestIdleCallback === 'function') {
    w.requestIdleCallback(() => cb(), { timeout });
  } else {
    window.setTimeout(cb, 50);
  }
}
