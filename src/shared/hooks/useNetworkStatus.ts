import { useEffect, useState } from 'react';

/**
 * 网络状态查询（非 hook，供引擎/工具函数使用）。
 * SSR / 非浏览器环境恒返回 true（视为在线，不拦截）。
 */
export function getIsOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

export interface NetworkStatus {
  /** 当前是否在线（navigator.onLine + online/offline 事件实时同步） */
  isOnline: boolean;
  /** 本次会话内是否发生过断网（用于「离线内容」等标记） */
  everOffline: boolean;
}

/**
 * useNetworkStatus（E1 基础件）：
 * 订阅 window 的 online/offline 事件，实时返回网络状态。
 * 断网横幅、各页面离线空态、下载引擎自动暂停均基于此判定。
 */
export function useNetworkStatus(): NetworkStatus {
  const [isOnline, setIsOnline] = useState<boolean>(() => getIsOnline());
  const [everOffline, setEverOffline] = useState<boolean>(() => !getIsOnline());

  useEffect(() => {
    const goOffline = () => {
      setIsOnline(false);
      setEverOffline(true);
    };
    const goOnline = () => setIsOnline(true);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    // 事件订阅前状态可能已变化（后台切回等），做一次对齐
    setIsOnline(getIsOnline());
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  return { isOnline, everOffline };
}
