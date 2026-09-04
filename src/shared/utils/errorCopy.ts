/**
 * 统一错误文案库（E2）
 * 把底层网络/HTTP 错误翻译为用户可读文案，避免英文原始错误泄漏到 UI。
 */

const HTTP_COPY: Record<number, string> = {
  400: '请求参数有误，请稍后重试',
  401: '登录状态已失效，请重新进入页面',
  403: '暂时没有访问权限，请稍后重试',
  404: '内容不存在或已下架',
  429: '请求太频繁，请稍等片刻再试',
  500: '服务开小差了，请稍后重试',
  502: '服务暂时不可用，请稍后重试',
  503: '服务繁忙，请稍后重试',
  504: '服务响应超时，请稍后重试',
};

/** 从 Response 状态码取用户文案 */
export function httpStatusCopy(status: number): string {
  return HTTP_COPY[status] || `请求失败（${status}），请稍后重试`;
}

/**
 * 把异常翻译为用户可读文案。
 * - 识别不出的 Error 一律回退到 fallback，不再透出原始 message。
 */
export function toUserMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = Number((err as { status?: unknown }).status);
    if (Number.isFinite(status) && status >= 400) return httpStatusCopy(status);
  }
  if (err instanceof DOMException || err instanceof Error) {
    const name = err.name;
    const msg = err.message || '';
    if (name === 'TimeoutError' || /timeout|timed out/i.test(msg)) {
      return '网络请求超时，请检查网络后重试';
    }
    if (name === 'AbortError' || /abort/i.test(msg)) {
      return '请求已取消';
    }
    if (/Failed to fetch|NetworkError|network|ERR_INTERNET|ECONN|GnuTLS|SSL/i.test(msg)) {
      return typeof navigator !== 'undefined' && navigator.onLine === false
        ? '当前无网络连接，请联网后重试'
        : '网络连接失败，请稍后重试';
    }
    if (/JSON/i.test(name) || /invalid json|unexpected token/i.test(msg)) {
      return '返回数据异常，请稍后重试';
    }
  }
  return fallback;
}
