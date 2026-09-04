/* 全局唯一的二次确认弹窗组件。
 * P2 修复：此前项目里同时存在自绘 ConfirmDialog（下载页）与原生 window.confirm
 * （设置页/歌单页/调试日志页）两套风格，现统一为这一个自绘组件，全项目共用。 */
export interface ConfirmRequest {
  title: string;
  message: string;
  confirmText?: string;
  /** 用户点击确认后执行的动作 */
  onConfirm: () => void;
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

export default ConfirmDialog;
