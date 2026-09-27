/**
 * CodeMirror 6 的 markdown 编辑器。移植自参考实现 `mdex\src\components\Editor.tsx`。
 *
 * 关键点：`extensions` 数组**只构建一次**（依赖数组为空）。只要它变了，
 * CodeMirror 就会重建 state，光标位置与撤销历史全丢。为了让回调始终拿到最新的 props，
 * 这里用 `callbacks = useRef(props); callbacks.current = props` 的模式——
 * 文档切换由父组件通过 `key` 重新挂载本组件来完成。
 */

import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { search, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/** 编辑器的光标位置（1 基）。 */
export interface CursorInfo {
  ln: number;
  col: number;
}

export interface EditorProps {
  initialDoc: string;
  onChange: (doc: string) => void;
  onCursor: (pos: CursorInfo) => void;
  /** 编辑区滚动比例（0~1），用于与预览区联动。 */
  onScrollRatio: (ratio: number) => void;
  onView: (view: EditorView | null) => void;
  /** 返回图片在归档里的 key；返回 null 表示放弃插入。 */
  onPasteImage: (base64: string, ext: string) => Promise<string | null>;
}

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "14.5px",
    backgroundColor: "transparent",
    color: "var(--fg)",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.65",
    padding: "18px 20px 40vh",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted)",
    borderRight: "1px solid var(--border)",
    paddingLeft: "10px",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--accent) 6%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--fg)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent)",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--accent)",
    borderLeftWidth: "2px",
  },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)",
  },
  // ---- 查找面板（@codemirror/search） ----
  // 基主题按 light 模式给面板/输入框/按钮配了浅灰渐变，与本站主题冲突，这里全部按设计令牌重写。
  // `EditorView.theme` 的优先级高于 `EditorView.baseTheme`，因此同特异度的规则以后者为准。
  ".cm-panels": {
    backgroundColor: "var(--bg-raised)",
    color: "var(--fg)",
    fontFamily: "var(--font-ui)",
  },
  ".cm-panels-top": {
    borderBottom: "1px solid var(--border)",
  },
  ".cm-panels-bottom": {
    borderTop: "1px solid var(--border)",
  },
  ".cm-panel.cm-search": {
    padding: "6px 8px",
  },
  ".cm-panel.cm-search input.cm-textfield": {
    height: "26px",
    padding: "0 8px",
    fontSize: "12px",
    color: "var(--fg)",
    backgroundColor: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    outline: "none",
  },
  ".cm-panel.cm-search input.cm-textfield:focus": {
    borderColor: "var(--accent)",
  },
  ".cm-panel.cm-search button.cm-button": {
    height: "26px",
    padding: "0 10px",
    fontSize: "12px",
    color: "var(--fg-soft)",
    backgroundImage: "none",
    backgroundColor: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    cursor: "pointer",
    "&:hover": {
      color: "var(--fg)",
      backgroundColor: "var(--bg-raised)",
    },
  },
  ".cm-panel.cm-search label": {
    fontSize: "12px",
    color: "var(--muted)",
  },
  ".cm-panel.cm-search [name=close]": {
    color: "var(--muted)",
    fontSize: "16px",
    "&:hover": {
      color: "var(--fg)",
    },
  },
  // 匹配高亮：基主题用的是亮黄/亮橙，在深色正文上非常刺眼，改用强调色。
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
    borderRadius: "2px",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--accent) 55%, transparent)",
  },
});

const markdownHighlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: "700", color: "var(--heading)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--muted)" },
  { tag: t.link, color: "var(--accent)", textDecoration: "underline" },
  { tag: t.url, color: "var(--accent)" },
  { tag: t.monospace, color: "var(--code)" },
  { tag: t.quote, color: "var(--fg-soft)", fontStyle: "italic" },
  { tag: [t.processingInstruction, t.bracket, t.punctuation], color: "var(--muted)" },
]);

/** 粘贴图片时按 MIME 推断扩展名。 */
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

/**
 * 查找面板的中文文案。
 *
 * CodeMirror 的面板文案走 `state.phrase(key)` 查表，默认只有英文。键名由
 * `@codemirror/search` 的 `phrase()` 调用点决定（见其 dist 里 SearchPanel 的构造），
 * 漏掉某个键只会退回英文，不会报错。带 `$` 的键用于屏幕阅读器播报，`$` 会被替换成数字。
 */
const SEARCH_PHRASES: Record<string, string> = {
  Find: "查找",
  Replace: "替换为",
  next: "下一个",
  previous: "上一个",
  all: "全选匹配",
  "match case": "区分大小写",
  regexp: "正则",
  "by word": "全词",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭",
  "Go to line": "跳转到行",
  go: "跳转",
  "current match": "当前匹配",
  "on line": "位于第",
  "replaced match on line $": "已替换第 $ 行",
  "replaced $ matches": "已替换 $ 处",
};

export default function Editor(props: EditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef(props);
  callbacks.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      doc: props.initialDoc,
      parent: host,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        // 查找/替换：Ctrl+F 打开面板、F3 与 Ctrl+G 上下跳转、Ctrl+D 选中下一个同名匹配。
        // 面板放在编辑器顶部（紧邻工具栏），视线不用在上下之间来回跳。
        search({ top: true }),
        keymap.of(searchKeymap),
        EditorState.phrases.of(SEARCH_PHRASES),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        EditorView.lineWrapping,
        editorTheme,
        syntaxHighlighting(markdownHighlight),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            callbacks.current.onChange(update.state.doc.toString());
          }
          if (update.docChanged || update.selectionSet) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            callbacks.current.onCursor({ ln: line.number, col: head - line.from + 1 });
          }
        }),
        EditorView.domEventHandlers({
          // 粘贴：剪贴板里有图片就存成归档资源并插入引用，其余情况交给默认行为。
          paste(event: ClipboardEvent): boolean {
            const items = event.clipboardData?.items;
            if (!items) return false;
            for (const item of items) {
              if (!item.type.startsWith("image/")) continue;
              const file = item.getAsFile();
              if (!file) continue;
              event.preventDefault();
              const ext = IMAGE_EXTENSIONS[file.type] ?? "png";
              const reader = new FileReader();
              reader.onload = () => {
                const dataUrl = String(reader.result ?? "");
                const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
                void callbacks.current.onPasteImage(base64, ext).then((key) => {
                  if (!key) return;
                  const snippet = `![](${key})`;
                  const range = view.state.selection.main;
                  view.dispatch({
                    changes: { from: range.from, to: range.to, insert: snippet },
                    selection: { anchor: range.from + snippet.length },
                  });
                  view.focus();
                });
              };
              reader.readAsDataURL(file);
              return true;
            }
            return false;
          },
        }),
      ],
    });

    callbacks.current.onView(view);

    const onScroll = () => {
      const el = view.scrollDOM;
      const max = el.scrollHeight - el.clientHeight;
      callbacks.current.onScrollRatio(max > 0 ? el.scrollTop / max : 0);
    };
    view.scrollDOM.addEventListener("scroll", onScroll);

    requestAnimationFrame(() => view.focus());

    return () => {
      view.scrollDOM.removeEventListener("scroll", onScroll);
      callbacks.current.onView(null);
      view.destroy();
    };
    // 文档切换由父组件用 key 重新挂载本组件，因此这里只构建一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className="editor-host" />;
}
