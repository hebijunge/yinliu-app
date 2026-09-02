import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Trash2, Download, RefreshCw, ChevronDown, Filter, FileText, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { debugLogger, type DebugLogEntry, type DebugLogCategory, type DebugLogLevel } from '@shared/utils/debugLogger';

const CATEGORY_LABELS: Record<DebugLogCategory, string> = {
  app: '应用',
  navigate: '导航',
  network: '网络',
  player: '播放',
  download: '下载',
  click: '点击',
  init: '初始化',
  streaming: '流式播放',
  sleepTimer: '睡眠定时',
};

const CATEGORY_COLORS: Record<DebugLogCategory, string> = {
  app: 'bg-blue-500/15 text-blue-500',
  navigate: 'bg-purple-500/15 text-purple-500',
  network: 'bg-cyan-500/15 text-cyan-500',
  player: 'bg-green-500/15 text-green-500',
  download: 'bg-orange-500/15 text-orange-500',
  click: 'bg-pink-500/15 text-pink-500',
  init: 'bg-gray-500/15 text-gray-500',
  streaming: 'bg-teal-500/15 text-teal-500',
  sleepTimer: 'bg-indigo-500/15 text-indigo-500',
};

const LEVEL_COLORS: Record<DebugLogLevel, string> = {
  info: 'text-blue-500',
  warn: 'text-yellow-500',
  error: 'text-red-500',
};

