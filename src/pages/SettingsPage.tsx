import { useState } from 'react';
import { Settings, Music, BookOpen, Radio, Info } from 'lucide-react';
import { useThemeStore } from '../shared/store/themeStore';
import { sourceRegistry } from '../providers/music/registry';

export default function SettingsPage() {
  const { mode, setMode } = useThemeStore();
  const [activeTab, setActiveTab] = useState<'general' | 'music' | 'reading' | 'dj' | 'about'>('general');

  const sources = sourceRegistry.getAll();

  const tabs = [
    { id: 'general' as const, label: '通用', icon: Settings },
    { id: 'music' as const, label: '音乐', icon: Music },
    { id: 'reading' as const, label: '阅读', icon: BookOpen },
    { id: 'dj' as const, label: 'DJ', icon: Radio },
    { id: 'about' as const, label: '关于', icon: Info },
  ];

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-light mb-8 hidden lg:block text-[var(--text-primary)]">设置</h1>

      {/* Tabs */}
      <div className="flex gap-1 mb-8 overflow-x-auto pb-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl text-sm whitespace-nowrap transition-all focus-ring ${
              activeTab === tab.id
                ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-semibold'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
            }`}
          >
            <tab.icon className={`w-4 h-4 ${activeTab === tab.id ? 'stroke-[2.5]' : ''}`} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="space-y-4">
        {activeTab === 'general' && (
          <>
            <div className="yinliu-card">
              <h3 className="font-semibold mb-4 text-[var(--text-primary)]">主题设置</h3>
              <div className="flex gap-2">
                {(['light', 'dark', 'system'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`px-5 py-2.5 rounded-2xl text-sm font-medium transition-all focus-ring ${
                      mode === m
                        ? 'bg-[var(--accent)] text-white'
                        : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)]'
                    }`}
                  >
                    {m === 'light' && '浅色'}
                    {m === 'dark' && '深色'}
                    {m === 'system' && '跟随系统'}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {activeTab === 'music' && (
          <>
            <div className="yinliu-card">
              <h3 className="font-semibold mb-4 text-[var(--text-primary)]">音源管理</h3>
              <div className="space-y-2">
                {sources.map((source) => (
                  <div
                    key={source.id}
                    className="flex items-center justify-between p-4 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]"
                  >
                    <div>
                      <div className="font-medium text-[var(--text-primary)]">{source.name}</div>
                      <div className="text-xs text-[var(--text-tertiary)]">
                        最高音质: {source.maxQuality}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${source.enabled ? 'bg-green-500' : 'bg-gray-400'}`} />
                      <span className="text-sm text-[var(--text-secondary)]">
                        {source.enabled ? '已启用' : '已禁用'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="yinliu-card">
              <h3 className="font-semibold mb-4 text-[var(--text-primary)]">下载设置</h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--text-primary)]">默认下载音质</span>
                  <select className="yinliu-input text-sm py-1">
                    <option>标准 (128K)</option>
                    <option>高品 (320K)</option>
                    <option>无损 (FLAC)</option>
                  </select>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--text-primary)]">最大并发下载数</span>
                  <select className="yinliu-input text-sm py-1">
                    <option>1</option>
                    <option>2</option>
                    <option selected>3</option>
                    <option>5</option>
                  </select>
                </div>
              </div>
            </div>
          </>
        )}

        {activeTab === 'reading' && (
          <div className="yinliu-card">
            <h3 className="font-semibold mb-4 text-[var(--text-primary)]">阅读设置</h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-[var(--text-primary)]">字体大小</span>
                <select className="yinliu-input text-sm py-1">
                  <option>小</option>
                  <option selected>中</option>
                  <option>大</option>
                  <option>特大</option>
                </select>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-[var(--text-primary)]">翻页动画</span>
                <select className="yinliu-input text-sm py-1">
                  <option>无</option>
                  <option selected>滑动</option>
                  <option>仿真</option>
                </select>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-[var(--text-primary)]">背景颜色</span>
                <select className="yinliu-input text-sm py-1">
                  <option>白色</option>
                  <option selected>米色</option>
                  <option>护眼绿</option>
                  <option>夜间黑</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'dj' && (
          <div className="yinliu-card">
            <h3 className="font-semibold mb-4 text-[var(--text-primary)]">DJ设置</h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-[var(--text-primary)]">Crossfade过渡</span>
                <select className="yinliu-input text-sm py-1">
                  <option>关闭</option>
                  <option>2秒</option>
                  <option selected>4秒</option>
                  <option>6秒</option>
                </select>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-[var(--text-primary)]">BPM显示</span>
                <input type="checkbox" defaultChecked className="w-4 h-4 accent-[var(--accent)]" />
              </div>
            </div>
          </div>
        )}

        {activeTab === 'about' && (
          <div className="yinliu-card text-center py-12">
            <div className="w-16 h-16 mx-auto mb-5 rounded-3xl bg-[var(--accent)]/10 flex items-center justify-center">
              <svg className="w-10 h-10 text-[var(--accent)]" viewBox="0 0 64 64" fill="none">
                <rect x="6" y="6" width="52" height="52" rx="18" stroke="currentColor" strokeWidth="2" opacity="0.2" />
                <path d="M24 46V22l20-4v20" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="20" cy="46" r="5" stroke="currentColor" strokeWidth="2" />
                <circle cx="40" cy="42" r="5" stroke="currentColor" strokeWidth="2" />
              </svg>
            </div>
            <div className="text-2xl font-light mb-1 text-[var(--text-primary)] tracking-widest">音流</div>
            <div className="text-sm text-[var(--text-secondary)] mb-8">Audio Stream</div>
            <div className="text-xs text-[var(--text-tertiary)] space-y-1.5">
              <p>版本: v0.1.0 MVP</p>
              <p>多音源聚合音乐播放器</p>
              <p>支持平台: 网易云 / QQ音乐 / 酷我 / 酷狗 / 咪咕</p>
              <p>功能: 音乐 / 阅读 / DJ / 本地音乐 / 下载</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
