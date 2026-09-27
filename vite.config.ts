import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

/**
 * 只在生产构建里注入 CSP。
 * 开发环境不能注入：`@vitejs/plugin-react` 的 HMR preamble 与 Vite 客户端都是内联脚本，
 * 严格的 `script-src 'self'` 会把它们拦掉，页面直接白屏。
 */
function cspPlugin(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    // CodeMirror 与 KaTeX 通过注入 <style> 元素加样式，必须放行内联样式
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    // fflate 的异步 API 用 Blob URL 起 Worker 做解压/压缩
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  return {
    name: "mdexweb:csp",
    apply: "build",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: csp },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare(), cspPlugin()],
  build: { sourcemap: true, chunkSizeWarningLimit: 2000 },
});
