/**
 * B站登录与 Cookie 刷新工具
 * 依据《B站音源接入调研报告 v2.1》第十章/第十一章实现
 *
 * 提供：
 * - QR 二维码登录（Web 端，生成 → 轮询 → 取 Cookie）
 * - Cookie 自动刷新（RSA-OAEP CorrespondPath + refresh 链路）
 *
 * 注：UI 集成需调用方自行处理；本模块只提供纯 API。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

const PASSPORT_HOST = 'https://passport.bilibili.com';

/** B站登录凭据（核心字段） */
export interface BiliCredential {
  SESSDATA: string;
  bili_jct: string;
  DedeUserID: string;
  DedeUserID__ckMd5?: string;
  refresh_token?: string;
}

/** 二维码状态码 */
export enum QRCodeStatus {
  NOT_SCANNED = 86101, // 未扫码
  SCANNED_NOT_CONFIRMED = 86090, // 已扫码未确认
  EXPIRED = 86038, // 二维码已失效
  SUCCESS = 0, // 登录成功
}

/** 二维码申请结果 */
export interface QRCodeGenerateResult {
  url: string; // 二维码内容
  qrcode_key: string; // 扫码密钥
}

/** Cookie 健康检查结果 */
export interface CookieInfoResult {
  refresh: boolean; // 是否需要刷新
  timestamp: number; // 当前服务器毫秒时间戳
}

/** B站 JWK 公钥（用于 RSA-OAEP 加密 CorrespondPath） */
const BILI_JWK = {
  kty: 'RSA',
  n: 'y4HdjgJHBlbaBN04VERG4qNBIFHP6a3GozCl75AihQloSWCXC5HDNgyinEnhaQ_4-gaMud_GF50elYXLlCToR9se9Z8z433U3KjM-3Yx7ptKkmQNAMggQwAVKgq3zYAoidNEWuxpkY_mAitTSRLnsJW-NCTa0bqBFF6Wm1MxgfE',
  e: 'AQAB',
};

// ===================== 二维码登录 =====================

/**
 * 申请二维码
 */
export async function generateQRCode(): Promise<QRCodeGenerateResult> {
  const resp = await fetch(`${PASSPORT_HOST}/x/passport-login/web/qrcode/generate`, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
  });
  const data = await resp.json();
  if (data?.code !== 0 || !data?.data) {
    throw new Error(`二维码申请失败: ${JSON.stringify(data)}`);
  }
  return {
    url: data.data.url,
    qrcode_key: data.data.qrcode_key,
  };
}

/**
 * 轮询扫码状态
 */
export async function pollQRCode(qrcode_key: string): Promise<{
  status: QRCodeStatus;
  cookies?: string; // 登录成功时返回的 Set-Cookie 拼接
  message: string;
}> {
  const resp = await fetch(
    `${PASSPORT_HOST}/x/passport-login/web/qrcode/poll?qrcode_key=${qrcode_key}`,
    {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    }
  );
  const data = await resp.json();
  const code = data?.data?.code ?? -1;
  const message = data?.data?.message || '';

  if (code === 0) {
    // 登录成功：从 Set-Cookie 中提取
    // 注意：fetch 在跨域时不会暴露 Set-Cookie，这里依赖业务侧通过 redirect URL 提取或专用头透传
    const cookies = extractCookiesFromHeaders(resp.headers);
    return { status: QRCodeStatus.SUCCESS, cookies, message: '登录成功' };
  }

  return {
    status: code as QRCodeStatus,
    message,
  };
}

/** 从响应头中提取 Set-Cookie（仅在浏览器允许时有效） */
function extractCookiesFromHeaders(headers: Headers): string | undefined {
  // 浏览器 fetch 不暴露 Set-Cookie；如需在浏览器内获取，需通过后端代理或专用通道
  // 此处保留作为占位，调用方应通过业务约定的渠道获取 Cookie
  return undefined;
}

/**
 * 轮询直到状态终态（成功/失效）。1.5s 间隔。
 */
