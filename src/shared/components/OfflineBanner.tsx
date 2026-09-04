import { WifiOff } from 'lucide-react';
import { useNetworkStatus } from '../hooks/useNetworkStatus';

/**
 * E1 顶部离线横幅：断网时出现，恢复网络自动消失。
 * 挂在 Layout 的 main 顶部（文档流内，不遮挡操作）。
 */
export default function OfflineBanner() {
  const online = useNetworkStatus();
  if (online) return null;

  return (
    <div
      className="flex items-center justify-center gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-600 dark:text-amber-400"
      role="status"
      aria-live="polite"
    >
      <WifiOff className="w-4 h-4 flex-shrink-0" />
      <span className="text-xs font-medium">当前无网络连接，部分内容可能为离线数据</span>
    </div>
  );
}
