/**
 * 编辑页：下载整包 → 内存中解包 → 左右分屏实时预览。
 *
 * 状态与流程（见实现方案「五、前端」）：
 * - 正文放 `useState`，预览用 `useDeferredValue` 渲染，连续输入时不卡输入框。
 * - 脏标记 = 正文变了 **或** 有资源被增删改。
 * - 保存 = `buildMdex()` → `PUT` + `If-Match: "<rev>"`，用响应的 rev 回填。
 * - 409 冲突给「重新载入」「强制覆盖」两条出路。
 * - 未保存拦截：`useBlocker`（站内跳转）+ `beforeunload`（关标签页）+ `Ctrl/Cmd+S` 保存。
 */

import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { Link, useBlocker, useNavigate, useParams } from "react-router-dom";
import { openSearchPanel } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";

import { uniqueAssetKey } from "../../shared/assetKey";
import { buildMdex, parseMdex } from "../../shared/mdex";
import type { MdexArchive } from "../../shared/types";
import { ApiError, errorMessage, fetchRaw, getDoc, updateDoc } from "../lib/api";
import { AssetStore } from "../lib/assetStore";
import { insertImageRef, runFormatAction } from "../lib/actions";
import AssetPanel from "../components/AssetPanel";
import ConfirmDialog from "../components/ConfirmDialog";
import Editor, { type CursorInfo } from "../components/Editor";
import MarkdownView from "../components/MarkdownView";
import SplitPane from "../components/SplitPane";
import Toolbar from "../components/Toolbar";
import { useToast } from "../components/Toast";

/** 资源总量超过这个阈值就拒绝在浏览器里编辑：解压后的字节 + 解码后的位图会吃满内存。 */
const MAX_EDIT_ASSET_BYTES = 64 * 1024 * 1024;

type LoadState = "loading" | "ready" | "error" | "too-large";
type SavingState = "idle" | "saving" | "error";

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function extensionOf(key: string): string {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1);
}

