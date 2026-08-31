import { useState } from 'react';
import { Settings, Music, Info, Trash2, Check, ListOrdered } from 'lucide-react';
import { useThemeStore } from '../shared/store/themeStore';
import { useSettingsStore } from '../shared/store/settingsStore';
import { useSearchStore } from '../shared/store/searchStore';
import { usePlayerStore } from '../shared/store/playerStore';
import { sourceRegistry } from '../providers/music/registry';
import { Quality } from '../core/types';
import {
  PLATFORM_PRIORITY,
  PLATFORM_DISPLAY_NAMES,
  PLATFORM_COLORS,
} from '../core/platformPriority';

type TabId = 'general' | 'music' | 'about';

const QUALITY_OPTIONS: Array<{ value: Quality; label: string }> = [
  { value: Quality.STANDARD, label: '标准 (128K)' },
  { value: Quality.HIGH, label: '高品 (320K)' },
  { value: Quality.LOSSLESS, label: '无损 (FLAC)' },
  { value: Quality.HIRES, label: 'Hi-Res' },
];

export default function SettingsPage() {
  const { mode, setMode } = useThemeStore();
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [cleanDone, setCleanDone] = useState<string | null>(null);

  const { preferredQuality, enabledSources, downloadQuality, maxConcurrentDownloads, downloadDir,
    setPreferredQuality, setSourceEnabled, setDownloadQuality, setMaxConcurrentDownloads, clearAllSettings } =
    useSettingsStore();

  const sources = sourceRegistry.getAll();

  const tabs = [
    { id: 'general' as const, label: '通用', icon: Settings },
    { id: 'music' as const, label: '音乐', icon: Music },
    { id: 'about' as const, label: '关于', icon: Info },
  ];

  const handleQualityPreference = (q: Quality) => {
    setPreferredQuality(q);
    usePlayerStore.getState().setQuality(q);
    useSearchStore.getState().setQuality(q);
  };

  const handleSourceToggle = (sourceId: string, enabled: boolean) => {
    setSourceEnabled(sourceId, enabled);
  };

  const handleClearHistory = () => {
    useSearchStore.getState().clearHistory();
    useSearchStore.getState().setResults([]);
    setCleanDone('history');
    setTimeout(() => setCleanDone(null), 2000);
  };

  const handleClearAll = () => {
    clearAllSettings();
    useSearchStore.getState().clearHistory();
    setCleanDone('all');
    setTimeout(() => setCleanDone(null), 2000);
  };

  const Toggle = ({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) => (
    <button
      onClick={() => onChange(!on)}
      className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 focus-ring ${on ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'}`}
      role="switch"
      aria-checked={on}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`}
      />
    </button>
  );

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
        )}

        {activeTab === 'music' && (
          <>
            {/* 音源开关：真实生效，关闭后聚合搜索只走启用的源 */}
            <div className="yinliu-card">
              <h3 className="font-semibold mb-1 text-[var(--text-primary)]">音源管理</h3>
              <p className="text-xs text-[var(--text-tertiary)] mb-4">关闭后聚合搜索将只使用启用的音源</p>
              <div className="space-y-2">
                {sources.map((source) => {
                  const on = enabledSources[source.id] !== false;
                  return (
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
                      <div className="flex items-center gap-3">
                        <span className={`w-2 h-2 rounded-full ${on ? 'bg-green-500' : 'bg-gray-400'}`} />
                        <span className="text-sm text-[var(--text-secondary)] w-12 text-right">
                          {on ? '已启用' : '已禁用'}
                        </span>
                        <Toggle on={on} onChange={(v) => handleSourceToggle(source.id, v)} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* v13: 取链优先级（只读展示） */}
            <div className="yinliu-card">
              <h3 className="font-semibold mb-1 text-[var(--text-primary)] flex items-center gap-2">
                <ListOrdered className="w-4 h-4" />
                平台取链优先级
              </h3>
              <p className="text-xs text-[var(--text-tertiary)] mb-4">
                同一首歌多平台都支持时，按以下顺序取链；首选失败自动降级到下一平台
              </p>
              <ol className="space-y-2">
                {PLATFORM_PRIORITY.map((sourceId, idx) => (
                  <li
                    key={sourceId}
                    className="flex items-center gap-3 p-3 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]"
                  >
                    <span className="flex-shrink-0 w-7 h-7 rounded-full bg-[var(--accent)] text-white text-sm font-semibold flex items-center justify-center">
                      {idx + 1}
                    </span>
                    <span
                      className={`w-2 h-2 rounded-full flex-shrink-0 ${PLATFORM_COLORS[sourceId] || 'bg-gray-400'}`}
                    />
                    <span className="font-medium text-sm text-[var(--text-primary)] flex-1">
                      {PLATFORM_DISPLAY_NAMES[sourceId] || sourceId}
                    </span>
                    {idx === 0 && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--accent)]/15 text-[var(--accent)] font-medium">
                        首选
                      </span>
                    )}
                  </li>
                ))}
              </ol>
              <p className="text-[11px] text-[var(--text-tertiary)] mt-3 leading-relaxed">
                仅对多平台可用的歌曲生效；单平台歌曲行为不变。降级过程会在播放/下载时通过 Toast 提示。
              </p>
            </div>

            {/* 音质偏好：与播放页音质切换共用同一持久化 */}
            <div className="yinliu-card">
              <h3 className="font-semibold mb-1 text-[var(--text-primary)]">音质偏好</h3>
              <p className="text-xs text-[var(--text-tertiary)] mb-4">播放页可随时切换；音源给不了所选档位时会如实标注实际音质</p>
              <div className="flex gap-2 flex-wrap">
                {QUALITY_OPTIONS.map((q) => (
                  <button
                    key={q.value}
                    onClick={() => handleQualityPreference(q.value)}
                    className={`px-4 py-2 rounded-full text-sm font-medium transition-all focus-ring flex items-center gap-1.5 ${
                      preferredQuality === q.value
                        ? 'bg-[var(--accent)] text-white'
                        : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)]'
                    }`}
                  >
                    {preferredQuality === q.value && <Check className="w-3.5 h-3.5" />}
                    {q.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 下载设置 */}
            <div className="yinliu-card">
              <h3 className="font-semibold mb-4 text-[var(--text-primary)]">下载设置</h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--text-primary)]">默认下载音质</span>
                  <select
                    className="yinliu-input text-sm py-1"
                    value={downloadQuality}
                    onChange={(e) => setDownloadQuality(e.target.value as Quality)}
                  >
                    {QUALITY_OPTIONS.map((q) => (
                      <option key={q.value} value={q.value}>{q.label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--text-primary)]">最大并发下载数</span>
                  <select
                    className="yinliu-input text-sm py-1"
                    value={maxConcurrentDownloads}
                    onChange={(e) => setMaxConcurrentDownloads(Number(e.target.value))}
                  >
                    {[1, 2, 3, 5].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--text-primary)]">下载目录</span>
                  <span className="text-xs text-[var(--text-tertiary)] font-mono break-all max-w-[60%] text-right">
                    {downloadDir}
                  </span>
                </div>
              </div>
            </div>

            {/* 数据清理 */}
            <div className="yinliu-card">
              <h3 className="font-semibold mb-1 text-[var(--text-primary)]">数据清理</h3>
              <p className="text-xs text-[var(--text-tertiary)] mb-4">清除本地缓存数据，不影响已下载的音乐文件</p>
              <div className="space-y-2">
                <button
                  onClick={handleClearHistory}
                  className="w-full flex items-center justify-between p-4 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] hover:border-[var(--accent)]/30 transition-colors focus-ring"
                >
                  <span className="text-sm text-[var(--text-primary)] flex items-center gap-2">
                    <Trash2 className="w-4 h-4 text-[var(--text-tertiary)]" />
                    清除搜索历史与结果缓存
                  </span>
                  {cleanDone === 'history' && <span className="text-xs text-green-500">已清除</span>}
                </button>
                <button
                  onClick={handleClearAll}
                  className="w-full flex items-center justify-between p-4 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] hover:border-red-500/30 transition-colors focus-ring"
                >
                  <span className="text-sm text-[var(--text-primary)] flex items-center gap-2">
                    <Trash2 className="w-4 h-4 text-[var(--text-tertiary)]" />
                    恢复默认设置（含音源开关 / 音质偏好 / 下载设置）
                  </span>
                  {cleanDone === 'all' && <span className="text-xs text-green-500">已恢复</span>}
                </button>
              </div>
            </div>
          </>
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
              <p className="mt-4 opacity-60">v13 · 新增：聚合搜索 + 取链优先级 · 多平台降级</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
