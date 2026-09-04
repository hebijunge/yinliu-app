import { useState, useEffect, useCallback } from 'react';

export type LayoutMode = 'mobile' | 'mobile-landscape' | 'tablet' | 'desktop';

const BREAKPOINTS = {
  mobile: 640,
  tablet: 840,
  desktop: 1280,
};

function getLayoutMode(width: number): LayoutMode {
  if (width < BREAKPOINTS.mobile) return 'mobile';
  if (width < BREAKPOINTS.tablet) return 'mobile-landscape';
  if (width < BREAKPOINTS.desktop) return 'tablet';
  return 'desktop';
}

function getOrientation(): 'portrait' | 'landscape' {
  if (typeof window === 'undefined') return 'portrait';
  return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
}

/** 检测是否可能处于车机环境（通过 User-Agent 关键词） */
function detectCarEnvironment(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  const carKeywords = [
    'car', 'automotive', 'android auto', 'carplay', 'headunit',
    'huawei hicar', 'baidu carlife', ' driving ', 'in-car',
  ];
  return carKeywords.some((k) => ua.includes(k));
}

export interface ResponsiveLayout {
  mode: LayoutMode;
  width: number;
  height: number;
  isMobile: boolean;
  isMobileLandscape: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  isPortrait: boolean;
  isLandscape: boolean;
  isCarEnvironment: boolean;
}

export function useResponsiveLayout(): ResponsiveLayout {
  const [width, setWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : BREAKPOINTS.mobile
  );
  const [height, setHeight] = useState(
    typeof window !== 'undefined' ? window.innerHeight : 800
  );
  const [mode, setMode] = useState<LayoutMode>(getLayoutMode(width));
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>(getOrientation());
  const [isCarEnv] = useState(detectCarEnvironment);

  const updateLayout = useCallback(() => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    setWidth(w);
    setHeight(h);
    setMode(getLayoutMode(w));
    setOrientation(getOrientation());
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    window.addEventListener('resize', updateLayout);

    // 监听设备方向变化（横屏/竖屏切换）
    const orientationHandler = () => {
      // 方向变化后尺寸会随之变化，resize事件通常也会触发，但做双重保险
      setTimeout(updateLayout, 50);
    };
    window.addEventListener('orientationchange', orientationHandler);

    // 初始执行一次
    updateLayout();

    return () => {
      window.removeEventListener('resize', updateLayout);
      window.removeEventListener('orientationchange', orientationHandler);
    };
  }, [updateLayout]);

  return {
    mode,
    width,
    height,
    isMobile: mode === 'mobile',
    isMobileLandscape: mode === 'mobile-landscape',
    isTablet: mode === 'tablet',
    isDesktop: mode === 'desktop',
    isPortrait: orientation === 'portrait',
    isLandscape: orientation === 'landscape',
    isCarEnvironment: isCarEnv,
  };
}
