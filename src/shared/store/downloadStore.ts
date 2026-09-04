import { create } from 'zustand';
import type { DownloadTask, DownloadStatus } from '@core/types';

interface DownloadStore {
  tasks: DownloadTask[];
  activeTaskId: string | null;
  /** E1: 是否存在因断网自动暂停、等待恢复网络后继续的任务 */
  offlinePaused: boolean;

  setTasks: (tasks: DownloadTask[]) => void;
  upsertTask: (task: DownloadTask) => void;
  removeTask: (taskId: string) => void;
  setActiveTask: (taskId: string | null) => void;
  updateTaskStatus: (taskId: string, status: DownloadStatus, updates?: Partial<DownloadTask>) => void;
  setOfflinePaused: (v: boolean) => void;

  /** 清空已完成任务（同步引擎 + store） */
  clearCompleted: () => void;
}

export const useDownloadStore = create<DownloadStore>((set, get) => ({
  tasks: [],
  activeTaskId: null,
  offlinePaused: false,

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

  setOfflinePaused: (v) => set({ offlinePaused: v }),

  updateTaskStatus: (taskId, status, updates) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, status, ...updates } : t
      ),
    })),

  clearCompleted: () =>
    set((s) => ({
      tasks: s.tasks.filter((t) => t.status !== 'completed'),
      activeTaskId: s.activeTaskId && s.tasks.find((t) => t.id === s.activeTaskId)?.status === 'completed'
        ? null
        : s.activeTaskId,
    })),
}));

// === A-P0-3: 派生数据改纯选择器 ===
// 旧实现把 getter 写在 create() 的 state 对象里：zustand 的 set() 走浅合并（Object.assign 展开
// 属性值），getter 在第一次 set 后被固化成静态快照，任务状态变化时不再重算——下载页
// 队列/已下载 Tab 因此不刷新。改为纯函数选择器，由组件用 useMemo 从 tasks 派生。

/** 下载队列任务（非 completed）：pending / downloading / paused / failed */
export function selectQueueTasks(tasks: DownloadTask[]): DownloadTask[] {
  return tasks.filter((t) => t.status !== 'completed');
}

/** 已完成任务 */
export function selectCompletedTasks(tasks: DownloadTask[]): DownloadTask[] {
  return tasks.filter((t) => t.status === 'completed');
}

/** 按源分组的已完成任务（组内按 createdAt 倒序） */
export function selectCompletedBySource(tasks: DownloadTask[]): Record<string, DownloadTask[]> {
  const grouped: Record<string, DownloadTask[]> = {};
  for (const task of selectCompletedTasks(tasks)) {
    const sid = task.sourceId || 'unknown';
    if (!grouped[sid]) grouped[sid] = [];
    grouped[sid].push(task);
  }
  for (const sid of Object.keys(grouped)) {
    grouped[sid].sort((a, b) => b.createdAt - a.createdAt);
  }
  return grouped;
}
