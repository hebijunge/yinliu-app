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
}

export const useDownloadStore = create<DownloadStore>((set) => ({
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
}));
