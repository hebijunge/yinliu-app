import { useCallback, useRef, useState } from 'react';

/**
 * E4 快速狂点守卫：进行中禁用 + 300ms 防抖。
 *
 * - 动作执行期间（busy=true）重复调用直接忽略，不产生并发执行；
 * - 动作完成（成功或失败）后 300ms 内的再次调用同样忽略，
 *   吸收连点的"尾巴"点击，避免状态刚复位又被误触。
 *
 * 应用入口：播放（引擎层另有同 track 请求合并）、下载、导入、清空。
 */
export function useGuardedAction<Args extends unknown[]>(
  action: (...args: Args) => Promise<unknown> | unknown,
  debounceMs = 300
) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const lastSettledAt = useRef(0);
  const actionRef = useRef(action);
  actionRef.current = action;

  const run = useCallback(
    async (...args: Args) => {
      // ① 进行中守卫：上一次动作未结束，忽略本次点击
      if (busyRef.current) return;
      // ② 完成后防抖窗口：刚结束 300ms 内的连点忽略
      if (Date.now() - lastSettledAt.current < debounceMs) return;

      busyRef.current = true;
      setBusy(true);
      try {
        await actionRef.current(...args);
      } finally {
        busyRef.current = false;
        lastSettledAt.current = Date.now();
        setBusy(false);
      }
    },
    [debounceMs]
  );

  return { run, busy };
}
