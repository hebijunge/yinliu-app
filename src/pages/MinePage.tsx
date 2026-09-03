import { useNavigate } from 'react-router-dom';
import {
  Heart,
  ListMusic,
  Clock,
  Download,
  FolderOpen,
  BookOpen,
  AudioLines,
  Terminal,
  Settings,
  ChevronRight,
} from 'lucide-react';
import { useSettingsStore } from '@shared/store/settingsStore';

/** 我的：功能入口页 */
export default function MinePage() {
  const navigate = useNavigate();
  const debugMode = useSettingsStore((s) => s.debugMode);

  // 「我喜欢的音乐」直达收藏歌单详情；「我的歌单」进歌单列表页，两者不再指向同一视图
  const entries = [
    { icon: Heart, label: '我喜欢的音乐', to: '/playlists?id=favorites' },
    { icon: Heart, label: '收藏歌单', to: '/favorite-playlists' },
    { icon: ListMusic, label: '我的歌单', to: '/playlists' },
    { icon: Clock, label: '最近播放', to: '/history' },
    { icon: Download, label: '下载管理', to: '/downloads' },
    { icon: FolderOpen, label: '本地音乐', to: '/local' },
    { icon: BookOpen, label: '书架', to: '/reading' },
    { icon: AudioLines, label: '均衡器', to: '/eq' },
    // 调试日志仅 debug 模式可见，普通用户不暴露开发工具入口
    ...(debugMode ? [{ icon: Terminal, label: '调试日志', to: '/debug' }] : []),
    { icon: Settings, label: '设置', to: '/settings' },
  ];

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">我的</h1>
      <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] overflow-hidden">
        {entries.map((e, i) => (
          <button
            key={`${e.label}-${i}`}
            onClick={() => navigate(e.to)}
            className={`w-full flex items-center gap-3 px-4 py-3.5 text-sm text-left hover:bg-[var(--accent)]/5 ${
              i > 0 ? 'border-t border-[var(--border)]' : ''
            }`}
          >
            <e.icon className="w-5 h-5 text-[var(--accent)]" />
            <span className="flex-1 text-[var(--text-primary)]">{e.label}</span>
            <ChevronRight className="w-4 h-4 text-[var(--text-tertiary)]" />
          </button>
        ))}
      </div>
    </div>
  );
}
