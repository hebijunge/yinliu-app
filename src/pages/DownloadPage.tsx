import { useEffect } from 'react';
import { useDownloadStore } from '../shared/store/downloadStore';
import { downloadEngine } from '../core/download';
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

export default function DownloadPage() {
  const { tasks } = useDownloadStore();

  useEffect(() => {
    // 同步引擎中的任务到 store
    const engineTasks = downloadEngine.getTasks();
    if (engineTasks.length > 0 && tasks.length === 0) {
      useDownloadStore.getState().setTasks(engineTasks);
    }
  }, []);

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
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">下载管理</h1>
        <span className="text-sm text-[var(--text-secondary)]">
          {tasks.filter((t) => t.status === 'completed').length} / {tasks.length} 已完成
        </span>
      </div>

      {tasks.length === 0 && (
        <div className="text-center py-16 text-[var(--text-tertiary)]">
          暂无下载任务，在搜索结果中点击下载按钮开始下载
        </div>
      )}

      <div className="space-y-3">
        {tasks.map((task) => (
          <div
            key={task.id}
            className="p-4 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)]"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <StatusBadge status={task.status} />
                <span className="font-medium">{task.songId}</span>
                <span className="text-xs text-[var(--text-tertiary)]">
                  {task.quality} · {task.sourceId}
                </span>
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
                {task.status === 'paused' && (
                  <button
                    onClick={() => handleResume(task.id)}
                    className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                    title="继续"
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
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

            {/* Progress bar */}
            <div className="w-full h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden mb-2">
              <div
                className={`h-full rounded-full transition-all ${
                  task.status === 'failed' ? 'bg-red-500' : 'bg-[var(--accent)]'
                }`}
                style={{ width: `${(task.progress || 0) * 100}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-xs text-[var(--text-tertiary)]">
              <span>
                {task.totalSize > 0
                  ? `${formatBytes(task.totalSize * (task.progress || 0))} / ${formatBytes(task.totalSize)}`
                  : task.status === 'completed' && task.filePath
                    ? '已保存到本地'
                    : '计算中...'}
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
        ))}
      </div>
    </div>
  );
}
