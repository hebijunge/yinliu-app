import type { LucideIcon } from 'lucide-react';
import { SearchX, RotateCcw } from 'lucide-react';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** 提供则显示重试按钮 */
  onRetry?: () => void;
  retryText?: string;
}

/**
 * 统一空态：图标 + 标题 + 可选描述 + 可选重试按钮。
 * 供搜索结果、榜单、歌单等列表页复用。
 */
export default function EmptyState({
  icon: Icon = SearchX,
  title,
  description,
  onRetry,
  retryText = '重试',
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="w-14 h-14 rounded-2xl bg-[var(--bg-tertiary)] flex items-center justify-center mb-3">
        <Icon className="w-7 h-7 text-[var(--text-tertiary)]" />
      </div>
      <p className="text-sm font-medium text-[var(--text-secondary)]">{title}</p>
      {description && (
        <p className="text-xs text-[var(--text-tertiary)] mt-1 max-w-xs">{description}</p>
      )}
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-4 yinliu-btn-secondary inline-flex items-center gap-1.5 text-sm"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          {retryText}
        </button>
      )}
    </div>
  );
}
