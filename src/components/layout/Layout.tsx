import { useState } from 'react';
import { Menu } from 'lucide-react';
import Sidebar from './Sidebar';
import PlayerBar from '../player/PlayerBar';
import MobileNav from './MobileNav';

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[var(--bg-primary)]">
      {/* Desktop: Sidebar + Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar - hidden on mobile */}
        <aside className="hidden lg:block w-[var(--sidebar-width)] flex-shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
          <Sidebar />
        </aside>

        {/* Mobile Sidebar Overlay */}
        {sidebarOpen && (
          <div className="lg:hidden fixed inset-0 z-50 flex">
            <div
              className="w-[var(--sidebar-width)] bg-[var(--bg-secondary)] h-full shadow-2xl"
              style={{ animation: 'slideInLeft 0.2s ease-out' }}
            >
              <Sidebar onClose={() => setSidebarOpen(false)} />
            </div>
            <div
              className="flex-1 bg-black/60 backdrop-blur-sm"
              onClick={() => setSidebarOpen(false)}
              style={{ animation: 'fadeIn 0.2s ease-out' }}
            />
          </div>
        )}

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden page-enter">
          {/* Mobile Header */}
          <div className="lg:hidden flex items-center justify-between px-4 py-3 border-b border-[var(--border-subtle)] bg-[var(--bg-primary)]/80 backdrop-blur-md sticky top-0 z-30">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 rounded-xl hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-[var(--accent)]/10 flex items-center justify-center">
                <svg className="w-4 h-4 text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
              </div>
              <h1 className="text-base font-bold">音流</h1>
            </div>
            <div className="w-9" />
          </div>

          <div className="p-4 lg:p-6 pb-28 lg:pb-[calc(var(--player-height)+1.5rem)]">
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
