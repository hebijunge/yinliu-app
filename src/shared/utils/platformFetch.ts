/**
 * 平台感知的 HTTP 请求封装
 * - Capacitor 环境：使用 CapacitorHttp 绕过 WebView CORS 限制
 * - 浏览器/Tauri 环境：回退到标准 fetch
 */

import { Capacitor } from '@capacitor/core';
import { CapacitorHttp, type HttpOptions, type HttpResponse } from '@capacitor/core';

export interface PlatformFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | FormData | URLSearchParams;
  signal?: AbortSignal;
  redirect?: 'follow' | 'error' | 'manual';
}

/**
 * 平台感知的 fetch 封装
 * 在 Capacitor Android/iOS 中自动走原生 HTTP，绕过 CORS
 */
export async function platformFetch(url: string, options: PlatformFetchOptions = {}): Promise<Response> {
  const isCapacitor = Capacitor.isNativePlatform();

  if (isCapacitor) {
    return capacitorFetch(url, options);
  }

  // 浏览器 / Tauri 环境：标准 fetch
  return fetch(url, {
    method: options.method || 'GET',
    headers: options.headers,
    body: options.body as BodyInit | undefined,
    signal: options.signal,
    redirect: options.redirect || 'follow',
  });
}

/**
 * CapacitorHttp 适配层：将 CapacitorHttp 的响应包装成标准 Response
 */
async function capacitorFetch(url: string, options: PlatformFetchOptions): Promise<Response> {
  const httpOptions: HttpOptions = {
    url,
    method: (options.method || 'GET').toUpperCase() as HttpOptions['method'],
    headers: options.headers,
    data: typeof options.body === 'string' ? options.body : undefined,
    responseType: 'arraybuffer',
  };

  let aborted = false;
  const abortHandler = () => { aborted = true; };
  options.signal?.addEventListener('abort', abortHandler);

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
    if (typeof resp.data === 'string') {
      body = resp.data;
    } else if (resp.data instanceof ArrayBuffer) {
      body = resp.data;
    } else if (resp.data) {
      body = JSON.stringify(resp.data);
    } else {
      body = '';
    }

    return new Response(body, { status, statusText, headers });
  } finally {
    options.signal?.removeEventListener('abort', abortHandler);
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
