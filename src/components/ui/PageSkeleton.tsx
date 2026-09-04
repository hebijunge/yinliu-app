import { Skeleton } from './Skeleton';

interface PageSkeletonProps {
  /** 命中 grid 型页面（曲库/专区/我的）时渲染宫格骨架，其余渲染列表骨架 */
  variant?: 'list' | 'grid';
}

/**
 * 路由级骨架屏（P11）：替代 Suspense 默认的空白转圈。
 * 切 Tab 时旧页卸载、新 chunk 未就绪的间隙显示与目标页结构一致的骨架，
 * 消除内容区白闪；chunk 空闲预取后此骨架只在弱机/首访时短暂出现。
 */
export default function PageSkeleton({ variant = 'list' }: PageSkeletonProps) {
  return (
    <div className="max-w-4xl mx-auto" aria-hidden="true">
      <Skeleton className="h-8 w-32 mb-4" />
      {variant === 'grid' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <Skeleton className="w-full aspect-square rounded-2xl" />
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-3 rounded-lg bg-[var(--bg-secondary)]">
              <Skeleton className="w-12 h-12 rounded-lg flex-shrink-0" />
              <div className="flex-1 flex flex-col gap-2">
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="h-3 w-1/4" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