export async function pollUntilDone(
  qrcode_key: string,
  onUpdate?: (status: QRCodeStatus, message: string) => void,
  signal?: AbortSignal
): Promise<{ status: QRCodeStatus; cookies?: string; message: string }> {
  while (true) {
    if (signal?.aborted) {
      return { status: QRCodeStatus.EXPIRED, message: '已取消' };
    }
    const result = await pollQRCode(qrcode_key);
    onUpdate?.(result.status, result.message);
    if (
      result.status === QRCodeStatus.SUCCESS ||
      result.status === QRCodeStatus.EXPIRED
    ) {
      return result;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ===================== Cookie 刷新 =====================

/**
 * 检查 Cookie 是否需要刷新
 */
export async function checkCookieInfo(credential: BiliCredential): Promise<CookieInfoResult> {
  const resp = await fetch(
    `${PASSPORT_HOST}/x/passport-login/web/cookie/info`,
    {
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.bilibili.com/',
        Cookie: `SESSDATA=${credential.SESSDATA}; bili_jct=${credential.bili_jct}; DedeUserID=${credential.DedeUserID}`,
      },
    }
  );
  const data = await resp.json();
  if (data?.code !== 0) {
    throw new Error(`Cookie info check failed: ${JSON.stringify(data)}`);
  }
  return {
    refresh: !!data.data.refresh,
    timestamp: data.data.timestamp,
  };
}

/**
 * 使用 RSA-OAEP 生成 CorrespondPath
 * 消息体：refresh_{timestamp}
 */
async function generateCorrespondPath(timestampMs: number): Promise<string> {
  const message = `refresh_${timestampMs}`;

  // 解析 JWK 为 CryptoKey
  const pubKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: BILI_JWK.kty,
      n: BILI_JWK.n,
      e: BILI_JWK.e,
      alg: 'RSA-OAEP',
      ext: true,
    } as JsonWebKey,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    pubKey,
    new TextEncoder().encode(message)
  );

  // 输出为 URL-safe Base64（去掉 padding）
  return base64urlEncode(new Uint8Array(encrypted));
}

/**
 * 获取 refresh_csrf
 */
async function getRefreshCsrf(
  credential: BiliCredential,
  correspondPath: string
): Promise<string> {
  const resp = await fetch(
    `${PASSPORT_HOST}/x/passport-login/web/cookie/refresh_csrf?correspond_path=${correspondPath}&source=main_web`,
    {
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.bilibili.com/',
        Cookie: `SESSDATA=${credential.SESSDATA}; bili_jct=${credential.bili_jct}; DedeUserID=${credential.DedeUserID}`,
      },
    }
  );
  const data = await resp.json();
  if (data?.code !== 0) {
    throw new Error(`refresh_csrf 获取失败: ${JSON.stringify(data)}`);
  }
  return data.data.refresh_csrf;
}

/**
 * 执行 Cookie 刷新
 * @returns 新的 Cookie 凭据
 */
export async function refreshCookie(credential: BiliCredential): Promise<BiliCredential> {
  // 1. 检查是否需要刷新
  const info = await checkCookieInfo(credential);
  if (!info.refresh) {
    return credential; // 无需刷新
  }

  // 2. 生成 CorrespondPath
  const correspondPath = await generateCorrespondPath(info.timestamp);

  // 3. 获取 refresh_csrf
  const refreshCsrf = await getRefreshCsrf(credential, correspondPath);

  // 4. 执行刷新
  const refreshResp = await fetch(
    `${PASSPORT_HOST}/x/passport-login/web/cookie/refresh`,
    {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.bilibili.com/',
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `SESSDATA=${credential.SESSDATA}; bili_jct=${credential.bili_jct}; DedeUserID=${credential.DedeUserID}`,
      },
      body: new URLSearchParams({
        csrf: credential.bili_jct,
        refresh_csrf: refreshCsrf,
        source: 'main_web',
        refresh_token: credential.refresh_token || '',
      }).toString(),
    }
  );
  const refreshData = await refreshResp.json();
  if (refreshData?.code !== 0) {
    throw new Error(`Cookie 刷新失败: ${JSON.stringify(refreshData)}`);
  }

  // 5. 确认刷新（使旧 refresh_token 失效）
  try {
    await fetch(`${PASSPORT_HOST}/x/passport-login/web/confirm/refresh`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.bilibili.com/',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        csrf: credential.bili_jct,
        refresh_token: credential.refresh_token || '',
      }).toString(),
    });
  } catch {
    // 确认失败不阻断
  }

  // 注意：新 Cookie 通过 Set-Cookie 头返回，浏览器 fetch 不暴露
  // 调用方需配合专用通道（如：Tauri/Capacitor 的 http 客户端）获取
  return credential;
}

// ===================== 凭据管理 =====================

const CREDENTIAL_KEY = 'bili_credential';

/** 从 localStorage 读取凭据 */
export function loadCredential(): BiliCredential | null {
  try {
    const raw = localStorage.getItem(CREDENTIAL_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as BiliCredential;
  } catch {
    return null;
  }
}

/** 保存凭据到 localStorage */
export function saveCredential(cred: BiliCredential): void {
  localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(cred));
}

/** 清除凭据 */
export function clearCredential(): void {
  localStorage.removeItem(CREDENTIAL_KEY);
}

// ===================== 工具函数 =====================

function base64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 构造请求 Cookie 头（用于取链时携带） */
export function buildCookieHeader(cred: BiliCredential): string {
  const parts = [
    `SESSDATA=${cred.SESSDATA}`,
    `bili_jct=${cred.bili_jct}`,
    `DedeUserID=${cred.DedeUserID}`,
  ];
  if (cred.DedeUserID__ckMd5) parts.push(`DedeUserID__ckMd5=${cred.DedeUserID__ckMd5}`);
  return parts.join('; ');
}
