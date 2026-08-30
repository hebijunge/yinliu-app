import { useState } from 'react';
import Sidebar from './Sidebar';
import PlayerBar from '../player/PlayerBar';
import MobileNav from './MobileNav';
import { useThemeStore } from '../../shared/store/themeStore';

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { isDark } = useThemeStore();

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[var(--bg-primary)]">
      {/* Desktop: Sidebar + Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar - hidden on mobile */}
        <aside className={`hidden lg:block w-[var(--sidebar-width)] flex-shrink-0 border-r border-[var(--border)] bg-[var(--bg-secondary)]`}>
          <Sidebar />
        </aside>

        {/* Mobile Sidebar Overlay */}
        {sidebarOpen && (
          <div className="lg:hidden fixed inset-0 z-50 flex">
            <div className="w-[var(--sidebar-width)] bg-[var(--bg-secondary)] h-full">
              <Sidebar onClose={() => setSidebarOpen(false)} />
            </div>
            <div className="flex-1 bg-black/50" onClick={() => setSidebarOpen(false)} />
          </div>
        )}

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden">
          {/* Mobile Header */}
          <div className="lg:hidden flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
            <button onClick={() => setSidebarOpen(true)} className="p-2 rounded-lg hover:bg-[var(--bg-tertiary)]">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <h1 className="text-lg font-bold">音流</h1>
            <div className="w-10" />
          </div>
          
          <div className="p-4 lg:p-6 pb-24 lg:pb-[calc(var(--player-height)+1.5rem)]">
            {children}
          </div>
        </main>
      </div>

      {/* Player Bar - desktop fixed bottom */}
      <div className="hidden lg:block fixed bottom-0 left-0 right-0 z-40">
        <div className="ml-[var(--sidebar-width)]">
          <PlayerBar />
        </div>
      </div>

      {/* Mobile: Player bar + Bottom Nav */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-40">
        <PlayerBar />
        <MobileNav />
      </div>
    </div>
  );
}
