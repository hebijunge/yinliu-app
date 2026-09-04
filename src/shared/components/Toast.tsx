import { useEffect, useState, useCallback } from 'react';
import { X, Info, AlertCircle, CheckCircle2 } from 'lucide-react';
import { create } from 'zustand';

/**
 * 全局轻量 Toast（v13）
 * 用途：取链降级过程对用户可见的反馈（playerEngine 首选源失败 → 自动降级到下一平台时弹一条）
 * 设计目标：
 * 1. 不引入新依赖，复用 lucide-react + zustand（项目已有）
 * 2. 失败降级链用 info（蓝色）级；真正的不可恢复错误用 error 级
 * 3. 默认 3 秒自动消失（error 级延长到 5 秒，给用户足够阅读时间），最多同时展示 3 条
 * 4. v23：位置从右上角改到底部居中——移动端拇指可达区，符合移动端 Toast 惯例
 */

export type ToastType = 'info' | 'success' | 'error';

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  description?: string;
  /** 多少毫秒后自动消失；0 表示不自动消失 */
  duration: number;
}

interface ToastState {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, 'id' | 'duration'> & { duration?: number }) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

let _seq = 0;
const nextId = () => `t_${Date.now()}_${++_seq}`;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = nextId();
    const item: ToastItem = {
      id,
      duration: t.duration ?? (t.type === 'error' ? 5000 : 3000),
      message: t.message,
      description: t.description,
      type: t.type,
    };
    // D9 修复：容量满时优先淘汰最旧的非 error 项——
    // 旧实现 slice(-3) 会把尚在展示期的 error 提示被后续 info/success 立刻挤掉
    set((s) => {
      let list: ToastItem[] = [...s.toasts, item];
      while (list.length > 3) {
        const oldestNonError = list.findIndex((x) => x.type !== 'error');
        const removeAt = oldestNonError === -1 ? 0 : oldestNonError;
        list = list.filter((_, i) => i !== removeAt);
      }
      return { toasts: list };
    });
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/** 便捷调用：组件外也能用 */
export const toast = {
  info: (message: string, description?: string) =>
    useToastStore.getState().push({ type: 'info', message, description }),
  success: (message: string, description?: string) =>
    useToastStore.getState().push({ type: 'success', message, description }),
  error: (message: string, description?: string) =>
    useToastStore.getState().push({ type: 'error', message, description }),
};

const ICON_MAP: Record<ToastType, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
};

const COLOR_MAP: Record<ToastType, string> = {
  info: 'bg-[var(--accent)]/10 border-[var(--accent)]/30 text-[var(--accent)]',
  success: 'bg-green-500/10 border-green-500/30 text-green-600 dark:text-green-400',
  error: 'bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400',
};

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  const Icon = ICON_MAP[item.type];

  useEffect(() => {
    if (item.duration <= 0) return;
    const tm = window.setTimeout(() => onDismiss(item.id), item.duration);
    return () => window.clearTimeout(tm);
  }, [item.id, item.duration, onDismiss]);

  return (
    <div
      className={`pointer-events-auto flex items-start gap-2.5 px-3.5 py-2.5 rounded-2xl border shadow-lg backdrop-blur-md ${COLOR_MAP[item.type]}`}
      role="status"
    >
      <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium leading-snug">{item.message}</div>
        {item.description && (
          <div className="text-xs opacity-80 mt-0.5 leading-snug">{item.description}</div>
        )}
      </div>
      <button
        onClick={() => onDismiss(item.id)}
        className="opacity-60 hover:opacity-100 transition-opacity flex-shrink-0"
        aria-label="关闭"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/** Toast 容器：放在 Layout 顶层，底部居中（避开 PlayerBar / 底部导航） */
export default function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const onDismiss = useCallback((id: string) => dismiss(id), [dismiss]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[200] flex flex-col gap-2 max-w-sm w-[calc(100%-2rem)] sm:w-auto pointer-events-none">
      {toasts.map((t) => (
        <ToastCard key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
