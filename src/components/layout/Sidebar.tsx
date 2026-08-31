import { Link, useLocation } from 'react-router-dom';
import {
  Search,
  ListMusic,
  BookOpen,
  Radio,
  Download,
  HardDrive,
  Settings,
  X,
  Sun,
  Moon,
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
      <div className="flex items-center justify-between px-5 py-5 border-b border-[var(--border-subtle)]">
        <Link to="/" className="flex items-center gap-3 group" onClick={onClose}>
          <div className="w-9 h-9 rounded-2xl bg-[var(--accent)]/10 flex items-center justify-center group-hover:bg-[var(--accent)]/15 transition-colors">
            <svg className="w-5 h-5 text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
          </div>
          <div className="flex flex-col">
            <span className="text-lg font-semibold leading-tight text-[var(--text-primary)]">音流</span>
            <span className="text-[10px] text-[var(--text-tertiary)] leading-tight -mt-0.5">多音源聚合播放器</span>
          </div>
        </Link>
        {onClose && (
          <button
            onClick={onClose}
            className="lg:hidden p-2 rounded-2xl hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 px-3 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              onClick={onClose}
              className={`flex items-center gap-3 px-3.5 py-2.5 rounded-2xl transition-all duration-200 focus-ring ${
                isActive
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-semibold'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <item.icon className={`w-5 h-5 ${isActive ? 'stroke-[2.5]' : ''}`} />
              <span className="text-sm">{item.label}</span>
              {isActive && (
                <div className="ml-auto w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
              )}
            </Link>
          );
        })}
      </nav>

      {/* Theme Toggle */}
      <div className="p-3 border-t border-[var(--border-subtle)]">
        <button
          onClick={toggleTheme}
          className="flex items-center gap-3 px-3.5 py-2.5 w-full rounded-2xl text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors focus-ring"
        >
          {isDark ? (
            <Sun className="w-5 h-5" />
          ) : (
            <Moon className="w-5 h-5" />
          )}
          <span className="text-sm">{isDark ? '浅色模式' : '深色模式'}</span>
        </button>
      </div>
    </div>
  );
}
