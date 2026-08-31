import { useState } from 'react';
import { Settings, Music, BookOpen, Radio, HardDrive, Info } from 'lucide-react';
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
      <h1 className="text-2xl font-bold mb-6 hidden lg:block">设置</h1>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 overflow-x-auto pb-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm whitespace-nowrap transition-colors ${
              activeTab === tab.id
                ? 'bg-[var(--accent)]/10 text-[var(--accent)] font-medium'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="space-y-4">
        {activeTab === 'general' && (
          <>
            <div className="yinliu-card">
              <h3 className="font-medium mb-4">主题设置</h3>
              <div className="flex gap-2">
                {(['light', 'dark', 'system'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`px-4 py-2 rounded-lg text-sm ${
                      mode === m
                        ? 'bg-[var(--accent)] text-white'
                        : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
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
              <h3 className="font-medium mb-4">音源管理</h3>
              <div className="space-y-2">
                {sources.map((source) => (
                  <div
                    key={source.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-[var(--bg-tertiary)]"
                  >
                    <div>
                      <div className="font-medium">{source.name}</div>
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
              <h3 className="font-medium mb-4">下载设置</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm">默认下载音质</span>
                  <select className="yinliu-input text-sm py-1">
                    <option>标准 (128K)</option>
                    <option>高品 (320K)</option>
                    <option>无损 (FLAC)</option>
                  </select>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">最大并发下载数</span>
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
            <h3 className="font-medium mb-4">阅读设置</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm">字体大小</span>
                <select className="yinliu-input text-sm py-1">
                  <option>小</option>
                  <option selected>中</option>
                  <option>大</option>
                  <option>特大</option>
                </select>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">翻页动画</span>
                <select className="yinliu-input text-sm py-1">
                  <option>无</option>
                  <option selected>滑动</option>
                  <option>仿真</option>
                </select>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">背景颜色</span>
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
            <h3 className="font-medium mb-4">DJ设置</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm">Crossfade过渡</span>
                <select className="yinliu-input text-sm py-1">
                  <option>关闭</option>
                  <option>2秒</option>
                  <option selected>4秒</option>
                  <option>6秒</option>
                </select>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">BPM显示</span>
                <input type="checkbox" defaultChecked className="w-4 h-4" />
              </div>
            </div>
          </div>
        )}

        {activeTab === 'about' && (
          <div className="yinliu-card text-center py-8">
            <div className="text-3xl font-bold mb-2">音流</div>
            <div className="text-sm text-[var(--text-secondary)] mb-4">Audio Stream</div>
            <div className="text-xs text-[var(--text-tertiary)] space-y-1">
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
