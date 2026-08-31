import React from 'react';

interface SkeletonProps {
  className?: string;
  style?: React.CSSProperties;
}

/** Base skeleton with shimmer animation */
export function Skeleton({ className = '', style }: SkeletonProps) {
  return (
    <div
      className={`skeleton-shimmer rounded-lg ${className}`}
      style={style}
    />
  );
}

/** Skeleton for text lines */
export function SkeletonText({ lines = 1, className = '' }: { lines?: number; className?: string }) {
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-4" style={{ width: i === lines - 1 && lines > 1 ? '60%' : '100%' }} />
      ))}
    </div>
  );
}

/** Skeleton for a square/rect image/cover */
export function SkeletonCover({ size = '3rem', className = '' }: { size?: string; className?: string }) {
  return (
    <Skeleton
      className={`flex-shrink-0 rounded-xl ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/** Skeleton for a search result item */
export function SkeletonSearchResult({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)]">
          <SkeletonCover size="3rem" />
          <div className="flex-1 min-w-0">
            <Skeleton className="h-4 w-3/4 mb-2" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="h-8 w-8 rounded-full" />
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
        <div key={i} className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] overflow-hidden">
          <Skeleton className="aspect-square w-full" />
          <div className="p-3">
            <Skeleton className="h-4 w-3/4 mb-2" />
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
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)]">
          <Skeleton className="h-5 w-5 rounded" />
          <div className="flex-1">
            <Skeleton className="h-4 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
