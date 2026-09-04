import { useCallback, useEffect, useRef, useState } from 'react';
import { createGuardedAction } from '../utils/guardedAction';

type AnyAction<Args extends unknown[]> = (...args: Args) => unknown;

export interface GuardedActionResult<Args extends unknown[]> {
  /** 守卫后的动作：进行中/防抖窗口内触发会被静默忽略 */
  run: (...args: Args) => void;
  /** 是否有动作正在进行（可用于禁用按钮/显示 loading） */
  pending: boolean;
}

/**
 * useGuardedAction（E4 基础件）：
 * 给「播放 / 下载 / 导入 / 清空」等不可重入入口统一加
 * 「进行中禁用 + 300ms 防抖」，狂点不产生并发执行与状态错乱。
 *
 * action 经 ref 透传，run 引用稳定，可安全挂到事件回调和 useEffect 依赖。
 */
export function useGuardedAction<Args extends unknown[]>(
  action: AnyAction<Args>,
  debounceMs = 300,
): GuardedActionResult<Args> {
  const actionRef = useRef(action);
  useEffect(() => {
    actionRef.current = action;
  });

  const guardRef = useRef<ReturnType<typeof createGuardedAction<Args>> | null>(null);
  if (!guardRef.current) {
    guardRef.current = createGuardedAction<Args>((...args: Args) => actionRef.current(...args), debounceMs);
  }

  const [pending, setPending] = useState(false);

  const run = useCallback(
    (...args: Args) => {
      const guard = guardRef.current!;
      const accepted = guard.run(...args);
      if (accepted) {
        setPending(true);
        // 归还 pending：动作结束（含失败）后由守卫状态机置回，轮询对齐即可
        const check = () => {
          if (guard.getPending()) {
            window.setTimeout(check, 50);
          } else {
            setPending(false);
          }
        };
        window.setTimeout(check, 0);
      }
    },
    [debounceMs],
  );

  return { run, pending };
}
