import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Settings, Music, Info, Trash2, Check, ListOrdered, Bug, Download, FileText, Moon, SlidersHorizontal, ChevronRight } from 'lucide-react';
import { useThemeStore } from '../shared/store/themeStore';
import { useSettingsStore } from '../shared/store/settingsStore';
import { useSearchStore } from '../shared/store/searchStore';
import { usePlayerStore } from '../shared/store/playerStore';
import { useSleepTimerStore, formatSleepTimerRemaining } from '../shared/store/sleepTimerStore';
import { sourceRegistry } from '../providers/music/registry';
import { Quality } from '../core/types';
import {
  PLATFORM_PRIORITY,
  PLATFORM_DISPLAY_NAMES,
  PLATFORM_COLORS,
} from '../core/platformPriority';
import { debugLogger } from '@shared/utils/debugLogger';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { useEqStore } from '@core/player/equalizer';
import SleepTimerPanel from '../components/player/SleepTimerPanel';
import ConfirmDialog, { type ConfirmRequest } from '../components/common/ConfirmDialog';

type TabId = 'general' | 'music' | 'about';

// v23 修复走查 #12：不再向用户透出内部码率字段（如 20900k），只保留面向用户的档位名
const QUALITY_OPTIONS: Array<{ value: Quality; label: string }> = [
  { value: Quality.MASTER, label: '超无损母带' },
  { value: Quality.DOLBY, label: '至臻全景声' },
  { value: Quality.ZHIZHEN, label: '至臻音质 2.0' },
  { value: Quality.STANDARD, label: '标准 128K' },
  { value: Quality.HIGH, label: '高品 320K' },
  { value: Quality.LOSSLESS, label: '无损 FLAC' },
  { value: Quality.HIRES, label: 'Hi-Res' },
];

/** D6: Toggle 提升到模块作用域 —— 原先定义在 SettingsPage 渲染体内，
 * 每次渲染都会生成新组件类型，React 按类型卸载重建整棵子树，
 * 导致 Toggle 动画丢失、焦点/点击状态异常。 */
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

/**
 * v23 修复走查 #13：自定义下拉组件，替代原生 <select>，与整体视觉风格统一。
 * 点击展开选项浮层；点击外部或选项后收起。
 */
