/**
 * v23 修复走查 #5：下载完成/失败系统通知。
 *
 * 项目同时面向 Tauri 桌面端、Capacitor/Android 原生端与浏览器 WebView：
 * - Tauri 环境（存在 __TAURI_INTERNALS__）：走 @tauri-apps/plugin-notification（依赖已在 package.json，此前零使用）
 * - Capacitor 原生环境（C9）：Android WebView 无 W3C Notification，走 @capacitor/local-notifications。
 *   本模块只做权限检查（未授权静默跳过），授权请求统一收敛到设置页用户手势（SettingsPage「开启下载通知」）
 * - 其余环境：走 W3C Notification API（浏览器），用户未授权时静默降级为 console 日志，
 *   绝不因通知失败影响下载主链路
 */

import { Capacitor } from '@capacitor/core';

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

// C9：Capacitor 原生端通知（Android WebView 无 W3C Notification）。
// 仅检查权限、不在此处弹授权——授权请求统一收敛到设置页用户手势（SettingsPage「开启下载通知」）。
async function sendCapacitorNotification(title: string, body: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  let granted = false;
  try {
    const status = await LocalNotifications.checkPermissions();
    granted = status.display === 'granted';
  } catch {
    granted = false;
  }
  if (!granted) {
    console.info('[notify] permission not granted (native), skip — 授权入口在设置页:', title);
    return;
  }
  await LocalNotifications.schedule({
    notifications: [{ title, body, id: Date.now() % 2147483647 }],
  });
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
    else if (Capacitor.isNativePlatform()) await sendCapacitorNotification(title, body);
    else await sendWebNotification(title, body);
  } catch (err) {
    console.warn('[notify] download done notification failed:', err);
  }
}

export async function notifyDownloadFailed(title: string, reason?: string): Promise<void> {
  const body = reason ? `下载失败：${reason}` : '下载失败，请重试';
  try {
    if (isTauri()) await sendTauriNotification(title, body);
    else if (Capacitor.isNativePlatform()) await sendCapacitorNotification(title, body);
    else await sendWebNotification(title, body);
  } catch (err) {
    console.warn('[notify] download failed notification failed:', err);
  }
}
