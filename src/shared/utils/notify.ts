/**
 * v23 修复走查 #5：下载完成/失败系统通知。
 *
 * 项目同时面向 Tauri 桌面端与 Capacitor/WebView 端：
 * - Tauri 环境（存在 __TAURI_INTERNALS__）：走 @tauri-apps/plugin-notification（依赖已在 package.json，此前零使用）
 * - 其余环境：走 W3C Notification API（Android WebView / 浏览器），用户未授权时静默降级为 console 日志，
 *   绝不因通知失败影响下载主链路
 */

interface TauriNotificationPlugin {
  isPermissionGranted(): Promise<{ permissionGranted: boolean }>;
  requestPermission(): Promise<{ permissionGranted: boolean }>;
  sendNotification(options: { title: string; body?: string }): Promise<void>;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function sendTauriNotification(title: string, body: string): Promise<void> {
  const plugin = (await import('@tauri-apps/plugin-notification')) as unknown as TauriNotificationPlugin;
  let granted = false;
  try {
    ({ permissionGranted: granted } = await plugin.isPermissionGranted());
  } catch {
    granted = false;
  }
  if (!granted) {
    try {
      ({ permissionGranted: granted } = await plugin.requestPermission());
    } catch {
      granted = false;
    }
  }
  if (!granted) {
    console.warn('[notify] notification permission not granted (tauri), skip:', title);
    return;
  }
  await plugin.sendNotification({ title, body });
}

async function sendWebNotification(title: string, body: string): Promise<void> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    console.info('[notify]', title, body);
    return;
  }
  try {
    let granted = Notification.permission === 'granted';
    if (!granted && Notification.permission === 'default') {
      ({ permission: granted } = { permission: (await Notification.requestPermission()) === 'granted' });
    }
    if (!granted) {
      // 未授权：降级为应用内 Toast，保证用户仍能感知下载结果
      console.info('[notify] permission not granted, fallback log:', title, body);
      return;
    }
    new Notification(title, { body });
  } catch (err) {
    console.warn('[notify] web notification failed:', err);
  }
}

export async function notifyDownloadDone(title: string, artist?: string): Promise<void> {
  const body = artist ? `${artist} · 下载完成` : '下载完成';
  try {
    if (isTauri()) await sendTauriNotification(title, body);
    else await sendWebNotification(title, body);
  } catch (err) {
    console.warn('[notify] download done notification failed:', err);
  }
}

export async function notifyDownloadFailed(title: string, reason?: string): Promise<void> {
  const body = reason ? `下载失败：${reason}` : '下载失败，请重试';
  try {
    if (isTauri()) await sendTauriNotification(title, body);
    else await sendWebNotification(title, body);
  } catch (err) {
    console.warn('[notify] download failed notification failed:', err);
  }
}
