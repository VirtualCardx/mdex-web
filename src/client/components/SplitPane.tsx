/**
 * 左右分屏容器，中间是可拖拽的分隔条。
 * 拖拽逻辑移植自参考实现 `mdex\src\App.tsx` 的 `startResize`。
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  /** 两侧各自的宽度下限（px），保证拖到底也不会把某一侧挤没。 */
  minWidth?: number;
}

export default function SplitPane({ left, right, minWidth = 240 }: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftWidth, setLeftWidth] = useState<number | null>(null);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const startX = event.clientX;
    const startWidth = leftWidth ?? rect.width / 2;

    const onMove = (moveEvent: PointerEvent) => {
      const max = Math.max(minWidth, rect.width - minWidth);
      const next = startWidth + (moveEvent.clientX - startX);
      setLeftWidth(Math.min(Math.max(minWidth, next), max));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1">
      <div
        className="min-h-0 min-w-0 shrink-0 grow-0 overflow-hidden"
        style={{ width: leftWidth !== null ? `${leftWidth}px` : "50%" }}
      >
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        title="拖拽调整宽度"
        onPointerDown={startResize}
        className="z-10 -mx-[2.5px] w-[5px] shrink-0 cursor-col-resize hover:bg-accent/20 active:bg-accent/20"
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{right}</div>
    </div>
  );
}
