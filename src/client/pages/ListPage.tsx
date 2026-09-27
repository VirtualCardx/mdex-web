/**
 * 文档列表页：搜索 / 排序 / 分页的状态全部同步到 URL search params，
 * 因此链接可分享、刷新后原样恢复。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { newArchive, buildMdex } from "../../shared/mdex";
import type { DocSummary } from "../../shared/types";
import {
  createDoc,
  deleteDoc,
  errorMessage,
  listDocs,
  rawUrl,
  renameDoc,
  uploadDoc,
  type UploadProgress,
} from "../lib/api";
import ConfirmDialog from "../components/ConfirmDialog";
import UploadDropzone from "../components/UploadDropzone";
import { useToast } from "../components/Toast";

const PAGE_SIZE = 12;

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "modified", label: "文档修改时间" },
  { value: "created", label: "文档创建时间" },
  { value: "updatedAt", label: "上传时间" },
  { value: "title", label: "标题" },
  { value: "size", label: "体积" },
];

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 触发浏览器下载（`/raw` 是 attachment，且策略是同源 Cookie 鉴权）。 */
function triggerDownload(doc: DocSummary) {
  const anchor = document.createElement("a");
  anchor.href = rawUrl(doc.id);
  anchor.download = `${doc.title || "document"}.mdex`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export default function ListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const q = searchParams.get("q") ?? "";
  const sort = searchParams.get("sort") ?? "modified";
  const order = searchParams.get("order") ?? "desc";
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);

  const [searchInput, setSearchInput] = useState(q);
  const [data, setData] = useState<{ items: DocSummary[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<DocSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<DocSummary | null>(null);

  /** 把某个 search param 写回 URL。 */
  const patchParams = useCallback(
    (patch: Record<string, string | null>, replace = false) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === "") next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace },
      );
    },
    [setSearchParams],
  );

  // 搜索框防抖：停止输入 300ms 后才写进 URL，并回到第一页。
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setSearchParams(
        (prev) => {
          if ((prev.get("q") ?? "") === searchInput) return prev;
          const next = new URLSearchParams(prev);
          if (searchInput) next.set("q", searchInput);
          else next.delete("q");
          next.delete("page");
          return next;
        },
        { replace: true },
      );
    }, 300);
    return () => window.clearTimeout(handle);
  }, [searchInput, setSearchParams]);

  // 拉取列表。筛选/排序/分页任何一项变化都会重新请求。
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    listDocs({ q, sort, order, page, pageSize: PAGE_SIZE }, controller.signal)
      .then((result) => {
        if (!active) return;
        setData({ items: result.items, total: result.total });
        setError(null);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(errorMessage(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [q, sort, order, page, reloadKey]);

  const refresh = useCallback(() => setReloadKey((value) => value + 1), []);

  const handleFiles = useCallback(
    async (files: File[]) => {
      const targets = files.filter((file) => /\.(mdex|zip)$/i.test(file.name));
      if (targets.length === 0) {
        toast("只能上传 .mdex（或 .zip）文件。", "error");
        return;
      }
      setUploading(true);
      setProgress(0);
      try {
        for (const file of targets) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const doc = await uploadDoc(bytes, file.name, (item: UploadProgress) => {
            setProgress(item.total > 0 ? item.loaded / item.total : null);
          });
          toast(`已上传《${doc.title}》`, "success");
        }
        refresh();
      } catch (err) {
        toast(errorMessage(err), "error");
      } finally {
        setUploading(false);
        setProgress(null);
      }
    },
    [refresh, toast],
  );

  // 整页拖拽：drop 只在页面层处理，避免与上传区重复触达。
  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");

    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragging(true);
    };
    const onDragLeave = (event: DragEvent) => {
      // relatedTarget 为 null 表示指针已经离开窗口
      if (event.relatedTarget === null) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) void handleFiles(files);
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [handleFiles]);

  const handleCreate = async () => {
    const title = newTitle.trim() || "未命名文档";
    setBusy(true);
    try {
      const bytes = await buildMdex(newArchive(title, `# ${title}\n`));
      const { doc } = await createDoc(bytes, `${title}.mdex`);
      setCreating(false);
      setNewTitle("");
      toast("已新建文档。", "success");
      navigate(`/d/${doc.id}/edit`);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const handleRename = async () => {
    if (renaming === null) return;
    const title = renameDraft.trim();
    if (!title || title === renaming.title) {
      setRenaming(null);
      return;
    }
    setBusy(true);
    try {
      const { doc } = await renameDoc(renaming.id, title);
      setData((prev) =>
        prev
          ? { ...prev, items: prev.items.map((item) => (item.id === doc.id ? doc : item)) }
          : prev,
      );
      setRenaming(null);
      toast("标题已更新。", "success");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    const target = pendingDelete;
    if (target === null) return;
    setBusy(true);
    try {
      await deleteDoc(target.id);
      setPendingDelete(null);
      toast("已删除。", "success");
      // 删掉本页最后一条时退回上一页，否则会停在空页
      if (data && data.items.length === 1 && page > 1) patchParams({ page: String(page - 1) });
      else refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE)),
    [data?.total],
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
          <input
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="搜索标题或正文…"
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-fg outline-none focus:border-accent"
          />
        </div>
        <select
          value={sort}
          onChange={(event) => patchParams({ sort: event.target.value, page: null })}
          className="rounded-lg border border-line bg-panel px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => patchParams({ order: order === "asc" ? "desc" : "asc", page: null })}
          title="切换排序方向"
          className="rounded-lg border border-line bg-panel px-3 py-2 text-sm text-fg transition-colors hover:bg-raised"
        >
          {order === "asc" ? "升序 ↑" : "降序 ↓"}
        </button>
        <button
          type="button"
          onClick={() => {
            setNewTitle("");
            setCreating(true);
          }}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/85"
        >
          新建文档
        </button>
      </div>

      <div className="mt-4">
        <UploadDropzone
          onFiles={(files) => void handleFiles(files)}
          active={dragging}
          uploading={uploading}
          progress={progress}
        />
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-fg">
          {error}
        </div>
      )}

      <div className="mt-5 flex items-center justify-between text-xs text-muted">
        <span>
          共 {data?.total ?? 0} 篇{loading ? " · 加载中…" : ""}
        </span>
        {totalPages > 1 && (
          <span>
            第 {page} / {totalPages} 页
          </span>
        )}
      </div>

      {data && data.items.length === 0 && !loading && (
        <p className="mt-8 text-center text-sm text-muted">
          {q ? "没有匹配的文档。" : "还没有文档，上传一个 .mdex 或新建一个吧。"}
        </p>
      )}

      <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(data?.items ?? []).map((doc) => (
          <li
            key={doc.id}
            className="flex flex-col rounded-xl border border-line bg-panel p-4 transition-colors hover:border-accent/50"
          >
            <Link
              to={`/d/${doc.id}`}
              className="truncate text-sm font-semibold text-heading hover:text-accent"
              title={doc.title}
            >
              {doc.title || "未命名文档"}
            </Link>
            <dl className="mt-2 space-y-0.5 text-xs text-muted">
              <div className="flex justify-between gap-2">
                <dt>大小</dt>
                <dd>
                  {formatBytes(doc.size)} · {doc.assetCount} 个资源
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>修改</dt>
                <dd>{formatDate(doc.modified)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>上传</dt>
                <dd>{formatDate(doc.updatedAt)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>格式</dt>
                <dd>
                  v{doc.formatVersion} · rev {doc.rev}
                </dd>
              </div>
            </dl>

            <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-3">
              <Link
                to={`/d/${doc.id}`}
                className="rounded-md border border-line px-2 py-1 text-xs text-fg transition-colors hover:bg-raised"
              >
                打开
              </Link>
              <Link
                to={`/d/${doc.id}/edit`}
                className="rounded-md border border-line px-2 py-1 text-xs text-fg transition-colors hover:bg-raised"
              >
                编辑
              </Link>
              <button
                type="button"
                onClick={() => triggerDownload(doc)}
                className="rounded-md border border-line px-2 py-1 text-xs text-fg transition-colors hover:bg-raised"
              >
                下载
              </button>
              <button
                type="button"
                onClick={() => {
                  setRenameDraft(doc.title);
                  setRenaming(doc);
                }}
                className="rounded-md border border-line px-2 py-1 text-xs text-fg transition-colors hover:bg-raised"
              >
                重命名
              </button>
              <button
                type="button"
                onClick={() => setPendingDelete(doc)}
                className="rounded-md border border-line px-2 py-1 text-xs text-red-400 transition-colors hover:bg-raised"
              >
                删除
              </button>
            </div>
          </li>
        ))}
      </ul>

      {totalPages > 1 && (
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => patchParams({ page: String(page - 1) })}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-fg transition-colors hover:bg-raised disabled:opacity-40"
          >
            上一页
          </button>
          <span className="text-xs text-muted">
            {page} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => patchParams({ page: String(page + 1) })}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-fg transition-colors hover:bg-raised disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-40 rounded-2xl border-2 border-dashed border-accent bg-accent/10" />
      )}

      <ConfirmDialog
        open={creating}
        title="新建文档"
        description="将生成一个只含标题的空白 .mdex，随后进入编辑页。"
        confirmLabel="创建"
        busy={busy}
        onConfirm={() => void handleCreate()}
        onCancel={() => setCreating(false)}
      >
        <input
          autoFocus
          value={newTitle}
          onChange={(event) => setNewTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void handleCreate();
          }}
          placeholder="文档标题"
          className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={renaming !== null}
        title="重命名"
        confirmLabel="保存"
        busy={busy}
        onConfirm={() => void handleRename()}
        onCancel={() => setRenaming(null)}
      >
        <input
          autoFocus
          value={renameDraft}
          onChange={(event) => setRenameDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void handleRename();
          }}
          placeholder="新的标题"
          className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title="删除这篇文档？"
        description={pendingDelete === null ? undefined : `《${pendingDelete.title}》将被永久删除。`}
        confirmLabel="删除"
        busy={busy}
        onConfirm={() => void handleDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
