import { useEffect, useState, useMemo } from 'react';
import { useDownloadStore } from '../shared/store/downloadStore';
import { downloadEngine } from '../core/download';
import { PLATFORM_DISPLAY_NAMES } from '../core/platformPriority';
import { playerEngine } from '../core/player';
import { usePlayerStore } from '../shared/store/playerStore';
import type { PlayerTrack } from '../core/player';
import type { DownloadTask } from '../core/types';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec: number): string {
  return formatBytes(bytesPerSec) + '/s';
}

/* ========== 通用二次确认弹窗（v23 修复走查 #3：删除/清空无确认） ========== */
function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确认',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} style={{ animation: 'fadeIn 0.15s ease-out' }} />
      <div className="relative w-full max-w-xs rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border)] p-5 shadow-xl" style={{ animation: 'page-enter 0.2s ease-out both' }}>
        <h3 className="font-semibold text-[var(--text-primary)] mb-1.5">{title}</h3>
        <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-5">{message}</p>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="px-4 py-2 rounded-xl text-sm bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)] transition-colors">
            取消
          </button>
          <button onClick={onConfirm} className="px-4 py-2 rounded-xl text-sm bg-red-500 text-white hover:bg-red-600 transition-colors">
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: DownloadTask['status'] }) {
  const map: Record<string, { text: string; className: string }> = {
    pending: { text: '等待中', className: 'bg-yellow-500/20 text-yellow-600' },
    downloading: { text: '下载中', className: 'bg-blue-500/20 text-blue-600' },
    paused: { text: '已暂停', className: 'bg-gray-500/20 text-gray-600' },
    completed: { text: '已完成', className: 'bg-green-500/20 text-green-600' },
    failed: { text: '失败', className: 'bg-red-500/20 text-red-600' },
  };
  const s = map[status] || map.pending;
  return <span className={`text-xs px-2 py-0.5 rounded-full ${s.className}`}>{s.text}</span>;
}

