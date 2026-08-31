import { useState, useEffect } from 'react';
import { Menu } from 'lucide-react';
import Sidebar from './Sidebar';
import PlayerBar from '../player/PlayerBar';
import MobileNav from './MobileNav';
import ToastContainer from '@shared/components/Toast';
import { useResponsiveLayout } from '@shared/hooks/useResponsiveLayout';
import { useSettingsStore } from '@shared/store/settingsStore';

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { isMobile, isMobileLandscape, isTablet, isDesktop } = useResponsiveLayout();
  const carMode = useSettingsStore((s) => s.carMode);

  // 车机模式自动检测时同步body class
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (carMode) {
      document.body.classList.add('car-mode');
    } else {
      document.body.classList.remove('car-mode');
    }
  }, [carMode]);

  // 是否为侧边栏可见状态（tablet + desktop）
  const sidebarVisible = isTablet || isDesktop;
  // 是否为底部导航可见状态（仅mobile竖屏）
  const bottomNavVisible = isMobile && !isMobileLandscape;
  // 是否为移动端头部可见（mobile + mobile-landscape，无sidebar时）
  const mobileHeaderVisible = isMobile || isMobileLandscape;

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[var(--bg-primary)]">
      {/* ===== 主内容区 ===== */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar — 平板/桌面常驻显示 */}
        {sidebarVisible && (
          <aside
            className={`flex-shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)] ${
              isDesktop ? 'desktop-wide' : 'tablet-sidebar'
            }`}
            style={{ width: 'var(--sidebar-width, 220px)' }}
          >
            <Sidebar />
          </aside>
        )}

        {/* 移动端侧边栏遮罩（汉堡菜单打开时） */}
        {sidebarOpen && mobileHeaderVisible && (
          <div className="fixed inset-0 z-50 flex">
            <div
              className="bg-[var(--bg-secondary)] h-full"
              style={{
                width: 'var(--sidebar-width, 220px)',
                animation: 'slideInLeft 0.2s ease-out',
              }}
            >
              <Sidebar onClose={() => setSidebarOpen(false)} />
            </div>
            <div
              className="flex-1 bg-black/30 backdrop-blur-sm"
              onClick={() => setSidebarOpen(false)}
              style={{ animation: 'fadeIn 0.2s ease-out' }}
            />
          </div>
        )}

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden page-enter">
          {/* 移动端顶部标题栏（无sidebar时显示） */}
          {mobileHeaderVisible && (
            <div
              className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)] bg-[var(--bg-primary)]/80 backdrop-blur-md sticky top-0 z-30"
            >
              <button
                onClick={() => setSidebarOpen(true)}
                className="p-2 rounded-2xl hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
              >
                <Menu className="w-5 h-5" />
              </button>
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-xl bg-[var(--accent)]/10 flex items-center justify-center">
                  <svg
                    className="w-4 h-4 text-[var(--accent)]"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                  </svg>
                </div>
                <h1 className="text-base font-semibold text-[var(--text-primary)]">音流</h1>
              </div>
              <div className="w-9" />
            </div>
          )}

          {/* 内容区 — 根据布局模式调整padding */}
          <div
            className={`p-5 ${
              sidebarVisible ? 'lg:p-8' : ''
            } ${
              bottomNavVisible
                ? 'pb-28'
                : 'pb-[calc(var(--player-height)+1.5rem)]'
            }`}
          >
            {children}
          </div>
        </main>
      </div>

      {/* ===== Player Bar ===== */}
      {/* 桌面端：固定底部，留空sidebar宽度 */}
      {sidebarVisible && (
        <div className="fixed bottom-0 right-0 z-40" style={{ left: 'var(--sidebar-width, 220px)' }}>
          <PlayerBar />
        </div>
      )}

      {/* 移动端：固定底部全宽 */}
      {mobileHeaderVisible && (
        <div className="fixed bottom-0 left-0 right-0 z-40">
          <PlayerBar isLandscape={isMobileLandscape} />
          {bottomNavVisible && <MobileNav />}
        </div>
      )}

      {/* Toast 通知 */}
      <ToastContainer />
    </div>
  );
}
