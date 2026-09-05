/**
 * 平台感知的 HTTP 请求封装
 * - Capacitor 环境：使用 CapacitorHttp 绕过 WebView CORS 限制
 * - 浏览器/Tauri 环境：回退到标准 fetch
 *
 * C1 修复：超时用 AbortController 统一「超时=取消」语义
 * （旧实现 Promise.race 只 reject 不取消，底层请求继续挂起）
 */

import { Capacitor } from '@capacitor/core';
import { CapacitorHttp, type HttpOptions, type HttpResponse } from '@capacitor/core';
import { debugLogger } from './debugLogger';

export interface PlatformFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | FormData | URLSearchParams;
  signal?: AbortSignal;
  redirect?: 'follow' | 'error' | 'manual';
  /** 响应类型：text（默认）或 arraybuffer（二进制下载） */
  responseType?: 'text' | 'arraybuffer';
  /** 超时时间（毫秒），默认 8s；传 0 表示不超时 */
  timeout?: number;
}

/** 默认超时：8s */
export const DEFAULT_TIMEOUT_MS = 8000;

/**
 * 平台感知的 fetch 封装
 * 在 Capacitor Android/iOS 中自动走原生 HTTP，绕过 CORS
 */
export async function platformFetch(url: string, options: PlatformFetchOptions = {}): Promise<Response> {
  const isCapacitor = Capacitor.isNativePlatform();
  const startTime = performance.now();

  // C1: 未显式传 timeout 默认 8s 超时；传 0 = 不超时
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;

  // C1: 幂等 GET 且无外部取消信号时，网络级失败自动重试 1 次
  const isIdempotentGet = (options.method || 'GET').toUpperCase() === 'GET' && !options.signal;

  try {
    let response: Response;
    if (isIdempotentGet) {
      response = await fetchWithRetry(
        () => executeRequest(url, options, timeoutMs, isCapacitor),
        1,
      );
    } else {
      response = await executeRequest(url, options, timeoutMs, isCapacitor);
    }

    const duration = Math.round(performance.now() - startTime);
    debugLogger.info('network', `请求完成 ${options.method || 'GET'} ${response.status}`, {
      url: truncateUrl(url),
      method: options.method || 'GET',
      status: response.status,
      duration: `${duration}ms`,
      capacitor: isCapacitor,
    });

    return response;
  } catch (err) {
    const duration = Math.round(performance.now() - startTime);
    // F4(v27 P1-1): 竞速落败/外部取消的 AbortError 不算真实失败，降级记 INFO——
    // 胜出短路后其余在途请求被 abort 属预期路径，记 ERROR 会污染失败诊断
    const isAbortError = (err instanceof DOMException && err.name === 'AbortError')
      || (err instanceof Error && err.name === 'AbortError');
    if (isAbortError) {
      debugLogger.info('network', `请求被取消（竞速落败/外部中止） ${options.method || 'GET'}`, {
        url: truncateUrl(url),
        method: options.method || 'GET',
        duration: `${duration}ms`,
        capacitor: isCapacitor,
      });
    } else {
      debugLogger.error('network', `请求失败 ${options.method || 'GET'}`, {
        url: truncateUrl(url),
        method: options.method || 'GET',
        duration: `${duration}ms`,
        error: normalizeErrorMessage(err),
        capacitor: isCapacitor,
      });
    }
    throw err;
  }
}

