/**
 * 预览页。**不下载整包**：正文和资源清单来自 `GET /api/docs/:id`，
 * 图片直接走 `/api/docs/:id/asset` 由浏览器的 HTTP 缓存放长缓存。
 *
 * 只有正文过大（>512KB）后端未缓存时，才回退到 `/raw` 整包解压；
 * 那次解压刻意用 `includeAssetBytes: false`，只取正文与资源清单，图片字节一个都不进内存。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Link, useParams } from "react-router-dom";

import { parseMdex } from "../../shared/mdex";
import type { DocSummary } from "../../shared/types";
import { assetUrl, errorMessage, fetchRaw, getDoc, rawUrl } from "../lib/api";
import { useMarginMode } from "../lib/marginPref";
import { useIsMobile } from "../lib/useMediaQuery";
import MarkdownView from "../components/MarkdownView";

type LoadState = "loading" | "ready" | "error";

export default function PreviewPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocSummary | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [assetKeys, setAssetKeys] = useState<string[]>([]);
  const [immersive, setImmersive] = useState(false);
  const { mode: marginMode, toggle: toggleMargin } = useMarginMode();
  const isMobile = useIsMobile();

  const paneRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLElement | null>(null);
  const lastScrollTop = useRef(0);
  /**
   * 工具条是否可见。窄屏初始为 false——打开文档即是沉浸阅读；桌面端由 effect 置 true。
   * 用 ref 不用 state：滚动时每次方向变化都要读它，走 state 就会反复重渲染整篇正文。
   */
  const chromeVisible = useRef(false);
  const [moreOpen, setMoreOpen] = useState(false);

  /** 同步右侧自绘滑块：高度=可视占比，位置=滚动比例；内容不可滚动时隐藏整条轨道。 */
  const updateScrollbar = useCallback(() => {
    const pane = paneRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!pane || !track || !thumb) return;
    const max = pane.scrollHeight - pane.clientHeight;
    if (max <= 0) {
      track.style.opacity = "0";
      return;
    }
    track.style.opacity = "1";
    const trackH = track.clientHeight;
    const thumbH = Math.max(40, (pane.clientHeight / pane.scrollHeight) * trackH);
    thumb.style.height = `${thumbH}px`;
    thumb.style.transform = `translateY(${(pane.scrollTop / max) * (trackH - thumbH)}px)`;
  }, []);

  /** 把 chromeVisible 落到 DOM 上：可见时写 data-hidden="false"，否则移除属性。
   *  CSS 在窄屏下默认就是收起的（`.page-chrome` 带 translateY(-100%)），
   *  所以「隐藏」靠删除属性而不是显式设 true，首帧才不会闪一下完整工具条。 */
  const applyChrome = useCallback(() => {
    const bar = toolbarRef.current;
    if (!bar) return;
    if (chromeVisible.current) bar.dataset.hidden = "false";
    else delete bar.dataset.hidden;
  }, []);

  /** 点击正文切换工具条。手机上这是唤出/收起入口的唯一方式。 */
  const toggleChrome = useCallback(() => {
    chromeVisible.current = !chromeVisible.current;
    applyChrome();
  }, [applyChrome]);

  /**
   * 手机端工具条是浮在正文上方的浮层，向下读时滑走。它由用户点击唤出
   * （见 toggleChrome），滚动只负责收起——不因滚动方向自动弹出，
   * 否则「打开即沉浸」就维持不住。
   */
  const updateChrome = useCallback(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const top = pane.scrollTop;
    const prev = lastScrollTop.current;
    lastScrollTop.current = top;
    // 6px 阈值：手指轻微回弹不该让工具条闪一下
    if (chromeVisible.current && top - prev > 6) {
      chromeVisible.current = false;
      applyChrome();
      setMoreOpen(false);
    }
  }, [applyChrome]);

  /** 点正文空白处唤出/收起工具条；点在链接、按钮上时不动——那是用户的真实意图。 */
  const handlePaneClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!isMobile) return;
      if ((event.target as HTMLElement).closest("a, button, input, textarea, select")) return;
      toggleChrome();
    },
    [isMobile, toggleChrome],
  );

  /** 一次滚动要同时维护滑块与顶栏，合起来给 onScroll / 观察者调用。 */
  const syncPane = useCallback(() => {
    updateScrollbar();
    updateChrome();
  }, [updateScrollbar, updateChrome]);

  /**
   * 拖拽/点按轨道快速定位：滑块中心跟随指针（与原生滚动条行为一致）。
   * 部分国产内核的原生滚动条 thumb 位置计算有 bug，因此整个指示条自绘、与内核解耦。
   */
  const startDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const pane = paneRef.current;
    const thumb = thumbRef.current;
    if (!pane || !thumb) return;
    e.preventDefault();
    const track = e.currentTarget;
    track.setPointerCapture(e.pointerId);
    const rect = track.getBoundingClientRect();

    const apply = (clientY: number) => {
      const max = pane.scrollHeight - pane.clientHeight;
      if (max <= 0) return;
      const travel = rect.height - thumb.offsetHeight;
      const y = clientY - rect.top - thumb.offsetHeight / 2;
      pane.scrollTop = Math.min(1, Math.max(0, y / travel)) * max;
    };
    apply(e.clientY);

    const onMove = (ev: PointerEvent) => apply(ev.clientY);
    const onUp = () => {
      track.removeEventListener("pointermove", onMove);
      track.removeEventListener("pointerup", onUp);
      track.removeEventListener("pointercancel", onUp);
    };
    track.addEventListener("pointermove", onMove);
    track.addEventListener("pointerup", onUp);
    track.addEventListener("pointercancel", onUp);
  }, []);

  // 正文加载/切换文档后校准一次（防止残留上一篇文章的滑块/顶栏状态）
  useEffect(() => {
    syncPane();
  }, [syncPane, markdown]);

  // 视口或内容几何变化时同步一遍：pane 自身覆盖地址栏收起、横竖屏切换等情况；
  // 还要观察内容元素（.md-body）——图片/KaTeX 字体延迟加载只改变内容高度、
  // 不改变 pane 尺寸，若不观察它，滑块会停驻在按旧 scrollHeight 算出的
  // 偏下位置，表现为「文章没读完滑块先到底」。
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncPane);
    observer.observe(pane);
    const content = pane.firstElementChild;
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [syncPane]);

  /**
   * 沉浸式阅读。原生全屏必须在点击手势的瞬时活化窗口内**同步**发起，
   * 因此放在事件回调里而不是 useEffect（后者会推迟到渲染后，可能被浏览器拒绝）。
   * iOS Safari 不提供 Element.requestFullscreen，可选链会静默跳过，退化为纯应用内沉浸。
   */
  const enterImmersive = useCallback(() => {
    void document.documentElement.requestFullscreen?.().catch(() => {});
    setImmersive(true);
  }, []);

  const exitImmersive = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    setImmersive(false);
  }, []);

  // data-immersive 驱动 CSS 隐藏顶栏；离开页面时清掉属性，避免影响其他页面
  useEffect(() => {
    const root = document.documentElement;
    if (immersive) root.dataset.immersive = "on";
    else delete root.dataset.immersive;
    return () => {
      delete root.dataset.immersive;
    };
  }, [immersive]);

  // 手机端预览页隐去应用顶栏：那一栏在这里是冗余导航（页面内已有「返回列表」），
  // 只留一条工具栏。桌面端窗口宽裕，顶栏照常显示。
  useEffect(() => {
    if (!isMobile) return;
    const root = document.documentElement;
    root.dataset.appbar = "hidden";
    return () => {
      delete root.dataset.appbar;
    };
  }, [isMobile]);

  // 桌面端工具条常驻；窄屏默认收起，打开文档即是沉浸阅读。
  // 也覆盖了窗口在两者间跨断点缩放的情况。
  useEffect(() => {
    chromeVisible.current = !isMobile;
    lastScrollTop.current = paneRef.current?.scrollTop ?? 0;
    applyChrome();
  }, [isMobile, applyChrome]);

  // 退出沉浸态时把滚动基准对齐当前值，避免带着旧的 scrollTop 做方向判断
  useEffect(() => {
    if (immersive) return;
    lastScrollTop.current = paneRef.current?.scrollTop ?? 0;
  }, [immersive]);

  // 用户用系统手势/Esc 退出原生全屏时，同步关掉沉浸态
  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setImmersive(false);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

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
    <div className="relative flex h-full min-h-0 flex-col">
      <header
        ref={toolbarRef}
        className="page-chrome flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel px-4 py-2.5"
      >
        <Link to="/" className="chrome-btn tap-target text-sm text-soft transition-colors hover:text-accent">
          ← 返回列表
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-heading" title={doc.title}>
          {doc.title || "未命名文档"}
        </h1>
        {/* 窄屏先把次要操作收起来，工具条保持单行、尽量少占纵向空间 */}
        {isMobile && (
          <button
            type="button"
            onClick={() => setMoreOpen((value) => !value)}
            aria-expanded={moreOpen}
            aria-label="更多操作"
            title="更多操作"
            className="chrome-btn tap-target flex items-center justify-center rounded-md border border-line px-3 py-1.5 text-fg transition-colors hover:bg-raised"
          >
            {/* 用 SVG 而不是「⋯」字符：后者在不同字体下的字重/基线差异明显，撑不满触控区 */}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <circle cx="3" cy="8" r="1.5" />
              <circle cx="8" cy="8" r="1.5" />
              <circle cx="13" cy="8" r="1.5" />
            </svg>
          </button>
        )}
        {/* 桌面端平铺全部操作；窄屏点「⋯」后同样平铺，只是整行换到第二排 */}
        {(!isMobile || moreOpen) && (
          <div
            className={`chrome-more flex flex-wrap items-center gap-x-3 gap-y-2 ${isMobile ? "w-full" : ""}`}
          >
            <span className="text-xs text-muted">
              rev {doc.rev} · {doc.assetCount} 个资源
            </span>
            <button
              type="button"
              onClick={toggleMargin}
              aria-pressed={marginMode === "narrow"}
              title={marginMode === "narrow" ? "切换为正常边距" : "切换为窄边距"}
              className="chrome-btn tap-target rounded-md border border-line px-3 py-1.5 text-xs text-fg transition-colors hover:bg-raised"
            >
              {/* 文字按钮按约定显示**点击后会发生什么**（目标状态），当前状态由 aria-pressed 表达。
                  旁边的主题按钮是图标，读作「当前模式」，两者语义不同，不要照搬。 */}
              {marginMode === "narrow" ? "正常边距" : "窄边距"}
            </button>
            <button
              type="button"
              onClick={enterImmersive}
              title="全屏阅读（隐去顶部导航栏）"
              className="chrome-btn tap-target rounded-md border border-line px-3 py-1.5 text-xs text-fg transition-colors hover:bg-raised"
            >
              全屏
            </button>
            <Link
              to={`/d/${doc.id}/edit`}
              className="chrome-btn tap-target rounded-md border border-line px-3 py-1.5 text-xs text-fg transition-colors hover:bg-raised"
            >
              编辑
            </Link>
            <a
              href={rawUrl(doc.id)}
              download={`${doc.title || "document"}.mdex`}
              className="chrome-btn tap-target rounded-md border border-line px-3 py-1.5 text-xs text-fg transition-colors hover:bg-raised"
            >
              下载
            </a>
          </div>
        )}
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={paneRef} onScroll={syncPane} onClick={handlePaneClick} className="preview-pane h-full">
          <MarkdownView source={markdown} resolveAsset={resolveAsset} />
        </div>
        {/* 自绘滚动条覆盖层：与滚动容器平级，不随内容滚动；拖拽逻辑见 startDrag */}
        <div ref={trackRef} className="md-scrollbar" aria-hidden="true" onPointerDown={startDrag}>
          <div ref={thumbRef} className="md-scrollbar-thumb" />
        </div>
        {/* 沉浸态的退出入口。放右下角而不是顶部：工具条唤出时也在顶部，会重叠 */}
        {immersive && (
          <button
            type="button"
            onClick={exitImmersive}
            title="退出全屏阅读"
            className="absolute bottom-4 right-4 z-30 rounded-full border border-line bg-panel px-3 py-1.5 text-xs text-fg shadow-lg transition-colors hover:bg-raised"
          >
            退出全屏
          </button>
        )}
      </div>
    </div>
  );
}
