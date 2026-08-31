import { useState, useEffect, useCallback } from 'react';
import { Download, Pause, Play, RotateCcw, Trash2, Music } from 'lucide-react';
import { downloadEngine } from '../core/download';
import type { DownloadQueueItem } from '../core/download';

export default function DownloadPage() {
  const [tasks, setTasks] = useState<DownloadQueueItem[]>([]);
  const [stats, setStats] = useState(downloadEngine.getStats());

  const refreshTasks = useCallback(() => {
    setTasks(downloadEngine.getAllTasks());
    setStats(downloadEngine.getStats());
  }, []);

  useEffect(() => {
    const unsubProgress = downloadEngine.on('progress', refreshTasks);
    const unsubStatus = downloadEngine.on('statusChange', refreshTasks);
    const unsubComplete = downloadEngine.on('complete', refreshTasks);
    const unsubError = downloadEngine.on('error', refreshTasks);

    refreshTasks();

    return () => {
      unsubProgress();
      unsubStatus();
      unsubComplete();
      unsubError();
    };
  }, [refreshTasks]);

  const formatSize = (bytes?: number) => {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  };

  const formatSpeed = (bps?: number) => {
    if (!bps) return '0 B/s';
    return `${formatSize(bps)}/s`;
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'pending': return '等待中';
      case 'downloading': return '下载中';
      case 'paused': return '已暂停';
      case 'completed': return '已完成';
      case 'failed': return '失败';
      default: return status;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'downloading': return 'text-[var(--accent)]';
      case 'completed': return 'text-green-500';
      case 'failed': return 'text-red-500';
      case 'paused': return 'text-yellow-500';
      default: return 'text-[var(--text-tertiary)]';
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Download className="w-6 h-6" />
          下载管理
        </h1>
        <div className="flex gap-2">
          <button
            onClick={() => { downloadEngine.clearCompleted(); refreshTasks(); }}
            className="yinliu-btn-secondary text-sm"
          >
            清除已完成
          </button>
          <button
            onClick={() => { downloadEngine.clearFailed(); refreshTasks(); }}
            className="yinliu-btn-secondary text-sm"
          >
            清除失败
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-6">
        {[
          { label: '总计', value: stats.total },
          { label: '等待中', value: stats.pending },
          { label: '下载中', value: stats.downloading },
          { label: '已完成', value: stats.completed },
          { label: '失败', value: stats.failed },
        ].map((s) => (
          <div key={s.label} className="yinliu-card text-center py-3">
            <div className="text-2xl font-bold">{s.value}</div>
            <div className="text-xs text-[var(--text-tertiary)]">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Task List */}
      <div className="space-y-2">
        {tasks.length === 0 && (
          <div className="text-center py-12 text-[var(--text-tertiary)]">
            暂无下载任务
          </div>
        )}

        {tasks.map((task) => (
          <div
            key={task.id}
            className="yinliu-card p-4"
          >
            <div className="flex items-center gap-3 mb-2">
              <Music className="w-5 h-5 text-[var(--text-tertiary)]" />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">
                  {task.title || task.songId}
                  {task.artist && (
                    <span className="text-[var(--text-secondary)] text-sm ml-1">— {task.artist}</span>
                  )}
                  {task.isFallback && (
                    <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-500">
                      兜底
                    </span>
                  )}
                </div>
                {task.localPath && task.status === 'completed' && (
                  <div className="text-xs text-[var(--text-tertiary)] truncate mt-0.5">
                    已保存: {task.localPath.split('/').pop()}
                  </div>
                )}
              </div>
              <div className={`text-sm font-medium ${getStatusColor(task.status)}`}>
                {getStatusText(task.status)}
              </div>
            </div>

            {/* Progress bar */}
            <div className="w-full h-2 bg-[var(--bg-tertiary)] rounded-full mb-2">
              <div
                className={`h-full rounded-full transition-all ${
                  task.status === 'failed' ? 'bg-red-500' :
                  task.status === 'completed' ? 'bg-green-500' :
                  'bg-[var(--accent)]'
                }`}
                style={{ width: `${(task.progress || 0) * 100}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
              <div className="flex gap-3">
                <span>{Math.round((task.progress || 0) * 100)}%</span>
                <span>{formatSize(task.downloadedSize)} / {formatSize(task.fileSize)}</span>
                {task.status === 'downloading' && (
                  <span>{formatSpeed(task.speed)}</span>
                )}
              </div>

              <div className="flex gap-1">
                {task.status === 'downloading' && (
                  <button
                    onClick={() => { downloadEngine.pauseDownload(task.id); refreshTasks(); }}
                    className="p-1.5 rounded hover:bg-[var(--bg-tertiary)]"
                    title="暂停"
                  >
                    <Pause className="w-4 h-4" />
                  </button>
                )}
                {task.status === 'paused' && (
                  <button
                    onClick={() => { downloadEngine.resumeDownload(task.id); refreshTasks(); }}
                    className="p-1.5 rounded hover:bg-[var(--bg-tertiary)]"
                    title="恢复"
                  >
                    <Play className="w-4 h-4" />
                  </button>
                )}
                {task.status === 'failed' && (
                  <button
                    onClick={() => { downloadEngine.retryDownload(task.id); refreshTasks(); }}
                    className="p-1.5 rounded hover:bg-[var(--bg-tertiary)]"
                    title="重试"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                )}
                <button
                  onClick={() => { downloadEngine.cancelDownload(task.id); refreshTasks(); }}
                  className="p-1.5 rounded hover:bg-red-500/20 hover:text-red-500"
                  title="取消"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {task.errorMessage && (
              <div className="text-xs text-red-500 mt-1">{task.errorMessage}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
