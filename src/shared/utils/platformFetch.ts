/**
 * 平台感知的 HTTP 请求封装
 * - Capacitor 环境：使用 CapacitorHttp 绕过 WebView CORS 限制
 * - 浏览器/Tauri 环境：回退到标准 fetch
 *
 * C1 修复：
 * - 超时用 AbortController 统一「超时=取消」语义（旧实现 Promise.race 后底层请求继续挂起）
 * - 自定义 timeout 透传到重试分支（旧实现重试时写死默认 8s）
 * - isRetryableError 兼容 CapacitorHttp 原生错误结构（旧实现非 Error 对象永不重试）
 * - body 类型收敛：仅 string / URLSearchParams 可进 CapacitorHttp，其余抛错而非静默丢弃
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

/**
 * 平台感知的 fetch 封装
 * 在 Capacitor Android/iOS 中自动走原生 HTTP，绕过 CORS
 */
export async function platformFetch(url: string, options: PlatformFetchOptions = {}): Promise<Response> {
  const isCapacitor = Capacitor.isNativePlatform();
  const startTime = performance.now();

  // E2: 未显式传 timeout 的请求默认 8s 超时，避免弱网下请求无限挂起（显式传 0 = 不超时）
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;

  // E2: 幂等 GET 且无外部取消信号时，网络级失败自动重试 1 次
  const isIdempotentGet = (options.method || 'GET').toUpperCase() === 'GET' && !options.signal;

  try {
    let response: Response;
    if (isIdempotentGet) {
      response = await fetchWithRetry(
        () => executeRequest(url, options, timeoutMs, isCapacitor),
        1,
        timeoutMs
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
    debugLogger.error('network', `请求失败 ${options.method || 'GET'}`, {
      url: truncateUrl(url),
      method: options.method || 'GET',
      duration: `${duration}ms`,
      error: normalizeErrorMessage(err),
      capacitor: isCapacitor,
    });
    throw err;
  }
}

/** 默认超时：8s */
export const DEFAULT_TIMEOUT_MS = 8000;

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
  timeoutMs: number
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // 退避 600ms，避免立即重试打到同一故障点
      await new Promise((r) => setTimeout(r, 600));
    }
    try {
      // C1: 每次重试都透传同一种超时语义（旧实现写死 DEFAULT_TIMEOUT_MS）
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
 * C1: 单次请求执行。
 * - 浏览器路径：AbortController 同时管理「外部取消」与「超时取消」，超时真正终止底层 fetch。
 * - Capacitor 路径：外部取消立即抛 AbortError（原生 bridge 无法中断进行中的请求）；
 *   超时通过 connectTimeout/readTimeout 交给原生层执行，并保证 Promise 按时 reject。
 */
async function executeRequest(
  url: string,
  options: PlatformFetchOptions,
  timeoutMs: number,
  isCapacitor: boolean
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
    return await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      body: resolveBrowserBody(options.body),
      signal: controller.signal,
      redirect: options.redirect || 'follow',
    });
  } catch (err) {
    throw settleError(err);
  } finally {
    cleanup();
  }
}

/** 浏览器路径 body：原生 BodyInit 直接透传 */
function resolveBrowserBody(body: PlatformFetchOptions['body']): BodyInit | undefined {
  return body ?? undefined;
}

/** 收敛 body 类型：CapacitorHttp 只接受 string，URLSearchParams 转字符串，其余显式抛错 */
function resolveCapacitorBody(body: PlatformFetchOptions['body']): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  // FormData / Blob / ArrayBuffer 等在 CapacitorHttp 上无法正确传输：
  // 旧实现静默丢弃（变成空 body 请求），这里改为显式抛错暴露问题
  throw new TypeError(
    `platformFetch: CapacitorHttp 仅支持 string / URLSearchParams body，收到 ${body.constructor?.name || typeof body}，` +
      `请先序列化（如 JSON.stringify 或 formData 转 URLSearchParams）`
  );
}

/**
 * CapacitorHttp 适配层：将 CapacitorHttp 的响应包装成标准 Response
 */
async function capacitorFetch(
  url: string,
  options: PlatformFetchOptions,
  timeoutMs: number,
  signal: AbortSignal
): Promise<Response> {
  const responseType = options.responseType || 'text';
  const httpOptions: HttpOptions = {
    url,
    method: (options.method || 'GET').toUpperCase() as HttpOptions['method'],
    headers: options.headers,
    data: resolveCapacitorBody(options.body),
    responseType,
  };
  // 超时交给原生层执行（Android connectTimeout/readTimeout，iOS 等平台由上层 Promise 兜底）
  if (timeoutMs > 0) {
    httpOptions.connectTimeout = timeoutMs;
    httpOptions.readTimeout = timeoutMs;
  }

  // 外部取消 / 上层超时 abort 时按时抛 AbortError（原生请求本身无法中断，但不影响调用方语义）
  const abortPromise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => reject(new DOMException('Aborted', 'AbortError')),
      { once: true }
    );
  });

  let resp: HttpResponse;
  try {
    resp = await Promise.race([CapacitorHttp.request(httpOptions), abortPromise]);
  } catch (err) {
    // 原生错误归一化：CapacitorHttp 失败通常是非 Error 对象，包装成 Error 便于重试判定
    if (err instanceof DOMException) throw err;
    const message = normalizeErrorMessage(err) || 'CapacitorHttp request failed';
    throw new Error(message);
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

/** 截断 URL，避免日志过长 */
function truncateUrl(url: string, maxLen = 120): string {
  if (url.length <= maxLen) return url;
  return url.slice(0, maxLen) + '...';
}
