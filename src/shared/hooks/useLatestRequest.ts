/**
 * v22 D4: 请求竞态守卫 hook —— seq 递增，仅接受最后一次发起请求的结果。
 * 用于分类切换 / 展开详情等「请求在途时用户又改变条件」的场景，
 * 防止慢的旧响应覆盖新的状态（展开竞态 / 分类切换竞态）。
 */
import { useRef, useCallback } from 'react';

export function useLatestRequest() {
  const seqRef = useRef(0);

  /** 包裹一次异步请求：返回的 isLatest 判断本次请求是否仍是最新 */
  const beginRequest = useCallback((): { isLatest: () => boolean } => {
    const seq = ++seqRef.current;
    return { isLatest: () => seq === seqRef.current };
  }, []);

  return { beginRequest };
}
