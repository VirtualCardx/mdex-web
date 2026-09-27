/**
 * 上传区域：点击选择文件，也可以整页拖拽（拖拽事件统一由列表页处理并传入 `active`）。
 *
 * 这里刻意**不**挂 drop 处理器：本区域位于列表页内部，若两边都处理 drop，
 * 事件冒泡会让同一个文件被上传两次。
 */

import { useRef } from "react";

interface UploadDropzoneProps {
  onFiles: (files: File[]) => void;
  /** 由外层整页拖拽控制的激活态。 */
  active?: boolean;
  disabled?: boolean;
  uploading?: boolean;
  /** 0~1；为 null 表示未知进度。 */
  progress?: number | null;
}

export default function UploadDropzone({
  onFiles,
  active = false,
  disabled = false,
  uploading = false,
  progress = null,
}: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-7 text-center transition-colors ${
        active ? "border-accent bg-accent/10" : "border-line bg-panel"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".mdex,.zip,application/zip"
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // 重置，保证连续选择同一个文件也能触发 change
          event.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />

      {uploading ? (
        <>
          <p className="text-sm text-fg">正在上传…</p>
          <div className="h-1.5 w-56 overflow-hidden rounded-full bg-raised">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200"
              style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
            />
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-fg">
            把 <code className="font-mono text-accent">.mdex</code> 文件拖到页面任意位置
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-fg transition-colors hover:bg-raised disabled:opacity-40"
          >
            选择文件
          </button>
          <p className="text-xs text-muted">支持 .mdex（或任意 .zip 归档），单个文件上限 32MB</p>
        </>
      )}
    </div>
  );
}
