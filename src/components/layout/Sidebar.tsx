import { NavLink } from 'react-router-dom';
import { House, Library, Compass, User, Search, Download, BookOpen, Settings, Heart, Clock, ListMusic, Music,Trophy } from 'lucide-react';
import { usePlaylistStore } from '../../shared/store/playlistStore';
import { PLATFORM_SHORT_NAMES } from '../../core/platformPriority';

interface SidebarProps {
  onClose?: () => void;
}

export default function Sidebar({ onClose }: SidebarProps) {
  const { playlists } = usePlaylistStore();

  const navItems = [
    { to: '/', icon: House, label: '首页' },
    { to: '/library', icon: Library, label: '曲库' },
    { to: '/zone', icon: Compass, label: '专区' },
    { to: '/mine', icon: User, label: '我的' },
    { to: '/search', icon: Search, label: '搜索' },
    { to: '/history', icon: Clock, label: '最近播放' },
    { to: '/charts', icon: Trophy, label: '榜单聚合' },
    { to: '/songlists', icon: ListMusic, label: '歌单聚合' },
    { to: '/playlists', icon: ListMusic, label: '我的歌单' },
    { to: '/downloads', icon: Download, label: '下载管理' },
    { to: '/reading', icon: BookOpen, label: '书架' },
    { to: '/settings', icon: Settings, label: '设置' },
  ];

  return (
    <div className="h-full flex flex-col p-4">
      {/* Logo */}
      <div className="flex items-center gap-3 mb-6 px-2">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center">
          <Music className="w-5 h-5 text-white" />
        </div>
        <span className="text-xl font-bold">音流</span>
      </div>

      {/* Main Nav */}
      <nav className="space-y-1">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onClose}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
              }`
            }
          >
            <item.icon className="w-5 h-5" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* Divider */}
      <div className="my-4 border-t border-[var(--border)]" />

      {/* Playlists */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-3 mb-2 text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
          我的歌单
        </div>
        <div className="space-y-0.5">
          {playlists.map((pl) => (
            <NavLink
              key={pl.id}
              to={`/playlists?id=${pl.id}`}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                }`
              }
            >
              {pl.id === 'favorites' ? <Heart className="w-4 h-4" /> : <ListMusic className="w-4 h-4" />}
              <span className="truncate">{pl.name}</span>
            </NavLink>
          ))}
        </div>
      </div>
    </div>
  );
}
