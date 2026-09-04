import { useEffect, useState } from 'react';

/**
 * E1 网络状态监听：navigator.onLine + online/offline 事件。
 *
 * 返回当前是否在线；离线时为 false，恢复网络自动变回 true（组件自动重渲染）。
 * 兜底：部分 WebView 场景 online/offline 事件派发不及时，定时核对一次
 * navigator.onLine 保证最终一致。
 */
export function useNetworkStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    const poll = window.setInterval(() => setOnline(navigator.onLine), 5000);

    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      window.clearInterval(poll);
    };
  }, []);

  return online;
}
