/**
 * 工具栏的文本变换。移植自参考实现 `mdex\src\lib\actions.ts`。
 *
 * 每个函数接收 CodeMirror 的 `EditorView`，派发一次 transaction，最后把焦点还给编辑器
 * —— 否则点了工具栏按钮后光标就丢了，用户必须再点回正文才能继续输入。
 */

import type { EditorView } from "@codemirror/view";

/** 用标记（如 `**`、`` ` ``）包裹选中内容；已经包裹过则取消包裹。 */
export function wrapSelection(view: EditorView, before: string, after = before): void {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);
  const minLen = before.length + after.length;

  if (selected.length >= minLen && selected.startsWith(before) && selected.endsWith(after)) {
    const inner = selected.slice(before.length, selected.length - after.length);
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: inner },
      selection: { anchor: range.from, head: range.from + inner.length },
    });
  } else {
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: before + selected + after },
      selection: {
        anchor: range.from + before.length,
        head: range.from + before.length + selected.length,
      },
    });
  }
  view.focus();
}

/** 对选中的每一行套用同一个变换。 */
function mapLines(view: EditorView, fn: (line: string, index: number) => string): void {
  const { state } = view;
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from).number;
  const last = state.doc.lineAt(range.to).number;
  const changes = [];
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    const next = fn(line.text, n - first);
    if (next !== line.text) {
      changes.push({ from: line.from, to: line.to, insert: next });
    }
  }
  if (changes.length > 0) {
    view.dispatch({ changes });
  }
  view.focus();
}

/** 切换行前缀（如 `> `、`- `）：所有行都有则移除，否则统一加上。 */
export function toggleLinePrefix(view: EditorView, prefix: string): void {
  const { state } = view;
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from).number;
  const last = state.doc.lineAt(range.to).number;
  const lines: string[] = [];
  for (let n = first; n <= last; n++) lines.push(state.doc.line(n).text);
  const allHave = lines.every(
    (l) => l.trim().length === 0 || l.trimStart().startsWith(prefix.trimStart()),
  );
  mapLines(view, (line) => {
    if (allHave) {
      return line.replace(/^(\s*)([-*+]\s\[ \]\s|[-*+]\s|>\s|\d+\.\s)/, "$1");
    }
    if (line.trim().length === 0) return line;
    return prefix + line;
  });
}

/** 切换 ATX 标题级别；先剥掉已有标题标记，再按需加上。 */
export function toggleHeading(view: EditorView, level: number): void {
  const marker = "#".repeat(level) + " ";
  mapLines(view, (line) => {
    if (line.trim().length === 0) return line;
    const stripped = line.replace(/^(\s*)#{1,6}\s+/, "$1");
    const current = line.match(/^\s*(#{1,6})\s+/);
    // 再次点击同一级别 = 取消标题
    if (current && current[1].length === level) return stripped;
    return marker + stripped;
  });
}

/** 把选中行变成有序列表（1. 2. 3. …）；已是有序列表则取消。 */
export function toggleOrderedList(view: EditorView): void {
  const { state } = view;
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from).number;
  const last = state.doc.lineAt(range.to).number;
  const anyNumbered = (() => {
    for (let n = first; n <= last; n++) {
      if (/^\s*\d+\.\s/.test(state.doc.line(n).text)) return true;
    }
    return false;
  })();
  if (anyNumbered) {
    mapLines(view, (line) => line.replace(/^(\s*)\d+\.\s+/, "$1"));
  } else {
    mapLines(view, (line, index) => (line.trim().length === 0 ? line : `${index + 1}. ${line}`));
  }
}

/** 用块级标记（如代码围栏）包裹选中内容。 */
export function wrapBlock(view: EditorView, before: string, after: string): void {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);
  const insert = `${before}${selected}${after}`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: {
      anchor: range.from + before.length,
      head: range.from + before.length + selected.length,
    },
  });
  view.focus();
}

/** 在光标处插入任意文本（有选区则替换）。 */
export function insertText(view: EditorView, text: string): void {
  const range = view.state.selection.main;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length },
  });
  view.focus();
}

/** 插入 markdown 链接；选区是 URL 时把它当链接地址，否则当链接文字。 */
export function insertLink(view: EditorView): void {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);
  const isUrl = /^(https?:\/\/|mailto:)/i.test(selected);
  const label = isUrl ? "link" : selected || "link";
  const url = isUrl ? selected : "https://";
  insertText(view, `[${label}](${url})`);
}

/** 插入指向归档内资源的图片引用。 */
export function insertImageRef(view: EditorView, key: string, alt: string): void {
  const safeAlt = alt.replace(/[\[\]]/g, "");
  insertText(view, `![${safeAlt}](${key})`);
}

/** 插入的表格骨架（空行开头，保证与上一段分开）。 */
export const TABLE_SNIPPET = `
| Column A | Column B |
| -------- | -------- |
| Cell     | Cell     |
`;

/** 工具栏动作分发。id 未知时返回 false。 */
export function runFormatAction(view: EditorView, id: string): boolean {
  switch (id) {
    case "bold":
      wrapSelection(view, "**");
      return true;
    case "italic":
      wrapSelection(view, "*");
      return true;
    case "strike":
      wrapSelection(view, "~~");
      return true;
    case "codeInline":
      wrapSelection(view, "`");
      return true;
    case "codeBlock":
      wrapBlock(view, "```\n", "\n```");
      return true;
    case "h1":
      toggleHeading(view, 1);
      return true;
    case "h2":
      toggleHeading(view, 2);
      return true;
    case "h3":
      toggleHeading(view, 3);
      return true;
    case "quote":
      toggleLinePrefix(view, "> ");
      return true;
    case "ul":
      toggleLinePrefix(view, "- ");
      return true;
    case "ol":
      toggleOrderedList(view);
      return true;
    case "task":
      toggleLinePrefix(view, "- [ ] ");
      return true;
    case "link":
      insertLink(view);
      return true;
    case "table":
      insertText(view, TABLE_SNIPPET);
      return true;
    case "hr":
      insertText(view, "\n\n---\n\n");
      return true;
    default:
      return false;
  }
}
