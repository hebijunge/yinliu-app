import { WifiOff } from 'lucide-react';

interface OfflineEmptyStateProps {
  /** 有缓存数据先展示缓存时，传 true 标注「离线内容」；无缓存整块空态时省略 */
  hasCachedContent?: boolean;
  description?: string;
  /** 提供则显示重试按钮 */
  onRetry?: () => void;
}

/**
 * E1 统一离线空态：首页/搜索/播放/下载四类页面复用。
 * - 无缓存：图标 + 「当前无网络连接」+ 重试按钮，保证有可操作出口；
 * - 有缓存：只显示「离线内容」标注条，缓存列表照常渲染（由页面自行组合）。
 */
export default function OfflineEmptyState({
  hasCachedContent = false,
  description,
  onRetry,
}: OfflineEmptyStateProps) {
  if (hasCachedContent) {
    return (
      <div className="flex items-center justify-center gap-1.5 px-3 py-1.5 mx-auto mt-2 w-fit rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400">
        <WifiOff className="w-3 h-3" />
        <span className="text-xs font-medium">离线内容</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="w-14 h-14 rounded-2xl bg-[var(--bg-tertiary)] flex items-center justify-center mb-3">
        <WifiOff className="w-7 h-7 text-[var(--text-tertiary)]" />
      </div>
      <p className="text-sm font-medium text-[var(--text-secondary)]">当前无网络连接</p>
      <p className="text-xs text-[var(--text-tertiary)] mt-1 max-w-xs">
        {description ?? '请检查网络设置后重试，恢复网络后内容会自动可用'}
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-4 yinliu-btn-secondary inline-flex items-center gap-1.5 text-sm"
        >
          重新加载
        </button>
      )}
    </div>
  );
}