function SettingsSelect<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="min-w-[9rem] flex items-center justify-between gap-2 px-3 py-1.5 rounded-xl text-sm bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-primary)] hover:border-[var(--accent)]/40 transition-colors focus-ring"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">{current?.label ?? String(value)}</span>
        <svg className={`w-3.5 h-3.5 text-[var(--text-tertiary)] transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`} fill="currentColor" viewBox="0 0 24 24">
          <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" />
        </svg>
      </button>
      {open && (
        <div
          className="absolute right-0 z-50 mt-1.5 min-w-[11rem] max-h-56 overflow-y-auto rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] shadow-xl py-1"
          role="listbox"
        >
          {options.map((o) => (
            <button
              key={String(o.value)}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 transition-colors ${
                o.value === value
                  ? 'text-[var(--accent)] bg-[var(--accent-soft)]'
                  : 'text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
              }`}
              role="option"
              aria-selected={o.value === value}
            >
              <span className="truncate">{o.label}</span>
              {o.value === value && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const { mode, setMode } = useThemeStore();
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [cleanDone, setCleanDone] = useState<string | null>(null);
  // P2 修复：统一二次确认弹窗——用自绘 ConfirmDialog 取代原生 window.confirm
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [showSleepTimer, setShowSleepTimer] = useState(false);
  const { active: sleepTimerActive, remainingSeconds, mode: sleepTimerMode } = useSleepTimerStore();
  const { enabled: eqEnabled, setEnabled: setEqEnabled } = useEqStore();

  const { preferredQuality, enabledSources, downloadQuality, maxConcurrentDownloads, downloadDir,
    autoResumeOnAudioFocus, enableNotificationControls, dismissNotificationOnPause, debugMode, enableFloatingLyrics,
    setPreferredQuality, setSourceEnabled, setDownloadQuality, setMaxConcurrentDownloads,
    setAutoResumeOnAudioFocus, setEnableNotificationControls, setDismissNotificationOnPause, setDebugMode, setFloatingLyricsEnabled, clearAllSettings, setDownloadDir } =
    useSettingsStore();

  // v23 修复走查 #11：下载目录编辑草稿（跟随持久化值同步）
  const [downloadDirDraft, setDownloadDirDraft] = useState(downloadDir);

  // C9：下载完成通知授权入口——Android WebView 无 W3C Notification，授权请求收敛到此用户手势
  const isNativeApp = Capacitor.isNativePlatform();
  const [notifyPerm, setNotifyPerm] = useState<string>('unknown');
  useEffect(() => {
    if (!isNativeApp) return;
    let cancelled = false;
    LocalNotifications.checkPermissions()
      .then((s) => { if (!cancelled) setNotifyPerm(s.display); })
      .catch(() => { if (!cancelled) setNotifyPerm('unknown'); });
    return () => { cancelled = true; };
  }, [isNativeApp]);
  const handleRequestNotifyPerm = async () => {
    try {
      const s = await LocalNotifications.requestPermissions();
      setNotifyPerm(s.display);
    } catch (err) {
      console.warn('[settings] request notification permission failed:', err);
    }
  };
  const NOTIFY_PERM_LABEL: Record<string, string> = {
    granted: '已授权',
    denied: '已拒绝',
    prompt: '未授权',
    promptWithRationale: '未授权',
    unknown: '检测中…',
  };

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

  // v23 修复走查 #9：恢复默认设置前二次确认（不可逆，会重置音源开关/音质偏好/下载设置）
  const handleClearAll = () => {
    setConfirmRequest({
      title: '恢复默认设置',
      message: '确定要恢复默认设置吗？音源开关、音质偏好、下载设置等都会被重置。',
      confirmText: '恢复默认',
      onConfirm: () => {
        clearAllSettings();
        useSearchStore.getState().clearHistory();
        // D6: 恢复默认音质需同步三处状态（settings 偏好 + 播放器 + 搜索），
        // 只清 settingsStore 会导致播放页/搜索页仍停留在旧档位
        usePlayerStore.getState().setQuality(Quality.STANDARD);
        useSearchStore.getState().setQuality(Quality.STANDARD);
        setCleanDone('all');
        setTimeout(() => setCleanDone(null), 2000);
      },
    });
  };

  const handleExportLogs = (format: 'txt' | 'md') => {
    debugLogger.triggerExport(format);
  };

  const handleClearLogs = () => {
    setConfirmRequest({
      title: '清空调试日志',
      message: '确定要清空所有调试日志吗？此操作不可恢复。',
      confirmText: '清空',
      onConfirm: () => {
        debugLogger.clear();
      },
    });
  };

  return (
    <div className="max-w-2xl mx-auto">
      {/* Sleep Timer overlay */}
      {showSleepTimer && <SleepTimerPanel onClose={() => setShowSleepTimer(false)} />}
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

            {/* 音效均衡器（v18） */}
            <div className="yinliu-card">
              <h3 className="font-semibold mb-1 text-[var(--text-primary)] flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4" />
                音效均衡器
              </h3>
              <p className="text-xs text-[var(--text-tertiary)] mb-4">5 段均衡 + 6 种预设，对流式边下边播与本地播放同时生效</p>
              <div className="flex items-center justify-between p-3 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
                <div>
                  <div className="font-medium text-sm text-[var(--text-primary)]">启用均衡器</div>
                  <div className="text-xs text-[var(--text-tertiary)]">关闭时保持原声直出，不影响播放链路</div>
                </div>
                <Toggle on={eqEnabled} onChange={setEqEnabled} />
              </div>
              <Link
                to="/eq"
                className="mt-3 flex items-center justify-between p-3 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] hover:border-[var(--accent)]/40 transition-colors focus-ring"
              >
                <div>
                  <div className="font-medium text-sm text-[var(--text-primary)]">调节均衡器</div>
                  <div className="text-xs text-[var(--text-tertiary)]">预设 / 自定义曲线 / 保存个人预设</div>
                </div>
                <ChevronRight className="w-4 h-4 text-[var(--text-tertiary)]" />
              </Link>
            </div>

            {/* 后台播放设置 */}
            <div className="yinliu-card">
              <h3 className="font-semibold mb-1 text-[var(--text-primary)]">后台播放</h3>
              <p className="text-xs text-[var(--text-tertiary)] mb-4">控制应用切到后台或被其他应用打断时的行为</p>
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
                  <div>
                    <div className="font-medium text-sm text-[var(--text-primary)]">自动续播</div>
                    <div className="text-xs text-[var(--text-tertiary)]">被其他应用打断后恢复时自动继续播放</div>
                  </div>
                  <Toggle on={autoResumeOnAudioFocus} onChange={setAutoResumeOnAudioFocus} />
                </div>
                <div className="flex items-center justify-between p-3 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
                  <div>
                    <div className="font-medium text-sm text-[var(--text-primary)]">通知栏控制</div>
                    <div className="text-xs text-[var(--text-tertiary)]">在系统通知栏 / 锁屏显示播放控制</div>
                  </div>
                  <Toggle on={enableNotificationControls} onChange={setEnableNotificationControls} />
                </div>
                <div className="flex items-center justify-between p-3 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
                  <div>
                    <div className="font-medium text-sm text-[var(--text-primary)]">暂停后隐藏通知</div>
                    <div className="text-xs text-[var(--text-tertiary)]">暂停播放后自动从通知栏移除媒体卡片</div>
                  </div>
                  <Toggle on={dismissNotificationOnPause} onChange={setDismissNotificationOnPause} />
                </div>
                <div className="flex items-center justify-between p-3 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
                  <div>
                    <div className="font-medium text-sm text-[var(--text-primary)]">桌面悬浮歌词</div>
                    <div className="text-xs text-[var(--text-tertiary)]">在 Android 桌面显示可拖动的悬浮歌词窗（需授权悬浮窗权限）</div>
                  </div>
                  <Toggle on={enableFloatingLyrics} onChange={setFloatingLyricsEnabled} />
                </div>
              </div>
            </div>

            {/* 睡眠定时 */}
            <div className="yinliu-card">
              <h3 className="font-semibold mb-1 text-[var(--text-primary)] flex items-center gap-2">
                <Moon className="w-4 h-4" />
                睡眠定时
              </h3>
              <p className="text-xs text-[var(--text-tertiary)] mb-4">设定时间后自动渐弱音量并暂停播放</p>
              <button
                onClick={() => setShowSleepTimer(true)}
                className="w-full flex items-center justify-between p-4 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] hover:border-[var(--accent)]/30 transition-colors focus-ring"
              >
                <span className="text-sm text-[var(--text-primary)] flex items-center gap-2">
                  <Moon className="w-4 h-4 text-[var(--text-tertiary)]" />
                  {sleepTimerActive
                    ? sleepTimerMode === 'duration'
                      ? `睡眠定时中 · 剩余 ${formatSleepTimerRemaining(remainingSeconds)}`
                      : '睡眠定时中 · 播完当前曲暂停'
                    : '未开启'}
                </span>
                <span className="text-xs text-[var(--accent)]">
                  {sleepTimerActive ? '管理' : '开启'}
                </span>
              </button>
            </div>

            {/* 下载设置 */}
            <div className="yinliu-card">
              <h3 className="font-semibold mb-4 text-[var(--text-primary)]">下载设置</h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--text-primary)]">默认下载音质</span>
                  <SettingsSelect
                    value={downloadQuality}
                    options={QUALITY_OPTIONS.map((q) => ({ value: q.value, label: q.label }))}
                    onChange={(v) => setDownloadQuality(v)}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--text-primary)]">最大并发下载数</span>
                  <SettingsSelect
                    value={maxConcurrentDownloads}
                    options={[1, 2, 3, 5].map((n) => ({ value: n, label: String(n) }))}
                    onChange={(v) => setMaxConcurrentDownloads(v)}
                  />
                </div>
                {/* C9：下载完成通知授权入口（仅 Capacitor 原生端显示；授权由本按钮用户手势触发） */}
                {isNativeApp && (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-col">
                      <span className="text-sm text-[var(--text-primary)]">下载完成通知</span>
                      <span className="text-[11px] text-[var(--text-tertiary)]">
                        下载完成/失败时发送系统通知 · {NOTIFY_PERM_LABEL[notifyPerm] ?? notifyPerm}
                      </span>
                    </div>
                    {notifyPerm === 'granted' ? (
                      <span className="text-xs text-[var(--text-tertiary)] flex-shrink-0">已开启</span>
                    ) : (
                      <button
                        onClick={handleRequestNotifyPerm}
                        className="px-3 py-1.5 rounded-xl text-xs bg-[var(--accent)] text-white hover:opacity-90 transition-opacity flex-shrink-0"
                      >
                        {notifyPerm === 'denied' ? '去授权' : '开启'}
                      </button>
                    )}
                  </div>
                )}
                {/* v23 修复走查 #11：下载目录改为可编辑（应用私有数据目录下的相对路径，保存后立即生效） */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-[var(--text-primary)]">下载目录</span>
                    <div className="flex gap-2">
                      <input
                        className="yinliu-input text-xs py-1.5 w-44 font-mono text-right"
                        value={downloadDirDraft}
                        placeholder="如 yinliu/downloads"
                        onChange={(e) => setDownloadDirDraft(e.target.value)}
                      />
                      <button
                        onClick={() => setDownloadDir(downloadDirDraft)}
                        disabled={downloadDirDraft.trim() === downloadDir || !downloadDirDraft.trim()}
                        className="px-3 py-1.5 rounded-xl text-xs bg-[var(--accent)] text-white disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity flex-shrink-0"
                      >
                        保存
                      </button>
                    </div>
                  </div>
                  <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">
                    相对于应用私有数据目录；修改后新下载任务立即使用新目录，已下载文件不受影响
                  </p>
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
          <>
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

            {/* 调试模式（about tab） */}
            <div className="yinliu-card">
              <h3 className="font-semibold mb-1 text-[var(--text-primary)] flex items-center gap-2">
                <Bug className="w-4 h-4" />
                调试模式
              </h3>
              <p className="text-xs text-[var(--text-tertiary)] mb-4">
                开启后记录点击、导航、网络、播放、下载等事件日志，仅本地存储，不上传
              </p>
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
                  <div>
                    <div className="font-medium text-sm text-[var(--text-primary)]">启用调试日志</div>
                    <div className="text-xs text-[var(--text-tertiary)]">记录所有操作和事件到本地日志</div>
                  </div>
                  <Toggle on={debugMode} onChange={setDebugMode} />
                </div>
                {debugMode && (
                  <>
                    <Link
                      to="/debug"
                      className="block w-full p-3 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] hover:border-[var(--accent)]/30 transition-colors focus-ring text-sm text-[var(--text-primary)] flex items-center gap-2"
                    >
                      <Bug className="w-4 h-4 text-[var(--text-tertiary)]" />
                      查看调试日志
                      <span className="ml-auto text-xs text-[var(--text-tertiary)]">{debugLogger.getCount()} 条</span>
                    </Link>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleExportLogs('txt')}
                        className="flex-1 p-3 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] hover:border-[var(--accent)]/30 transition-colors focus-ring text-sm text-[var(--text-primary)] flex items-center justify-center gap-2"
                      >
                        <FileText className="w-4 h-4 text-[var(--text-tertiary)]" />
                        导出 .txt
                      </button>
                      <button
                        onClick={() => handleExportLogs('md')}
                        className="flex-1 p-3 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] hover:border-[var(--accent)]/30 transition-colors focus-ring text-sm text-[var(--text-primary)] flex items-center justify-center gap-2"
                      >
                        <Download className="w-4 h-4 text-[var(--text-tertiary)]" />
                        导出 .md
                      </button>
                    </div>
                    <button
                      onClick={handleClearLogs}
                      className="w-full p-3 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] hover:border-red-500/30 transition-colors focus-ring text-sm text-red-500 flex items-center justify-center gap-2"
                    >
                      <Trash2 className="w-4 h-4" />
                      清空调试日志
                    </button>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* P2 修复：统一二次确认弹窗 */}
      <ConfirmDialog
        open={!!confirmRequest}
        title={confirmRequest?.title || ''}
        message={confirmRequest?.message || ''}
        confirmText={confirmRequest?.confirmText}
        onConfirm={() => {
          confirmRequest?.onConfirm();
          setConfirmRequest(null);
        }}
        onCancel={() => setConfirmRequest(null)}
      />
    </div>
  );
}