/** 归一化任意抛出对象的可读 message（CapacitorHttp 原生错误是普通对象而非 Error 实例） */
function normalizeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err instanceof DOMException) return `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const anyErr = err as Record<string, unknown>;
    if (typeof anyErr.message === 'string') return anyErr.message;
    if (typeof anyErr.error === 'string') return anyErr.error;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/**
 * 网络级失败（超时/断连）才重试；4xx/5xx 响应不算失败，不重试。
 * C1: 兼容 CapacitorHttp 抛出的原生错误对象（非 Error 实例，只有 message 字段）。
 */
function isRetryableError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === 'TimeoutError';
  }
  const message = normalizeErrorMessage(err);
  return /Failed to fetch|NetworkError|ECONN|timed out|timeout|SSL|GnuTLS/i.test(message);
}

async function fetchWithRetry(
  doFetch: () => Promise<Response>,
  retries: number,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // 退避 600ms，避免立即重试打到同一故障点
      await new Promise((r) => setTimeout(r, 600));
    }
    try {
      // C1: 每次重试都用同样的超时语义（doFetch 内部已处理）
      return await doFetch();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      lastErr = err;
      if (attempt < retries && isRetryableError(err)) continue;
      throw err;
    }
  }
  throw lastErr;
}

/**
 * C1: 单次请求执行——超时真正取消底层请求。
 * - 浏览器路径：AbortController 同时管理「外部取消」与「超时取消」
 * - Capacitor 路径：超时通过 connectTimeout/readTimeout 交给原生层执行
 */
async function executeRequest(
  url: string,
  options: PlatformFetchOptions,
  timeoutMs: number,
  isCapacitor: boolean,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;

  const externalSignal = options.signal;
  const onExternalAbort = () => {
    externallyAborted = true;
    controller.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  };

  const settleError = (err: unknown): unknown => {
    if (externallyAborted) return new DOMException('Aborted', 'AbortError');
    if (timedOut) {
      return new DOMException(`Request timeout after ${timeoutMs}ms`, 'TimeoutError');
    }
    return err;
  };

  try {
    if (isCapacitor) {
      return await capacitorFetch(url, options, timeoutMs, controller.signal);
    }
    return await browserFetch(url, options, controller.signal);
  } catch (err) {
    throw settleError(err);
  } finally {
    cleanup();
  }
}

function browserFetch(url: string, options: PlatformFetchOptions, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: options.method || 'GET',
    headers: options.headers,
    body: options.body as BodyInit | undefined,
    signal,
    redirect: options.redirect || 'follow',
  });
}

/**
 * CapacitorHttp 适配层：将 CapacitorHttp 的响应包装成标准 Response
 * C1: 超时通过 connectTimeout/readTimeout 交给原生层执行
 */
async function capacitorFetch(
  url: string,
  options: PlatformFetchOptions,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Response> {
  const responseType = options.responseType || 'text';
  const httpOptions: HttpOptions = {
    url,
    method: (options.method || 'GET').toUpperCase() as HttpOptions['method'],
    headers: options.headers,
    data: typeof options.body === 'string' ? options.body : undefined,
    responseType,
    // C1: 原生层超时控制（毫秒）
    connectTimeout: timeoutMs > 0 ? timeoutMs : undefined,
    readTimeout: timeoutMs > 0 ? timeoutMs : undefined,
  };

  let aborted = false;
  const abortHandler = () => { aborted = true; };
  signal.addEventListener('abort', abortHandler);

  try {
    if (aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const resp: HttpResponse = await CapacitorHttp.request(httpOptions);

    if (aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // 构造 Response headers
    const headers = new Headers();
    if (resp.headers) {
      Object.entries(resp.headers).forEach(([k, v]) => {
        if (v !== undefined && v !== null) {
          headers.set(k, String(v));
        }
      });
    }

    // 状态码
    const status = resp.status || 200;
    const statusText = status >= 200 && status < 300 ? 'OK' : 'Error';

    // 构造 Response body
    let body: BodyInit;
    if (responseType === 'arraybuffer') {
      if (resp.data instanceof ArrayBuffer) {
        body = resp.data;
      } else if (typeof resp.data === 'string') {
        // Capacitor bridge 可能以 base64 字符串传递 arraybuffer，尝试解码
        try {
          body = base64ToArrayBuffer(resp.data);
        } catch {
          body = new ArrayBuffer(0);
        }
      } else {
        body = new ArrayBuffer(0);
      }
    } else {
      if (typeof resp.data === 'string') {
        body = resp.data;
      } else if (resp.data) {
        body = JSON.stringify(resp.data);
      } else {
        body = '';
      }
    }

    return new Response(body, { status, statusText, headers });
  } finally {
    signal.removeEventListener('abort', abortHandler);
  }
}

/**
 * 便捷方法：GET JSON
 */
export async function platformGetJson<T = any>(url: string, headers?: Record<string, string>): Promise<T | null> {
  try {
    const resp = await platformFetch(url, { method: 'GET', headers });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * base64 字符串 → ArrayBuffer
 * 用于 CapacitorHttp arraybuffer 响应的 bridge 回退解码
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * 便捷方法：POST JSON
 */
export async function platformPostJson<T = any>(
  url: string,
  body: object,
  headers?: Record<string, string>
): Promise<T | null> {
  try {
    const resp = await platformFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/** 截断 URL，避免日志过长 */
function truncateUrl(url: string, maxLen = 120): string {
  if (url.length <= maxLen) return url;
  return url.slice(0, maxLen) + '...';
}
