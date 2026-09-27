/**
 * 预览正文的左右边距偏好：正常边距 / 窄边距。
 *
 * 与主题偏好（`App.tsx` 里的 `mdex.theme`）同一套路：落在 localStorage，
 * 通过 `<html>` 上的 `data-margin` 属性驱动 CSS 变量。这样切换只需要改一个属性，
 * 不必让 markdown 的渲染结果失效重建（`MarkdownView` 的 html 是 memo 过的）。
 */

import { useState } from "react";

export type MarginMode = "normal" | "narrow";

const MARGIN_KEY = "mdex.margin";

function readMargin(): MarginMode {
  try {
    return localStorage.getItem(MARGIN_KEY) === "narrow" ? "narrow" : "normal";
  } catch {
    // localStorage 不可用：退回正常边距
    return "normal";
  }
}

function writeMargin(mode: MarginMode): void {
  document.documentElement.dataset.margin = mode;
  try {
    localStorage.setItem(MARGIN_KEY, mode);
  } catch {
    // 写入失败：偏好只在本次会话生效
  }
}

// 与主题一样在首帧之前把属性写到 <html> 上，避免先按正常边距画一次再跳到窄边距。
const initialMargin = readMargin();
document.documentElement.dataset.margin = initialMargin;

export function useMarginMode(): { mode: MarginMode; toggle: () => void } {
  const [mode, setMode] = useState<MarginMode>(initialMargin);

  const toggle = () => {
    const next: MarginMode = mode === "normal" ? "narrow" : "normal";
    setMode(next);
    writeMargin(next);
  };

  return { mode, toggle };
}