export default function DebugLogPage() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<DebugLogEntry[]>([]);
  const [filterCategory, setFilterCategory] = useState<DebugLogCategory | 'all'>('all');
  const [filterLevel, setFilterLevel] = useState<DebugLogLevel | 'all'>('all');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [exportFormat, setExportFormat] = useState<'txt' | 'md'>('txt');
  const [showDeleteMenu, setShowDeleteMenu] = useState(false);
  const intervalRef = useRef<number | null>(null);

  const refresh = () => {
    setEntries(debugLogger.getEntries());
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = window.setInterval(() => {
        refresh();
      }, 1500);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRefresh]);

  const handleClear = () => {
    if (window.confirm('确定要清空所有调试日志吗？此操作不可恢复。')) {
      debugLogger.clear();
      refresh();
    }
  };

  const handleDeleteEntry = (id: string) => {
    if (window.confirm('确定删除这条日志吗？')) {
      debugLogger.deleteEntry(id);
      refresh();
    }
  };

  const handleDeleteByCategory = (category: DebugLogCategory) => {
    const count = entries.filter((e) => e.category === category).length;
    if (count === 0) {
      alert('该类别暂无日志');
      return;
    }
    if (
      window.confirm(
        `确定删除「${CATEGORY_LABELS[category]}」类别的 ${count} 条日志吗？此操作不可恢复。`
      )
    ) {
      const deleted = debugLogger.deleteByCategory(category);
      refresh();
      alert(`已删除 ${deleted} 条日志`);
    }
  };

  const handleExport = () => {
    debugLogger.triggerExport(exportFormat);
  };

  const filteredEntries = entries.filter((entry) => {
    if (filterCategory !== 'all' && entry.category !== filterCategory) return false;
    if (filterLevel !== 'all' && entry.level !== filterLevel) return false;
    return true;
  });

  const formatTime = (timestamp: number) => {
    const d = new Date(timestamp);
    return `${d.getMonth() + 1}-${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
  };

  const categories: Array<DebugLogCategory | 'all'> = ['all', 'app', 'navigate', 'network', 'player', 'download', 'click', 'init', 'streaming', 'sleepTimer'];
  const levels: Array<DebugLogLevel | 'all'> = ['all', 'info', 'warn', 'error'];
  const categoryList: DebugLogCategory[] = ['app', 'navigate', 'network', 'player', 'download', 'click', 'init', 'streaming', 'sleepTimer'];

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/settings')}
            className="p-2 rounded-2xl hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
            aria-label="返回设置"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-2xl font-light text-[var(--text-primary)]">调试日志</h1>
            <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
              共 {entries.length} 条 · 显示 {filteredEntries.length} 条
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`p-2 rounded-2xl transition-colors focus-ring ${
              autoRefresh
                ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
            }`}
            title={autoRefresh ? '自动刷新开启' : '自动刷新关闭'}
            aria-label="切换自动刷新"
          >
            <RefreshCw className={`w-4 h-4 ${autoRefresh ? 'animate-spin' : ''}`} style={autoRefresh ? { animationDuration: '3s' } : {}} />
          </button>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`p-2 rounded-2xl transition-colors focus-ring ${
              showFilters ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
            }`}
            title="筛选"
            aria-label="切换筛选"
          >
            <Filter className="w-4 h-4" />
          </button>
          <div className="relative">
            <button
              onClick={() => setShowDeleteMenu(!showDeleteMenu)}
              className="p-2 rounded-2xl hover:bg-red-500/10 text-red-500 transition-colors focus-ring"
              title="删除"
              aria-label="删除菜单"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            {showDeleteMenu && (
              <div className="absolute right-0 top-full mt-2 w-48 bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-2xl shadow-lg z-50 py-1">
                <div className="px-3 py-2 text-xs text-[var(--text-tertiary)] border-b border-[var(--border-subtle)]">
                  按类别批量删除
                </div>
                {categoryList.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => {
                      handleDeleteByCategory(cat);
                      setShowDeleteMenu(false);
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
                  >
                    {CATEGORY_LABELS[cat]}
                  </button>
                ))}
                <div className="border-t border-[var(--border-subtle)] mt-1 pt-1">
                  <button
                    onClick={() => {
                      handleClear();
                      setShowDeleteMenu(false);
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-red-500 hover:bg-red-500/5 transition-colors"
                  >
                    清空全部日志
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 bg-[var(--bg-tertiary)] rounded-2xl p-0.5">
            <button
              onClick={() => setExportFormat('txt')}
              className={`px-2 py-1.5 rounded-xl text-xs font-medium transition-all ${
                exportFormat === 'txt'
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              .txt
            </button>
            <button
              onClick={() => setExportFormat('md')}
              className={`px-2 py-1.5 rounded-xl text-xs font-medium transition-all ${
                exportFormat === 'md'
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              .md
            </button>
          </div>
          <button
            onClick={handleExport}
            className="p-2 rounded-2xl hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
            title={`导出为 ${exportFormat}`}
            aria-label="导出"
          >
            <Download className="w-4 h-4" />
          </button>
        </div>
      </div>

      {showFilters && (
        <div className="yinliu-card mb-4 space-y-3">
          <div>
            <div className="text-xs text-[var(--text-tertiary)] mb-2">类别</div>
            <div className="flex flex-wrap gap-1.5">
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setFilterCategory(cat)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-all focus-ring ${
                    filterCategory === cat
                      ? 'bg-[var(--accent)] text-white'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)]'
                  }`}
                >
                  {cat === 'all' ? '全部' : CATEGORY_LABELS[cat]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs text-[var(--text-tertiary)] mb-2">级别</div>
            <div className="flex flex-wrap gap-1.5">
              {levels.map((lvl) => (
                <button
                  key={lvl}
                  onClick={() => setFilterLevel(lvl)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-all focus-ring ${
                    filterLevel === lvl
                      ? 'bg-[var(--accent)] text-white'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)]'
                  }`}
                >
                  {lvl === 'all' ? '全部' : lvl.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {filteredEntries.length === 0 ? (
        <div className="yinliu-card text-center py-16">
          <div className="text-[var(--text-tertiary)] text-sm">
            {entries.length === 0 ? '暂无日志' : '没有匹配的日志条目'}
          </div>
          <p className="text-xs text-[var(--text-tertiary)] mt-2">
            开启调试模式后，应用会记录点击、导航、网络请求、播放和下载等事件
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {filteredEntries.map((entry) => (
            <div
              key={entry.id}
              className="p-3 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] hover:border-[var(--accent)]/30 transition-colors group"
            >
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-[10px] font-mono text-[var(--text-tertiary)]">
                  {formatTime(entry.timestamp)}
                </span>
                <span className={`text-[10px] font-semibold ${LEVEL_COLORS[entry.level]}`}>
                  [{entry.level.toUpperCase()}]
                </span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${CATEGORY_COLORS[entry.category]}`}>
                  {CATEGORY_LABELS[entry.category]}
                </span>
                <button
                  onClick={() => handleDeleteEntry(entry.id)}
                  className="ml-auto p-1 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-red-500/10 text-red-500 transition-all"
                  title="删除本条"
                  aria-label="删除本条日志"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div className="text-sm text-[var(--text-primary)] break-words">
                {entry.message}
              </div>
              {entry.details && Object.keys(entry.details).length > 0 && (
                <details className="mt-1.5">
                  <summary className="text-[10px] text-[var(--text-tertiary)] cursor-pointer hover:text-[var(--text-secondary)] flex items-center gap-1 select-none">
                    <ChevronDown className="w-3 h-3" />
                    详情
                  </summary>
                  <pre className="text-[10px] font-mono text-[var(--text-tertiary)] mt-1.5 p-2 rounded-lg bg-[var(--bg-primary)] overflow-x-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(entry.details, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
