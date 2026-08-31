import { Link, useLocation } from 'react-router-dom';
import { Search, ListMusic, BookOpen, Radio, Settings } from 'lucide-react';

export default function MobileNav() {
  const location = useLocation();

  const navItems = [
    { path: '/', icon: Search, label: '搜索' },
    { path: '/playlists', icon: ListMusic, label: '歌单' },
    { path: '/reading', icon: BookOpen, label: '阅读' },
    { path: '/dj', icon: Radio, label: 'DJ' },
    { path: '/settings', icon: Settings, label: '设置' },
  ];

  return (
    <nav className="bg-[var(--bg-secondary)] border-t border-[var(--border)] flex justify-around items-center py-2 safe-area-bottom">
      {navItems.map((item) => {
        const isActive = location.pathname === item.path;
        return (
          <Link
            key={item.path}
            to={item.path}
            className={`flex flex-col items-center gap-0.5 px-3 py-1 ${
              isActive ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]'
            }`}
          >
            <item.icon className="w-5 h-5" />
            <span className="text-[10px]">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
