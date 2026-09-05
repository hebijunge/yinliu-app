/**
 * C1 配套：请求级取消信号工具。
 *
 * 背景：platformFetch 内部已实现「超时=abort」，但部分音源（QQ/汽水/咪咕等）
 * 因 CORS/响应处理需要使用裸 fetch，绕过了该语义，弱网下连接会无限挂起。
 * 本工具把「外部取消信号」与「超时」合并为一个 AbortSignal：
 * - 任一外部信号 abort → 立即 abort；
 * - 超时到点 → 主动 abort，真正终止底层请求（而非仅标记错误）。
 */

/** 合并外部取消信号与超时，返回可直接传给 fetch 的 AbortSignal */
export function createRequestSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const controller = new AbortController();

  if (external) {
    if (external.aborted) {
      controller.abort(external.reason);
      return controller.signal;
    }
    external.addEventListener(
      'abort',
      () => controller.abort(external.reason),
      { once: true }
    );
  }

  if (timeoutMs > 0) {
    const timer = setTimeout(
      () => controller.abort(new DOMException(`Request timeout after ${timeoutMs}ms`, 'TimeoutError')),
      timeoutMs
    );
    // 任一途径触发 abort 后清掉定时器；请求正常完成时定时器自然过期，无副作用
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  }

  return controller.signal;
}
