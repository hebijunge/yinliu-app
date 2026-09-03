import { create } from 'zustand';
import type { DownloadTask, DownloadStatus } from '@core/types';

interface DownloadStore {
  tasks: DownloadTask[];
  activeTaskId: string | null;

  setTasks: (tasks: DownloadTask[]) => void;
  upsertTask: (task: DownloadTask) => void;
  removeTask: (taskId: string) => void;
  setActiveTask: (taskId: string | null) => void;
  updateTaskStatus: (taskId: string, status: DownloadStatus, updates?: Partial<DownloadTask>) => void;

  // Phase 1: 新增 computed getters & actions
  /** 下载队列任务（非 completed）：pending / downloading / paused / failed */
  queueTasks: DownloadTask[];
  /** 已完成任务 */
  completedTasks: DownloadTask[];
  /** 按源分组的已完成任务 */
  completedBySource: Record<string, DownloadTask[]>;
  /** 清空已完成任务（同步引擎 + store） */
  clearCompleted: () => void;
}

export const useDownloadStore = create<DownloadStore>((set, get) => ({
  tasks: [],
  activeTaskId: null,

  setTasks: (tasks) => set({ tasks }),

  upsertTask: (task) =>
    set((s) => {
      const exists = s.tasks.find((t) => t.id === task.id);
      if (exists) {
        return {
          tasks: s.tasks.map((t) => (t.id === task.id ? { ...t, ...task } : t)),
        };
      }
      return { tasks: [task, ...s.tasks] };
    }),

  removeTask: (taskId) =>
    set((s) => ({
      tasks: s.tasks.filter((t) => t.id !== taskId),
      activeTaskId: s.activeTaskId === taskId ? null : s.activeTaskId,
    })),

  setActiveTask: (taskId) => set({ activeTaskId: taskId }),

  updateTaskStatus: (taskId, status, updates) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, status, ...updates } : t
      ),
    })),

  // --- Phase 1 computed getters ---
  get queueTasks() {
    return get().tasks.filter((t) => t.status !== 'completed');
  },

  get completedTasks() {
    return get().tasks.filter((t) => t.status === 'completed');
  },

  get completedBySource() {
    const completed = get().tasks.filter((t) => t.status === 'completed');
    const grouped: Record<string, DownloadTask[]> = {};
    for (const task of completed) {
      const sid = task.sourceId || 'unknown';
      if (!grouped[sid]) grouped[sid] = [];
      grouped[sid].push(task);
    }
    // 每组内按 createdAt 倒序
    for (const sid of Object.keys(grouped)) {
      grouped[sid].sort((a, b) => b.createdAt - a.createdAt);
    }
    return grouped;
  },

  clearCompleted: () =>
    set((s) => ({
      tasks: s.tasks.filter((t) => t.status !== 'completed'),
      activeTaskId: s.activeTaskId && s.tasks.find((t) => t.id === s.activeTaskId)?.status === 'completed'
        ? null
        : s.activeTaskId,
    })),
}));
