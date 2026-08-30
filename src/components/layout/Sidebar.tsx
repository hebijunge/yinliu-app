import { Link, useLocation } from 'react-router-dom';
import {
  Search,
  ListMusic,
  BookOpen,
  Radio,
  Download,
  HardDrive,
  Settings,
  Music2,
  X,
} from 'lucide-react';
import { useThemeStore } from '../../shared/store/themeStore';

interface SidebarProps {
  onClose?: () => void;
}

export default function Sidebar({ onClose }: SidebarProps) {
  const location = useLocation();
  const { isDark, toggleTheme } = useThemeStore();

  const navItems = [
    { path: '/', icon: Search, label: '搜索' },
    { path: '/playlists', icon: ListMusic, label: '歌单' },
    { path: '/local', icon: HardDrive, label: '本地音乐' },
    { path: '/reading', icon: BookOpen, label: '阅读' },
    { path: '/dj', icon: Radio, label: 'DJ' },
    { path: '/downloads', icon: Download, label: '下载' },
    { path: '/settings', icon: Settings, label: '设置' },
  ];

  return (
    <div className="h-full flex flex-col bg-[var(--bg-secondary)]">
      {/* Logo */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <Music2 className="w-6 h-6 text-[var(--accent)]" />
          <span className="text-lg font-bold">音流</span>
        </div>
        {onClose && (
          <button onClick={onClose} className="lg:hidden p-1 rounded hover:bg-[var(--bg-tertiary)]">
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-3 px-2 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              onClick={onClose}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
                isActive
                  ? 'bg-[var(--accent)]/10 text-[var(--accent)] font-medium'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <item.icon className="w-5 h-5" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Theme Toggle */}
      <div className="p-3 border-t border-[var(--border)]">
        <button
          onClick={toggleTheme}
          className="flex items-center gap-3 px-3 py-2.5 w-full rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
        >
          {isDark ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
            </svg>
          )}
          <span>{isDark ? '浅色模式' : '深色模式'}</span>
        </button>
      </div>
    </div>
  );
}
