import React from 'react';

interface SkeletonProps {
  className?: string;
  style?: React.CSSProperties;
}

/** Base skeleton with shimmer animation */
export function Skeleton({ className = '', style }: SkeletonProps) {
  return (
    <div
      className={`skeleton-shimmer rounded-xl ${className}`}
      style={style}
    />
  );
}

/** Skeleton for text lines */
export function SkeletonText({ lines = 1, className = '' }: { lines?: number; className?: string }) {
  return (
    <div className={`flex flex-col gap-2.5 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-4" style={{ width: i === lines - 1 && lines > 1 ? '60%' : '100%' }} />
      ))}
    </div>
  );
}

/** Skeleton for a square/rect image/cover */
export function SkeletonCover({ size = '3.5rem', className = '' }: { size?: string; className?: string }) {
  return (
    <Skeleton
      className={`flex-shrink-0 rounded-2xl ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/** Skeleton for a search result item —— D5: 内部尺寸与 SongRow 实际渲染对齐（p-3/gap-3/rounded-lg/48px 封面），加载完成无跳变 */
export function SkeletonSearchResult({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-3 rounded-lg bg-[var(--bg-secondary)]">
          <Skeleton className="w-12 h-12 rounded-lg flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <Skeleton className="h-4 w-3/4 mb-2" />
            <Skeleton className="h-3 w-1/2 mb-2" />
            {/* D5: 源徽章占位行，避免骨架屏高度比实际行矮 */}
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-9 w-9 rounded-full flex-shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** Skeleton for playlist cards grid */
export function SkeletonPlaylistGrid({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] overflow-hidden">
          <Skeleton className="aspect-square w-full" />
          <div className="p-4">
            <Skeleton className="h-4 w-3/4 mb-2.5" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Skeleton for a list of items */
export function SkeletonList({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 p-4 rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
          <Skeleton className="h-5 w-5 rounded-lg" />
          <div className="flex-1">
            <Skeleton className="h-4 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
