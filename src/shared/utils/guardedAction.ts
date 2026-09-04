/**
 * 守卫动作状态机（E4 基础件，与 React 解耦便于单测）：
 * - 进行中禁用：上一次调用未结束时再次触发直接忽略（并发归一）；
 * - 300ms 防抖：两次触发间隔过近时忽略后者，吸收「狂点」产生的重复事件。
 * run 返回 false 表示本次触发被守卫拦截，未执行业务动作。
 *
 * 注意：action 内部应自行处理错误（toast 等）；守卫只负责并发与频次控制，
 * 并对未捕获的 Promise 拒绝做静默兜底，避免 unhandled rejection。
 */
export interface GuardedActionInstance<Args extends unknown[]> {
  run: (...args: Args) => boolean;
  getPending: () => boolean;
  /** 重置守卫状态 */
  reset: () => void;
}

export function createGuardedAction<Args extends unknown[]>(
  action: (...args: Args) => unknown,
  debounceMs = 300,
): GuardedActionInstance<Args> {
  let pending = false;
  let lastStartedAt = 0;

  const finish = () => {
    pending = false;
  };

  const isPromise = (v: unknown): v is Promise<unknown> =>
    !!v && typeof (v as Promise<unknown>).then === 'function';

  return {
    run(...args: Args): boolean {
      if (pending) return false; // 进行中禁用
      const now = Date.now();
      if (now - lastStartedAt < debounceMs) return false; // 300ms 防抖
      lastStartedAt = now;
      pending = true;
      try {
        const result = action(...args);
        if (isPromise(result)) {
          void result.finally(finish).catch(() => {
            /* 动作内部自行处理错误，此处仅防 unhandled rejection */
          });
        } else {
          finish();
        }
        return true;
      } catch (err) {
        finish();
        throw err;
      }
    },
    getPending: () => pending,
    reset: () => {
      pending = false;
      lastStartedAt = 0;
    },
  };
}
