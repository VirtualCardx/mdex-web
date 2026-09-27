/**
 * 编辑页的格式化工具栏。按钮 id 与 `lib/actions.ts` 的 `runFormatAction` 一一对应。
 */

export interface FormatButton {
  id: string;
  label: string;
  title: string;
  className?: string;
}

const BUTTONS: FormatButton[] = [
  { id: "bold", label: "B", title: "加粗（**文本**）", className: "font-extrabold" },
  { id: "italic", label: "I", title: "斜体（*文本*）", className: "font-serif italic" },
  { id: "strike", label: "S", title: "删除线（~~文本~~）", className: "line-through" },
  { id: "codeInline", label: "</>", title: "行内代码（`代码`）" },
  { id: "codeBlock", label: "{ }", title: "代码块（```）" },
  { id: "h1", label: "H1", title: "一级标题" },
  { id: "h2", label: "H2", title: "二级标题" },
  { id: "h3", label: "H3", title: "三级标题" },
  { id: "quote", label: "”", title: "引用" },
  { id: "ul", label: "• —", title: "无序列表" },
  { id: "ol", label: "1.", title: "有序列表" },
  { id: "task", label: "☐", title: "任务列表" },
  { id: "link", label: "链接", title: "插入链接" },
  { id: "table", label: "▦", title: "插入表格" },
  { id: "hr", label: "─", title: "分割线" },
];

interface ToolbarProps {
  onAction: (id: string) => void;
  disabled?: boolean;
}

export default function Toolbar({ onAction, disabled = false }: ToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label="编辑器工具栏"
      className="flex min-h-[42px] flex-wrap items-center gap-0.5 border-b border-line bg-panel px-2.5 py-1"
    >
      {/* 查找不是文本变换，所以不进 BUTTONS：那个数组的 id 要严格对应 runFormatAction。 */}
      <button
        type="button"
        disabled={disabled}
        title="查找 / 替换（Ctrl+F）"
        onClick={() => onAction("find")}
        className="h-7 min-w-7 rounded-md px-2 text-xs font-medium text-fg transition-colors hover:bg-raised active:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-40"
      >
        查找
      </button>
      <span className="mx-1.5 h-5 w-px bg-line" aria-hidden="true" />

      {BUTTONS.map((button, index) => (
        <span key={button.id} className="flex items-center gap-0.5">
          {(index === 3 || index === 5 || index === 8 || index === 12) && (
            <span className="mx-1.5 h-5 w-px bg-line" aria-hidden="true" />
          )}
          <button
            type="button"
            disabled={disabled}
            title={button.title}
            onClick={() => onAction(button.id)}
            className={`h-7 min-w-7 rounded-md px-2 text-xs font-medium text-fg transition-colors hover:bg-raised active:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-40 ${button.className ?? ""}`}
          >
            {button.label}
          </button>
        </span>
      ))}
    </div>
  );
}
