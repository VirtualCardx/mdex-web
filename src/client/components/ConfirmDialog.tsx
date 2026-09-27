/**
 * 统一的确认/选择对话框。
 *
 * 除了常见的「确认 / 取消」，还支持一个可选的第三动作：编辑页保存遇到 409 冲突时
 * 需要同时给出「重新载入」和「强制覆盖」两条出路。
 */

import type { ReactNode } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 可选的第三个动作（如「重新载入」），渲染在确认按钮左侧。 */
  extraLabel?: string;
  onExtra?: () => void;
  /** 危险操作（删除等）用红色确认按钮。 */
  danger?: boolean;
  /** 操作进行中：禁用全部按钮。 */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** 对话框正文里额外的表单内容（如重命名的输入框）。 */
  children?: ReactNode;
}

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确定",
  cancelLabel = "取消",
  extraLabel,
  onExtra,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={busy ? undefined : onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md rounded-xl border border-line bg-panel p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-heading">{title}</h2>
        {description !== undefined && (
          <div className="mt-2 text-sm leading-relaxed text-soft">{description}</div>
        )}
        {children !== undefined && <div className="mt-3">{children}</div>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {extraLabel !== undefined && onExtra && (
            <button
              type="button"
              disabled={busy}
              onClick={onExtra}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-fg transition-colors hover:bg-raised disabled:opacity-40"
            >
              {extraLabel}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-fg transition-colors hover:bg-raised disabled:opacity-40"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`rounded-md px-3 py-1.5 text-sm font-medium text-white transition-colors disabled:opacity-40 ${
              danger ? "bg-red-600 hover:bg-red-500" : "bg-accent hover:bg-accent/85"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
