/**
 * 预览页。**不下载整包**：正文和资源清单来自 `GET /api/docs/:id`，
 * 图片直接走 `/api/docs/:id/asset` 由浏览器的 HTTP 缓存放长缓存。
 *
 * 只有正文过大（>512KB）后端未缓存时，才回退到 `/raw` 整包解压；
 * 那次解压刻意用 `includeAssetBytes: false`，只取正文与资源清单，图片字节一个都不进内存。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { parseMdex } from "../../shared/mdex";
import type { DocSummary } from "../../shared/types";
import { assetUrl, errorMessage, fetchRaw, getDoc, rawUrl } from "../lib/api";
import { useMarginMode } from "../lib/marginPref";
import MarkdownView from "../components/MarkdownView";

type LoadState = "loading" | "ready" | "error";

export default function PreviewPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocSummary | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [assetKeys, setAssetKeys] = useState<string[]>([]);
  const { mode: marginMode, toggle: toggleMargin } = useMarginMode();

  const paneRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);

  /** 触屏端阅读进度：部分国产内核的经典滚动条 thumb 位置计算有 bug，改用自绘进度条与内核实现解耦。 */
  const updateProgress = useCallback(() => {
    const pane = paneRef.current;
    const bar = progressRef.current;
    if (!pane || !bar) return;
    const max = pane.scrollHeight - pane.clientHeight;
    const progress = max > 0 ? Math.min(1, Math.max(0, pane.scrollTop / max)) : 0;
    bar.style.transform = `scaleX(${progress})`;
  }, []);

  // 正文加载/切换文档后校准一次（此时 scrollTop 通常已归零，防止残留上一篇文章的进度）
  useEffect(() => {
    updateProgress();
  }, [updateProgress, markdown]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState("loading");

    void (async () => {
      try {
        const detail = await getDoc(id, controller.signal);
        let source = detail.markdown;
        let keys = detail.assetKeys;
        if (source === null) {
          const archive = await parseMdex(await fetchRaw(id, controller.signal), {
            includeAssetBytes: false,
          });
          source = archive.markdown;
          keys = archive.assetKeys;
        }
        if (!active) return;
        setDoc(detail.doc);
        setMarkdown(source);
        setAssetKeys(keys);
        setState("ready");
      } catch (err) {
        if (!active) return;
        setError(errorMessage(err));
        setState("error");
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [id]);

  // 资源清单里没有的引用直接不输出图片，省掉一次必然 404 的请求。
  const assetSet = useMemo(() => new Set(assetKeys), [assetKeys]);
  const rev = doc?.rev ?? 1;
  const resolveAsset = useCallback(
    (key: string) => (assetSet.has(key) ? assetUrl(id, key, rev) : null),
    [assetSet, id, rev],
  );

  if (state === "loading") {
    return <p className="px-5 py-10 text-center text-sm text-muted">正在加载文档…</p>;
  }

  if (state === "error" || !doc) {
    return (
      <div className="mx-auto max-w-lg px-5 py-16 text-center">
        <p className="text-sm text-red-400">{error ?? "文档加载失败。"}</p>
        <Link to="/" className="mt-4 inline-block text-sm text-accent hover:underline">
          返回列表
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-panel px-4 py-2.5">
        <Link to="/" className="text-sm text-muted transition-colors hover:text-accent">
          ← 返回列表
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-heading" title={doc.title}>
          {doc.title || "未命名文档"}
        </h1>
        <span className="text-xs text-muted">
          rev {doc.rev} · {doc.assetCount} 个资源
        </span>
        <button
          type="button"
          onClick={toggleMargin}
          aria-pressed={marginMode === "narrow"}
          title={marginMode === "narrow" ? "切换为正常边距" : "切换为窄边距"}
          className="rounded-md border border-line px-3 py-1.5 text-xs text-fg transition-colors hover:bg-raised"
        >
          {/* 文字按钮按约定显示**点击后会发生什么**（目标状态），当前状态由 aria-pressed 表达。
              旁边的主题按钮是图标，读作「当前模式」，两者语义不同，不要照搬。 */}
          {marginMode === "narrow" ? "正常边距" : "窄边距"}
        </button>
        <Link
          to={`/d/${doc.id}/edit`}
          className="rounded-md border border-line px-3 py-1.5 text-xs text-fg transition-colors hover:bg-raised"
        >
          编辑
        </Link>
        <a
          href={rawUrl(doc.id)}
          download={`${doc.title || "document"}.mdex`}
          className="rounded-md border border-line px-3 py-1.5 text-xs text-fg transition-colors hover:bg-raised"
        >
          下载
        </a>
      </header>

      <div ref={paneRef} onScroll={updateProgress} className="preview-pane min-h-0 flex-1">
        <div ref={progressRef} className="reading-progress" aria-hidden="true" />
        <MarkdownView source={markdown} resolveAsset={resolveAsset} />
      </div>
    </div>
  );
}
