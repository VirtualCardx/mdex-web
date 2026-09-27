/**
 * 归档资源面板：列出 `assets/**`，提供缩略图与「插入 / 改名 / 删除」。
 *
 * 改名时用 `sanitizeStem` 做实时预览——资源 key 强制 ASCII 小写是刻意的
 * （见 `shared/assetKey.ts` 的说明），先把结果展示出来，用户就不会对
 * 「中文名变成了 asset」感到意外。
 */

import { useState } from "react";

import { sanitizeStem } from "../../shared/assetKey";
import { mimeFor } from "../../shared/mime";
import ConfirmDialog from "./ConfirmDialog";

interface AssetPanelProps {
  keys: string[];
  /** key → 可显示的 URL（编辑页是 blob URL）。 */
  url: (key: string) => string | null;
  onInsert: (key: string) => void;
  onRename: (key: string, nextName: string) => void;
  onDelete: (key: string) => void;
  disabled?: boolean;
}

/** `assets/foo.bar.png` → `bar.png`。 */
function basename(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

function extensionOf(key: string): string {
  const name = basename(key);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1);
}

export default function AssetPanel({
  keys,
  url,
  onInsert,
  onRename,
  onDelete,
  disabled = false,
}: AssetPanelProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const startRename = (key: string) => {
    const ext = extensionOf(key);
    const name = basename(key);
    setDraft(ext ? name.slice(0, name.length - ext.length - 1) : name);
    setRenaming(key);
  };

  const commitRename = () => {
    if (renaming === null) return;
    const next = draft.trim();
    if (next) onRename(renaming, next);
    setRenaming(null);
  };

  const previewKey = (key: string): string => {
    const ext = extensionOf(key) || "bin";
    return `assets/${sanitizeStem(draft)}.${ext}`;
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-xs font-semibold text-heading">资源</span>
        <span className="text-xs text-muted">{keys.length} 个</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {keys.length === 0 && (
          <p className="px-1 py-4 text-xs leading-relaxed text-muted">
            还没有资源。把图片直接粘贴到编辑器里即可作为资源写入归档。
          </p>
        )}

        <ul className="space-y-1.5">
          {keys.map((key) => {
            const isImage = mimeFor(key).startsWith("image/");
            const src = url(key);
            return (
              <li key={key} className="rounded-lg border border-line bg-raised/40 p-2">
                {renaming === key ? (
                  <div className="space-y-1.5">
                    <input
                      autoFocus
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitRename();
                        if (event.key === "Escape") setRenaming(null);
                      }}
                      className="w-full rounded-md border border-line bg-bg px-2 py-1 font-mono text-xs text-fg outline-none focus:border-accent"
                    />
                    <p className="truncate font-mono text-[10px] text-muted" title={previewKey(key)}>
                      将保存为 {previewKey(key)}
                    </p>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={commitRename}
                        className="rounded-md bg-accent px-2 py-0.5 text-xs text-white"
                      >
                        确定
                      </button>
                      <button
                        type="button"
                        onClick={() => setRenaming(null)}
                        className="rounded-md border border-line px-2 py-0.5 text-xs text-fg"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-bg">
                        {isImage && src ? (
                          <img
                            src={src}
                            alt={basename(key)}
                            loading="lazy"
                            decoding="async"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="text-[10px] text-muted">文件</span>
                        )}
                      </div>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={key}>
                        {basename(key)}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => onInsert(key)}
                        className="rounded-md border border-line px-2 py-0.5 text-xs text-fg transition-colors hover:bg-raised disabled:opacity-40"
                      >
                        插入
                      </button>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => startRename(key)}
                        className="rounded-md border border-line px-2 py-0.5 text-xs text-fg transition-colors hover:bg-raised disabled:opacity-40"
                      >
                        改名
                      </button>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => setPendingDelete(key)}
                        className="rounded-md border border-line px-2 py-0.5 text-xs text-red-400 transition-colors hover:bg-raised disabled:opacity-40"
                      >
                        删除
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title="删除这个资源？"
        description={
          pendingDelete === null
            ? undefined
            : `将从归档中移除 ${pendingDelete}。正文里对它的引用会失效，保存后无法恢复。`
        }
        confirmLabel="删除"
        onConfirm={() => {
          if (pendingDelete !== null) onDelete(pendingDelete);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </aside>
  );
}
