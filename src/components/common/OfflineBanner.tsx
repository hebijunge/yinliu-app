import { WifiOff } from 'lucide-react';
import { useNetworkStatus } from '@shared/hooks/useNetworkStatus';

/**
 * 顶部离线横幅（E1 基础件）：
 * 断网时在内容区顶部展示全局提示，恢复网络后自动消失。
 * 放在 Layout 主内容列顶部（占位式而非悬浮），避免遮挡点击。
 */
export default function OfflineBanner() {
  const { isOnline } = useNetworkStatus();
  if (isOnline) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 px-4 py-2 bg-amber-500/15 border-b border-amber-500/30 text-amber-600 dark:text-amber-400"
    >
      <WifiOff className="w-4 h-4 flex-shrink-0" />
      <span className="text-xs font-medium">当前无网络连接，部分内容可能不可用</span>
    </div>
  );
}
