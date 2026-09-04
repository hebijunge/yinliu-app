import { useEffect, useState } from 'react';
import { subscribeNetwork, isOnline } from '../utils/networkMonitor';

/**
 * E1 网络状态监听：navigator.onLine + online/offline 事件。
 *
 * D9 合一：事件订阅统一复用 shared/utils/networkMonitor 的全局单套监听，
 * 本 hook 只叠加 UI 侧的两项增强：
 * 1. 兜底轮询——部分 WebView 场景 online/offline 事件派发不及时，定时核对
 *    navigator.onLine 保证最终一致；
 * 2. 订阅建立时先以 isOnline() 校准一次初值。
 *
 * 返回当前是否在线；离线时为 false，恢复网络自动变回 true（组件自动重渲染）。
 */
export function useNetworkStatus(): boolean {
  const [online, setOnline] = useState(isOnline);

  useEffect(() => {
    // 初值校准 + 订阅全局事件（networkMonitor 内部幂等安装、单套监听）
    setOnline(isOnline());
    const unsubscribe = subscribeNetwork(setOnline);
    const poll = window.setInterval(() => setOnline(isOnline()), 5000);
    return () => {
      unsubscribe();
      window.clearInterval(poll);
    };
  }, []);

  return online;
}