function basename(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

export default function EditPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [savedMarkdown, setSavedMarkdown] = useState("");
  const [rev, setRev] = useState(1);
  const [assetKeys, setAssetKeys] = useState<string[]>([]);
  const [dirtyAssets, setDirtyAssets] = useState<Set<string>>(() => new Set());
  const [assetVersion, setAssetVersion] = useState(0);
  const [saving, setSaving] = useState<SavingState>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [cursor, setCursor] = useState<CursorInfo>({ ln: 1, col: 1 });
  const [conflict, setConflict] = useState(false);
  const [showAssets, setShowAssets] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const archiveRef = useRef<MdexArchive | null>(null);
  const storeRef = useRef<AssetStore | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);

  const dirty = markdown !== savedMarkdown || dirtyAssets.size > 0;

  // 供只注册一次的监听器（快捷键、beforeunload）读取最新值
  const latest = useRef({ markdown, saving, rev, dirty, id });
  latest.current = { markdown, saving, rev, dirty, id };

  // ---- 加载：整包 + 摘要一起取，标题以 D1 为准（列表页改名不会重压整包） ----
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState("loading");
    setError(null);

    void (async () => {
      try {
        const [bytes, detail] = await Promise.all([
          fetchRaw(id, controller.signal),
          getDoc(id, controller.signal),
        ]);
        const archive = await parseMdex(bytes);
        const title = detail.doc.title.trim();
        if (title) archive.meta.title = title;
        const store = new AssetStore(archive.assets);
        if (!active) {
          store.dispose();
          return;
        }

        archiveRef.current = archive;
        storeRef.current = store;
        setMarkdown(archive.markdown);
        setSavedMarkdown(archive.markdown);
        setAssetKeys(store.keys());
        setAssetVersion((value) => value + 1);
        setDirtyAssets(new Set());
        setRev(detail.doc.rev);
        setLastSavedAt(null);
        setSaving("idle");
        setState(store.totalBytes() > MAX_EDIT_ASSET_BYTES ? "too-large" : "ready");
      } catch (err) {
        if (!active) return;
        setError(errorMessage(err));
        setState("error");
      }
    })();

    return () => {
      active = false;
      controller.abort();
      // 切文档/离开页面时统一回收所有 blob URL
      storeRef.current?.dispose();
      storeRef.current = null;
      archiveRef.current = null;
      viewRef.current = null;
    };
  }, [id, reloadKey]);

  // ---- 保存 ----
  const applySavedDoc = useCallback((next: MdexArchive, nextRev: number) => {
    archiveRef.current = next;
    setRev(nextRev);
    setSavedMarkdown(next.markdown);
    setDirtyAssets(new Set());
    setSaving("idle");
    setLastSavedAt(new Date());
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    const archive = archiveRef.current;
    const store = storeRef.current;
    if (!archive || !store || latest.current.saving === "saving") return false;

    setSaving("saving");
    try {
      const next: MdexArchive = {
        ...archive,
        markdown: latest.current.markdown,
        assets: archive.assets,
        assetKeys: store.keys(),
      };
      const bytes = await buildMdex(next);
      const { doc } = await updateDoc(latest.current.id, bytes, latest.current.rev);
      applySavedDoc(next, doc.rev);
      toast(`已保存（rev ${doc.rev}）`, "success");
      return true;
    } catch (err) {
      setSaving("error");
      if (err instanceof ApiError && err.code === "REVISION_MISMATCH") {
        setConflict(true);
        return false;
      }
      toast(errorMessage(err), "error");
      return false;
    }
  }, [applySavedDoc, toast]);

  const reloadFromServer = useCallback(() => {
    setConflict(false);
    setReloadKey((value) => value + 1);
  }, []);

  /** 强制覆盖：先取服务端最新 rev，再 PUT 一次。 */
  const forceOverwrite = useCallback(async () => {
    setConflict(false);
    const archive = archiveRef.current;
    const store = storeRef.current;
    if (!archive || !store) return;
    setSaving("saving");
    try {
      const latestDetail = await getDoc(latest.current.id);
      const next: MdexArchive = {
        ...archive,
        markdown: latest.current.markdown,
        assets: archive.assets,
        assetKeys: store.keys(),
      };
      const bytes = await buildMdex(next);
      const { doc } = await updateDoc(latest.current.id, bytes, latestDetail.doc.rev);
      applySavedDoc(next, doc.rev);
      toast(`已强制覆盖（rev ${doc.rev}）`, "success");
    } catch (err) {
      setSaving("error");
      toast(errorMessage(err), "error");
    }
  }, [applySavedDoc, toast]);

  // ---- 快捷键与离开拦截 ----
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() !== "s" || event.shiftKey) return;
      event.preventDefault();
      // 保存进行中忽略 Ctrl+S，避免重复提交
      if (latest.current.saving === "saving") return;
      void save();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [save]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!latest.current.dirty) return;
      // 必须 preventDefault 并设置 returnValue，否则浏览器不会弹确认框
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const blocker = useBlocker(dirty);

  // ---- 资源操作 ----
  const markAssetsChanged = useCallback((changed: string[]) => {
    setDirtyAssets((prev) => {
      const next = new Set(prev);
      for (const key of changed) next.add(key);
      return next;
    });
    setAssetKeys(storeRef.current?.keys() ?? []);
    setAssetVersion((value) => value + 1);
  }, []);

  const handlePasteImage = useCallback(
    async (base64: string, ext: string): Promise<string | null> => {
      const store = storeRef.current;
      if (!store) return null;
      try {
        const bytes = base64ToBytes(base64);
        const key = uniqueAssetKey(store.keys(), `pasted-image.${ext}`, ext);
        store.set(key, bytes);
        markAssetsChanged([key]);
        return key;
      } catch (err) {
        toast(errorMessage(err), "error");
        return null;
      }
    },
    [markAssetsChanged, toast],
  );

  const handleInsertAsset = useCallback((key: string) => {
    const view = viewRef.current;
    if (view) insertImageRef(view, key, basename(key));
  }, []);

  const handleRenameAsset = useCallback(
    (key: string, nextName: string) => {
      const store = storeRef.current;
      if (!store) return;
      const ext = extensionOf(key) || "bin";
      const next = uniqueAssetKey(store.keys(), `${nextName}.${ext}`, ext);
      if (next === key) return;
      store.rename(key, next);
      markAssetsChanged([key, next]);
      toast(`已重命名为 ${next}`, "success");
    },
    [markAssetsChanged, toast],
  );

  const handleDeleteAsset = useCallback(
    (key: string) => {
      storeRef.current?.delete(key);
      markAssetsChanged([key]);
    },
    [markAssetsChanged],
  );

  const resolveAsset = useCallback(
    (key: string) => storeRef.current?.url(key) ?? null,
    // assetVersion 必须进依赖：同一个 key 被覆盖后 URL 变了，markdown 却没变，
    // 不靠它打破 memo 就会继续渲染已 revoke 的旧 URL。
    [assetVersion],
  );

  const deferredMarkdown = useDeferredValue(markdown);

  // ---- 各种中间态 ----
  if (state === "loading") {
    return <p className="px-5 py-10 text-center text-sm text-muted">正在下载并解包文档…</p>;
  }

  if (state === "error") {
    return (
      <div className="mx-auto max-w-lg px-5 py-16 text-center">
        <p className="text-sm text-red-400">{error ?? "文档加载失败。"}</p>
        <div className="mt-4 flex justify-center gap-3">
          <button
            type="button"
            onClick={() => setReloadKey((value) => value + 1)}
            className="text-sm text-accent hover:underline"
          >
            重试
          </button>
          <Link to="/" className="text-sm text-accent hover:underline">
            返回列表
          </Link>
        </div>
      </div>
    );
  }

  if (state === "too-large") {
    return (
      <div className="mx-auto max-w-lg px-5 py-16 text-center">
        <p className="text-sm text-fg">
          文档资源过大（超过 {Math.round(MAX_EDIT_ASSET_BYTES / 1024 / 1024)}MB），
          请改用只读预览页。
        </p>
        <div className="mt-4 flex justify-center gap-3">
          <Link
            to={`/d/${id}`}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            打开预览页
          </Link>
          <Link to="/" className="text-sm text-accent hover:underline">
            返回列表
          </Link>
        </div>
      </div>
    );
  }

  const lines = markdown.length === 0 ? 1 : markdown.split("\n").length;
  const savingLabel =
    saving === "saving" ? "保存中…" : saving === "error" ? "保存失败" : dirty ? "未保存" : "已保存";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-panel px-4 py-2.5">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="text-sm text-muted transition-colors hover:text-accent"
        >
          ← 返回列表
        </button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-heading">
          {archiveRef.current?.meta.title ?? "未命名文档"}
        </h1>
        <span className="text-xs text-muted">
          {savingLabel}
          {lastSavedAt ? ` · ${lastSavedAt.toLocaleTimeString("zh-CN")}` : ""}
        </span>
        <button
          type="button"
          onClick={() => setShowAssets((value) => !value)}
          className="rounded-md border border-line px-3 py-1.5 text-xs text-fg transition-colors hover:bg-raised"
        >
          {showAssets ? "隐藏资源" : "显示资源"}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving === "saving"}
          className="rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/85 disabled:opacity-40"
        >
          {saving === "saving" ? "保存中…" : "保存 (Ctrl+S)"}
        </button>
      </header>

      <Toolbar onAction={(action) => {
        const view = viewRef.current;
        if (!view) return;
        // 查找不是文本变换，走 CodeMirror 自己的面板
        if (action === "find") {
          openSearchPanel(view);
          return;
        }
        runFormatAction(view, action);
      }} />

      <div className="flex min-h-0 flex-1">
        <SplitPane
          left={
            <div className="editor-pane h-full bg-bg">
              <Editor
                key={id}
                initialDoc={markdown}
                onChange={setMarkdown}
                onCursor={setCursor}
                onScrollRatio={(ratio) => {
                  const el = previewRef.current;
                  if (!el) return;
                  const max = el.scrollHeight - el.clientHeight;
                  if (max > 0) el.scrollTop = ratio * max;
                }}
                onView={(view) => {
                  viewRef.current = view;
                }}
                onPasteImage={handlePasteImage}
              />
            </div>
          }
          right={
            <div ref={previewRef} className="preview-pane h-full">
              <MarkdownView
                source={deferredMarkdown}
                resolveAsset={resolveAsset}
                assetVersion={assetVersion}
              />
            </div>
          }
        />
        {showAssets && (
          <AssetPanel
            keys={assetKeys}
            url={resolveAsset}
            onInsert={handleInsertAsset}
            onRename={handleRenameAsset}
            onDelete={handleDeleteAsset}
          />
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-4 border-t border-line bg-panel px-4 py-1.5 text-xs text-muted">
        <span>
          Ln {cursor.ln}, Col {cursor.col}
        </span>
        <span>{lines} 行</span>
        <span>{markdown.length} 字符</span>
        <span>{assetKeys.length} 个资源</span>
        {dirty && <span className="text-accent">有未保存的修改</span>}
      </footer>

      <ConfirmDialog
        open={conflict}
        title="该文档已在别处被修改"
        description="服务器上的版本比本地新。你可以重新载入以丢弃本地改动，或用本地内容强制覆盖服务端。"
        extraLabel="重新载入"
        onExtra={reloadFromServer}
        confirmLabel="强制覆盖"
        danger
        busy={saving === "saving"}
        onConfirm={() => void forceOverwrite()}
        onCancel={() => setConflict(false)}
      />

      <ConfirmDialog
        open={blocker.state === "blocked"}
        title="放弃未保存的修改？"
        description="当前文档有未保存的改动，离开后这些改动会丢失。"
        confirmLabel="放弃并离开"
        cancelLabel="留在这里"
        danger
        onConfirm={() => {
          if (blocker.state === "blocked") blocker.proceed();
        }}
        onCancel={() => {
          if (blocker.state === "blocked") blocker.reset();
        }}
      />
    </div>
  );
}
