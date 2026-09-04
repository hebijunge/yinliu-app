import { useState } from 'react';
import { toast } from '@shared/components/Toast';

/* 全局唯一的二次确认弹窗组件。
 * P2 修复：此前项目里同时存在自绘 ConfirmDialog（下载页）与原生 window.confirm
 * （设置页/歌单页/调试日志页）两套风格，现统一为这一个自绘组件，全项目共用。
 * D7 修复：onConfirm 支持异步——执行期间确认按钮进入 pending 态防重复点击；
 * 异步失败时 toast 提示并关闭弹窗（不卡死弹窗），同步调用完成后立即关闭。 */
export interface ConfirmRequest {
  title: string;
  message: string;
  confirmText?: string;
  /** 用户点击确认后执行的动作（支持异步；抛错时 toast 提示，弹窗不卡死） */
  onConfirm: () => void | Promise<void>;
}

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
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState(false);

  if (!open) return null;

  const handleConfirm = async () => {
    if (pending) return;
    let ret: void | Promise<void>;
    try {
      ret = onConfirm();
    } catch (err) {
      toast.error('操作失败', err instanceof Error ? err.message : '请稍后重试');
      onCancel();
      return;
    }
    if (ret && typeof (ret as Promise<void>).then === 'function') {
      setPending(true);
      try {
        await ret;
      } catch (err) {
        toast.error('操作失败', err instanceof Error ? err.message : '请稍后重试');
      } finally {
        setPending(false);
        // 成功或失败都关闭弹窗：失败由 toast 告知，弹窗不卡死
        onCancel();
      }
    } else {
      onCancel();
    }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={pending ? undefined : onCancel} style={{ animation: 'fadeIn 0.15s ease-out' }} />
      <div className="relative w-full max-w-xs rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border)] p-5 shadow-xl" style={{ animation: 'page-enter 0.2s ease-out both' }}>
        <h3 className="font-semibold text-[var(--text-primary)] mb-1.5">{title}</h3>
        <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-5">{message}</p>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            disabled={pending}
            className="px-4 py-2 rounded-xl text-sm bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)] transition-colors disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={() => void handleConfirm()}
            disabled={pending}
            className="px-4 py-2 rounded-xl text-sm bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-60"
          >
            {pending ? '处理中…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
