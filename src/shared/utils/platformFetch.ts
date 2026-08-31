import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { HttpOptions, HttpResponse } from '@capacitor/core';

export interface PlatformFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect?: RequestRedirect;
}

export interface PlatformFetchError extends Error {
  type: 'network' | 'http' | 'timeout' | 'cors' | 'unknown';
  status?: number;
  statusText?: string;
  url: string;
}

function createError(
  type: PlatformFetchError['type'],
  message: string,
  url: string,
  status?: number,
  statusText?: string
): PlatformFetchError {
  const err = new Error(message) as PlatformFetchError;
  err.type = type;
  err.url = url;
  err.status = status;
  err.statusText = statusText;
  return err;
}

/**
 * 平台感知 fetch：
 * - 原生平台（iOS/Android）使用 CapacitorHttp，绕过 WebView CORS
 * - Web 环境回退到标准 fetch
 *
 * 若 capacitor.config.ts 中已启用 plugins.CapacitorHttp.enabled: true，
 * 则全局 fetch 已被 patch，但显式调用 CapacitorHttp 可确保在 hybrid 模式下
 * 获得最可靠的原生通道，并能拿到更清晰的错误信息。
 */
export async function platformFetch(
  url: string,
  options: PlatformFetchOptions = {}
): Promise<Response> {
  const isNative = Capacitor.isNativePlatform();

  if (isNative) {
    return nativeHttpFetch(url, options);
  }

  return webFetch(url, options);
}

async function nativeHttpFetch(
  url: string,
  options: PlatformFetchOptions
): Promise<Response> {
  const method = (options.method || 'GET').toUpperCase();

  const httpOptions: HttpOptions = {
    url,
    method,
    headers: options.headers || {},
    data: options.body,
    responseType: 'text',
  };

  // 支持 AbortSignal（CapacitorHttp 原生不直接支持，用 Promise.race 模拟）
  const fetchPromise = CapacitorHttp.request(httpOptions);

  let resp: HttpResponse;
  try {
    if (options.signal) {
      const abortPromise = new Promise<never>((_, reject) => {
        if (options.signal!.aborted) {
          reject(createError('timeout', 'Request aborted', url));
        }
        options.signal!.addEventListener('abort', () => {
          reject(createError('timeout', 'Request aborted', url));
        });
      });
      resp = await Promise.race([fetchPromise, abortPromise]);
    } else {
      resp = await fetchPromise;
    }
  } catch (err: any) {
    // 区分错误类型
    const msg = err?.message || String(err);
    if (msg.includes('timeout') || msg.includes('timed out')) {
      throw createError('timeout', `请求超时: ${url}`, url);
    }
    if (msg.includes('internet') || msg.includes('network') || msg.includes('connection')) {
      throw createError('network', `网络错误: ${msg}`, url);
    }
    throw createError('unknown', `请求失败: ${msg}`, url);
  }

  // 将 CapacitorHttp 的响应包装为标准 Response
  const status = resp.status;
  const statusText = getStatusText(status);

  const responseHeaders = new Headers();
  if (resp.headers) {
    Object.entries(resp.headers).forEach(([k, v]) => {
      if (v !== undefined && v !== null) {
        responseHeaders.set(k, String(v));
      }
    });
  }

  const bodyText = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);

  return new Response(bodyText, {
    status,
    statusText,
    headers: responseHeaders,
  });
}

async function webFetch(url: string, options: PlatformFetchOptions): Promise<Response> {
  try {
    const resp = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: options.signal,
      redirect: options.redirect,
    });
    return resp;
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes('CORS') || msg.includes('cors') || msg.includes('Cross-Origin')) {
      throw createError('cors', `CORS 拦截: ${msg}`, url);
    }
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      throw createError('network', `网络错误: ${msg}`, url);
    }
    if (msg.includes('aborted') || msg.includes('AbortError')) {
      throw createError('timeout', `请求被取消: ${msg}`, url);
    }
    throw createError('unknown', `请求失败: ${msg}`, url);
  }
}

function getStatusText(status: number): string {
  const map: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  };
  return map[status] || `HTTP ${status}`;
}

/**
 * 便捷 GET 请求，失败时抛出带类型的 PlatformFetchError
 */
export async function platformGet(
  url: string,
  headers?: Record<string, string>
): Promise<Response> {
  return platformFetch(url, { method: 'GET', headers });
}

/**
 * 便捷 POST JSON 请求
 */
export async function platformPostJson(
  url: string,
  body: object,
  headers?: Record<string, string>
): Promise<Response> {
  return platformFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/**
 * 便捷 POST Form 请求
 */
export async function platformPostForm(
  url: string,
  params: Record<string, string>,
  headers?: Record<string, string>
): Promise<Response> {
  const form = new URLSearchParams(params);
  return platformFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: form.toString(),
  });
}
