import { useNavigate } from 'react-router-dom';
import {
  Settings,
  Download,
  Clock,
  ListMusic,
  Heart,
  Music,
  ChevronRight,
  Bug,
  Info,
} from 'lucide-react';
import { usePlaylistStore } from '../shared/store/playlistStore';
import { usePlayHistoryStore } from '../shared/store/playHistoryStore';
import { useDownloadStore } from '../shared/store/downloadStore';
import { useSettingsStore } from '../shared/store/settingsStore';

export default function ProfilePage() {
  const navigate = useNavigate();
  const { playlists, favorites } = usePlaylistStore();
  const { records: historyRecords } = usePlayHistoryStore();
  const { tasks: downloadTasks } = useDownloadStore();
  const { debugMode } = useSettingsStore();

  const downloadingCount = downloadTasks.filter((t) => t.status === 'downloading' || t.status === 'pending').length;
  const completedCount = downloadTasks.filter((t) => t.status === 'completed').length;

  const menuItems = [
    {
      id: 'playlists',
      label: '我的歌单',
      icon: ListMusic,
      badge: playlists.filter((p) => p.id !== 'favorites').length,
      onClick: () => navigate('/playlists'),
    },
    {
      id: 'favorites',
      label: '我喜欢的音乐',
      icon: Heart,
      badge: favorites.size,
      onClick: () => navigate('/playlists?id=favorites'),
    },
    {
      id: 'history',
      label: '最近播放',
      icon: Clock,
      badge: historyRecords.length,
      onClick: () => navigate('/history'),
    },
    {
      id: 'downloads',
      label: '下载管理',
      icon: Download,
      badge: downloadingCount > 0 ? `${downloadingCount} 进行中` : completedCount > 0 ? `${completedCount} 已完成` : undefined,
      onClick: () => navigate('/downloads'),
    },
    {
      id: 'local',
      label: '本地音乐',
      icon: Music,
      onClick: () => navigate('/local'),
    },
    {
      id: 'settings',
      label: '设置',
      icon: Settings,
      onClick: () => navigate('/settings'),
    },
  ];

  if (debugMode) {
    menuItems.push({
      id: 'debug',
      label: '调试日志',
      icon: Bug,
      onClick: () => navigate('/debug'),
    });
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-6 hidden lg:block">我的</h1>

      {/* 用户信息卡片 */}
      <div className="yinliu-card mb-6 flex items-center gap-4">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--accent)]/20 to-[var(--accent)]/5 flex items-center justify-center border border-[var(--accent)]/10">
          <Music className="w-8 h-8 text-[var(--accent)]" />
        </div>
        <div className="flex-1">
          <div className="text-lg font-semibold text-[var(--text-primary)]">音流用户</div>
          <div className="text-xs text-[var(--text-tertiary)] mt-0.5">
            {historyRecords.length} 首播放记录 · {favorites.size} 首收藏 · {playlists.length} 个歌单
          </div>
        </div>
      </div>

      {/* 菜单列表 */}
      <div className="space-y-1">
        {menuItems.map((item) => (
          <button
            key={item.id}
            onClick={item.onClick}
            className="w-full flex items-center gap-3 p-4 rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] hover:border-[var(--accent)]/30 transition-all text-left group"
          >
            <div className="w-9 h-9 rounded-xl bg-[var(--bg-tertiary)] flex items-center justify-center text-[var(--text-secondary)] group-hover:text-[var(--accent)] transition-colors">
              <item.icon className="w-4.5 h-4.5" />
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium text-[var(--text-primary)]">{item.label}</div>
            </div>
            {item.badge !== undefined && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]">
                {item.badge}
              </span>
            )}
            <ChevronRight className="w-4 h-4 text-[var(--text-tertiary)]" />
          </button>
        ))}
      </div>

      {/* 关于 */}
      <div className="mt-8 text-center">
        <div className="inline-flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
          <Info className="w-3 h-3" />
          音流 v17 · 多音源聚合音乐播放器
        </div>
      </div>
    </div>
  );
}
