/**
 * idle 调度工具：优先 requestIdleCallback，环境不支持时回退 setTimeout。
 * P1 冷启动（非关键数据延后恢复）/ P11（路由 chunk 预取）共用。
 */
export function scheduleIdle(cb: () => void, timeout = 1500): void {
  if (typeof window === 'undefined') return;
  const ric = (
    window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }
  ).requestIdleCallback;
  if (ric) {
    ric(() => cb(), { timeout });
  } else {
    window.setTimeout(cb, 0);
  }
}
