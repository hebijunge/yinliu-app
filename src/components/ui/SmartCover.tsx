import { useState, useEffect } from 'react';

/**
 * SmartCover —— 统一封面图组件（P0/P4+P7 基础件）
 *
 * 解决的两类根因：
 * - P4 闪烁/错位：容器固定 aspect-ratio + 占位背景，图片到达前后容器尺寸不变；
 *   onLoad 后 opacity 淡入，杜绝加载完成瞬间的白块闪烁。
 * - P7 无占位加载慢：loading="lazy" + decoding="async" + 稳定占位色块/图标；
 *   onError 回退占位图标（原 CoverImg 逻辑收敛于此）。
 *
 * 全项目 img 引用统一替换为本组件。
 */

export interface SmartCoverProps {
  /** 封面地址；空值直接渲染占位 */
  src?: string;
  alt?: string;
  /** 容器附加类名（尺寸/圆角等） */
  className?: string;
  /** 图片附加类名 */
  imgClassName?: string;
  /** 占位图标（默认音符） */
  fallbackIcon?: React.ReactNode;
  /** 容器宽高比：square（默认）| video | free（需外部给固定高度） */
  ratio?: 'square' | 'video' | 'free';
  /** 首屏关键图可传 eager 跳过懒加载 */
  eager?: boolean;
  /** 是否圆角（默认跟随外部 className，不强制） */
}

const RATIO_CLASS: Record<NonNullable<SmartCoverProps['ratio']>, string> = {
  square: 'aspect-square',
  video: 'aspect-video',
  free: '',
};

export default function SmartCover({
  src,
  alt = '',
  className = '',
  imgClassName = '',
  fallbackIcon,
  ratio = 'square',
  eager = false,
}: SmartCoverProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  // 换图时重置淡入/失败状态，避免展示上一张的残影
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [src]);

  const showImg = !!src && !failed;

  return (
    <div
      className={`relative overflow-hidden bg-[var(--bg-tertiary)] flex items-center justify-center ${RATIO_CLASS[ratio]} ${className}`}
    >
      {/* 占位：加载完成前始终垫底，保证容器不塌陷 */}
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center">
          {showImg ? (
            <div className="w-full h-full skeleton-shimmer" />
          ) : (
            fallbackIcon ?? <MusicPlaceholder />
          )}
        </div>
      )}
      {showImg && (
        <img
          src={src}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ${
            loaded ? 'opacity-100' : 'opacity-0'
          } ${imgClassName}`}
        />
      )}
      {/* 加载失败回退占位图标 */}
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center">
          {fallbackIcon ?? <MusicPlaceholder />}
        </div>
      )}
    </div>
  );
}

function MusicPlaceholder() {
  return (
    <svg
      className="w-5 h-5 text-[var(--text-tertiary)]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}