/* ========== 下载队列单条卡片 ========== */
function QueueTaskCard({ task }: { task: DownloadTask }) {
  const handlePause = (taskId: string) => {
    downloadEngine.pauseDownload(taskId);
  };
  const handleResume = (taskId: string) => {
    downloadEngine.resumeDownload(taskId);
  };
  const handleCancel = (taskId: string) => {
    downloadEngine.cancelDownload(taskId);
    useDownloadStore.getState().removeTask(taskId);
  };

  return (
    <div className="p-4 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)]">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <StatusBadge status={task.status} />
          <div className="min-w-0">
            <span className="font-medium truncate block">
              {task.title || task.songId}
              {task.artist ? <span className="text-[var(--text-tertiary)] font-normal"> · {task.artist}</span> : null}
            </span>
            <span className="text-xs text-[var(--text-tertiary)]">
              {task.quality} · {PLATFORM_DISPLAY_NAMES[task.sourceId] || task.sourceId}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {task.status === 'downloading' && (
            <button
              onClick={() => handlePause(task.id)}
              className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
              title="暂停"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            </button>
          )}
          {(task.status === 'paused' || task.status === 'failed') && (
            <button
              onClick={() => handleResume(task.id)}
              className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
              title={task.status === 'failed' ? '重试' : '继续'}
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            </button>
          )}
          {task.status === 'failed' && (
            <button
              onClick={() => handleResume(task.id)}
              className="text-xs px-2.5 py-1 rounded-lg bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors"
              title="重试下载"
            >
              重试
            </button>
          )}
          <button
            onClick={() => handleCancel(task.id)}
            className="p-1.5 rounded-lg hover:bg-red-500/10 text-red-500"
            title="删除"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
        </div>
      </div>

      {/* v23 修复走查 #14：音源不支持 Range 时无法统计真实进度，显示不确定态动画而不是 0% 假死 */}
      {task.indeterminate && task.status === 'downloading' ? (
        <div className="w-full h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden mb-2">
          <div className="h-full w-1/3 rounded-full bg-[var(--accent)] animate-indeterminate" />
        </div>
      ) : (
        <div className="w-full h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden mb-2">
          <div
            className={`h-full rounded-full transition-all ${
              task.status === 'failed' ? 'bg-red-500' : 'bg-[var(--accent)]'
            }`}
            style={{ width: `${(task.progress || 0) * 100}%` }}
          />
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-[var(--text-tertiary)]">
        <span>
          {task.status === 'downloading' && task.downloadedSize && task.downloadedSize > 0
            ? task.totalSize > 0
              ? `${formatBytes(task.downloadedSize)} / ${formatBytes(task.totalSize)}`
              : `已下载 ${formatBytes(task.downloadedSize)}`
            : task.totalSize > 0
              ? `${formatBytes(task.totalSize * (task.progress || 0))} / ${formatBytes(task.totalSize)}`
              : task.status === 'completed' && task.filePath
                ? '已保存到本地'
                : '等待开始...'}
        </span>
        <span>
          {task.status === 'downloading' && task.speed && task.speed > 0
            ? formatSpeed(task.speed)
            : task.status === 'completed'
              ? '100%'
              : `${Math.round((task.progress || 0) * 100)}%`}
        </span>
      </div>

      {task.errorMessage && (
        <div className="mt-2 text-xs text-red-500">{task.errorMessage}</div>
      )}
    </div>
  );
}

/* ========== 已下载 · 按源分组卡片 ========== */
function CompletedSourceSection({
  sourceId,
  tasks,
}: {
  sourceId: string;
  tasks: DownloadTask[];
}) {
  const [expanded, setExpanded] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<DownloadTask | null>(null);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const sourceName = PLATFORM_DISPLAY_NAMES[sourceId] || sourceId;
  const totalSize = tasks.reduce((sum, t) => sum + (t.totalSize || 0), 0);

  // v23 修复走查 #4：已下载歌曲接入播放器主链路（PlayerBar / 队列 / 通知栏），不再 new Audio 绕开播放器。
  // 走 sourceId='local' 分支由 PlayerEngine 直接读取本地文件，队列设为该源下全部已完成歌曲。
  const handlePlay = async (task: DownloadTask) => {
    if (!task.filePath) return;
    const tracks: PlayerTrack[] = tasks
      .filter((t) => t.filePath)
      .map((t) => ({
        id: t.id,
        title: t.title || t.songId,
        artist: t.artist,
        sourceId: 'local',
        sourceSongId: t.filePath!,
        uri: `file://${t.filePath}`,
      }));
    if (tracks.length === 0) return;
    const startIndex = Math.max(0, tracks.findIndex((t) => t.id === task.id));
    usePlayerStore.getState().setQueue(tracks, startIndex);
    try {
      await playerEngine.playTrack(tracks[startIndex]);
    } catch (err) {
      console.error('[DownloadPage] play local track failed:', err);
    }
  };

  // v23 修复走查 #3：删除前二次确认，避免误触直接物理删除文件
  const handleDelete = async (taskId: string) => {
    await downloadEngine.cancelDownload(taskId);
    useDownloadStore.getState().removeTask(taskId);
    setDeleteTarget(null);
  };

  return (
    <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] overflow-hidden">
      {/* 源头部 */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-[var(--bg-tertiary)]/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="font-medium">{sourceName}</span>
          <span className="text-xs text-[var(--text-tertiary)] bg-[var(--bg-tertiary)] px-2 py-0.5 rounded-full">
            {tasks.length} 首 · {formatBytes(totalSize)}
          </span>
        </div>
        <svg
          className={`w-4 h-4 text-[var(--text-tertiary)] transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" />
        </svg>
      </button>

      {/* 任务列表 */}
      {expanded && (
        <div className="border-t border-[var(--border)]">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="flex items-center justify-between px-4 py-2.5 hover:bg-[var(--bg-tertiary)]/30 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <button
                  onClick={() => handlePlay(task)}
                  className={`p-1.5 rounded-full shrink-0 transition-colors ${
                    currentTrack && currentTrack.sourceSongId === task.filePath
                      ? 'bg-green-500 text-white'
                      : 'bg-[var(--accent)] text-white hover:opacity-90'
                  }`}
                  title={currentTrack && currentTrack.sourceSongId === task.filePath ? '正在播放' : '播放'}
                >
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </button>
                <div className="min-w-0">
                  <span className={`text-sm font-medium truncate block ${currentTrack && currentTrack.sourceSongId === task.filePath ? 'text-[var(--accent)]' : ''}`}>
                    {task.title || task.songId}
                    {task.artist ? <span className="text-[var(--text-tertiary)] font-normal"> · {task.artist}</span> : null}
                  </span>
                  <span className="text-xs text-[var(--text-tertiary)]">
                    {task.quality} · {formatBytes(task.totalSize || 0)}
                  </span>
                </div>
              </div>
              <button
                onClick={() => setDeleteTarget(task)}
                className="p-1.5 rounded-lg hover:bg-red-500/10 text-red-500 shrink-0"
                title="删除"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除已下载歌曲"
        message={`确定要删除「${deleteTarget?.title || deleteTarget?.songId || ''}」吗？本地文件将被移除，此操作不可恢复。`}
        confirmText="删除"
        onConfirm={() => deleteTarget && handleDelete(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

/* ========== 主页面 ========== */
export default function DownloadPage() {
  const { tasks, queueTasks, completedTasks, completedBySource, clearCompleted } = useDownloadStore();
  const [activeTab, setActiveTab] = useState<'queue' | 'completed'>('queue');
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  useEffect(() => {
    // 同步引擎中的任务到 store
    const engineTasks = downloadEngine.getTasks();
    if (engineTasks.length > 0 && tasks.length === 0) {
      useDownloadStore.getState().setTasks(engineTasks);
    }
  }, []);

  // 按状态分组的队列任务
  const groupedQueue = useMemo(() => {
    const order: DownloadTask['status'][] = ['downloading', 'pending', 'paused', 'failed'];
    const groups: Record<string, DownloadTask[]> = {};
    for (const status of order) {
      const list = queueTasks.filter((t) => t.status === status);
      if (list.length > 0) groups[status] = list;
    }
    return groups;
  }, [queueTasks]);

  // v23 修复走查 #3：清空已下载前二次确认
  const handleClearCompleted = async () => {
    await downloadEngine.clearCompleted();
    clearCompleted();
    setShowClearConfirm(false);
  };

  const sourceIds = Object.keys(completedBySource).sort();

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">下载管理</h1>
        <span className="text-sm text-[var(--text-secondary)]">
          {completedTasks.length} / {tasks.length} 已完成
        </span>
      </div>

      {/* Tab 切换 */}
      <div className="flex items-center gap-1 mb-6 p-1 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)]">
        <button
          onClick={() => setActiveTab('queue')}
          className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${
            activeTab === 'queue'
              ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }`}
        >
          下载队列 {queueTasks.length > 0 ? `(${queueTasks.length})` : ''}
        </button>
        <button
          onClick={() => setActiveTab('completed')}
          className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${
            activeTab === 'completed'
              ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }`}
        >
          已下载 {completedTasks.length > 0 ? `(${completedTasks.length})` : ''}
        </button>
      </div>

      {/* ===== 下载队列 Tab ===== */}
      {activeTab === 'queue' && (
        <>
          {queueTasks.length === 0 && (
            <div className="text-center py-16 text-[var(--text-tertiary)]">
              暂无下载任务，在搜索结果中点击下载按钮开始下载
            </div>
          )}

          <div className="space-y-3">
            {Object.entries(groupedQueue).map(([status, list]) => (
              <div key={status}>
                <div className="flex items-center gap-2 mb-2 px-1">
                  <StatusBadge status={status as DownloadTask['status']} />
                  <span className="text-xs text-[var(--text-tertiary)]">{list.length} 项</span>
                </div>
                <div className="space-y-2">
                  {list.map((task) => (
                    <QueueTaskCard key={task.id} task={task} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ===== 已下载 Tab ===== */}
      {activeTab === 'completed' && (
        <>
          {completedTasks.length === 0 && (
            <div className="text-center py-16 text-[var(--text-tertiary)]">
              暂无已下载文件，下载完成后会在此归档
            </div>
          )}

          {completedTasks.length > 0 && (
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm text-[var(--text-secondary)]">
                共 {sourceIds.length} 个来源 · {completedTasks.length} 首
              </span>
              <button
                onClick={() => setShowClearConfirm(true)}
                className="text-xs px-3 py-1.5 rounded-lg border border-red-500/30 text-red-500 hover:bg-red-500/10 transition-colors"
              >
                清空已下载
              </button>
            </div>
          )}

          <div className="space-y-3">
            {sourceIds.map((sid) => (
              <CompletedSourceSection
                key={sid}
                sourceId={sid}
                tasks={completedBySource[sid]}
              />
            ))}
          </div>

          <ConfirmDialog
            open={showClearConfirm}
            title="清空已下载"
            message={`确定要清空全部 ${completedTasks.length} 首已下载歌曲吗？所有本地文件将被移除，此操作不可恢复。`}
            confirmText="全部删除"
            onConfirm={handleClearCompleted}
            onCancel={() => setShowClearConfirm(false)}
          />
        </>
      )}
    </div>
  );
}
