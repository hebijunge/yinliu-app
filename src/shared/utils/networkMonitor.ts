/**
 * 网络状态监听（P0/E5 基础件）
 *
 * 轻量在线状态订阅：navigator.onLine + online/offline 事件。
 * 供播放引擎断网暂停/自动续播（E5）等场景使用。
 *
 * 注意：与 E1 的 useNetworkStatus（研发1号）职责不同——
 * 本模块是纯引擎侧事件订阅，不产出 UI 状态。
 */

type NetworkListener = (online: boolean) => void;

const listeners = new Set<NetworkListener>();
let installed = false;

/** 当前是否在线（SSR/非浏览器环境视为在线） */
export function isOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

function handleOnline() {
  for (const l of listeners) l(true);
}

function handleOffline() {
  for (const l of listeners) l(false);
}

/** 安装全局 online/offline 监听（幂等，首次订阅时自动安装） */
function ensureInstalled() {
  if (installed || typeof window === 'undefined') return;
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  installed = true;
}

/**
 * 订阅网络变化。返回取消订阅函数。
 * @param listener (online: boolean) => void
 */
export function subscribeNetwork(listener: NetworkListener): () => void {
  ensureInstalled();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// D9 合一：组件侧请使用 shared/hooks/useNetworkStatus（基于本模块的 subscribeNetwork，
// 叠加 WebView 事件滞后兜底轮询）；本模块不再重复提供 hook。