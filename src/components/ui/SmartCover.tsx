import { useState } from 'react';
import { Music } from 'lucide-react';

interface SmartCoverProps {
  src?: string;
  alt?: string;
  /** 外层容器类名：需自带尺寸（如 w-12 h-12 rounded-lg overflow-hidden） */
  className?: string;
  /** 图片类名，默认铺满容器 */
  imgClassName?: string;
  /** 关键首屏封面（播放器等）用 eager 立即加载 */
  eager?: boolean;
  /** 加载失败时的自定义回退节点，默认音符图标 */
  fallback?: React.ReactNode;
}

/**
 * P4+P7 SmartCover 统一封面组件：
 * ① loading=lazy + decoding=async 降低列表封面加载压力；
 * ② onLoad 前保持占位、加载完成后淡入，避免闪现与布局跳动；
 * ③ onError 回退音符占位，死链/防盗链不再出现空白块。
 */
export default function SmartCover({
  src,
  alt = '',
  className = '',
  imgClassName = '',
  eager = false,
  fallback,
}: SmartCoverProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        {fallback ?? <Music className="w-1/2 h-1/2 text-[var(--text-tertiary)]" />}
      </div>
    );
  }

  return (
    <div className={`relative ${className}`}>
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-tertiary)]">
          <Music className="w-1/2 h-1/2 text-[var(--text-tertiary)] opacity-40" />
        </div>
      )}
      <img
        src={src}
        alt={alt}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={`${imgClassName || 'w-full h-full object-cover'} transition-opacity duration-300 ${
          loaded ? 'opacity-100' : 'opacity-0'
        }`}
      />
    </div>
  );
}
