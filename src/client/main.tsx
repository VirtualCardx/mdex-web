import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// highlight.js 与 KaTeX 的样式必须先于应用的 index.css 之外加载，
// 否则代码块只有 hljs-* 类名而没有配色，公式排版也会全乱。
import "highlight.js/styles/github-dark.css";
import "katex/dist/katex.min.css";
import "./index.css";

import App from "./App";

const container = document.getElementById("root");
if (!container) throw new Error("找不到 #root 容器");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
