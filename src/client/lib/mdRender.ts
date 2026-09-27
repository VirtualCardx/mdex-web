/**
 * Markdown 渲染管线。移植自参考实现 `mdex\src\lib\markdown.ts`，并针对 Web 做了两处改造：
 *
 * 1. **资源解析注入**。桌面版把相对路径改写成 `mdexasset://` 自定义协议（由 Rust 端托管），
 *    浏览器里没有这种能力，因此改成一个由调用方注入的 `resolveAsset(key)`：
 *    预览页返回 `/api/docs/:id/asset?...`，编辑页返回内存资源的 blob URL。
 *    **两侧共用同一套渲染规则**，只有这一个函数不同。
 * 2. **消毒**。`html: true` 在桌面版是本地编辑器的合理特性，在 Web 上则是真实的存储型 XSS 面，
 *    因此渲染结果统一过 DOMPurify。
 */

import DOMPurify, { type Config } from "dompurify";
import hljs from "highlight.js";
import MarkdownIt from "markdown-it";
import * as mdKatexModule from "@vscode/markdown-it-katex";

/** 渲染环境：由调用方注入归档内相对路径 → 可加载 URL 的映射。 */
export interface RenderEnv {
  /**
   * 把归档 key（如 `assets/icon.png`）解析为可用的 URL。
   * 返回 `null` 表示该资源不存在，此时不输出 `<img>`。
   */
  resolveAsset?: (key: string) => string | null;
}

const md: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  highlight(code: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        // 落到 markdown-it 的默认转义
      }
    }
    return "";
  },
});

/**
 * 取出 `@vscode/markdown-it-katex` 真正的插件函数。
 *
 * 这个包只发布 CJS 产物（`exports.default = ...`，且带 `__esModule` 标记），
 * 而 Vite 8 用的 rolldown 对它的「默认导入」互操作与 esbuild 不同：
 * `import mdKatex from "..."` 在 dev 下拿到的是整个 `exports` 对象
 * （运行时报 `plugin.apply is not a function`），在生产构建里 `.default`
 * 也不是函数。因此改为命名空间导入，再沿 `.default` 逐层解包——两种构建
 * 下都能拿到插件函数；解不出来就直接抛错，避免渲染管线静默失效。
 */
function resolveKatexPlugin(): (md: MarkdownIt) => void {
  let candidate: unknown = mdKatexModule;
  for (let depth = 0; depth < 4 && candidate !== null && typeof candidate === "object"; depth += 1) {
    candidate = (candidate as Record<string, unknown>).default;
  }
  if (typeof candidate !== "function") {
    throw new Error("无法从 @vscode/markdown-it-katex 中解析出插件函数。");
  }
  return candidate as (md: MarkdownIt) => void;
}

md.use(resolveKatexPlugin());

/**
 * 极简 GFM task list 支持：markdown-it 默认把 `[x]` 当普通文本渲染。
 * 这条 core rule 把列表项开头的 `[ ]`/`[x]` 换成一个**禁用状态**的复选框
 * （禁用是刻意的：预览区的勾选不该改变源文本）。
 */
function taskListsPlugin(instance: MarkdownIt): void {
  instance.core.ruler.after("inline", "mdex-task-lists", (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      if (tokens[i].type !== "inline") continue;
      if (tokens[i - 1].type !== "paragraph_open") continue;
      const item = tokens[i - 2];
      if (item.type !== "list_item_open") continue;
      const children = tokens[i].children;
      const first = children?.[0];
      if (!first || first.type !== "text") continue;
      const match = /^\[([ xX])\]\s+/.exec(first.content);
      if (!match) continue;
      const checked = match[1].toLowerCase() === "x";
      first.content = first.content.slice(match[0].length);
      const nested = first.children?.[0];
      if (nested && nested.type === "text") {
        nested.content = nested.content.slice(match[0].length);
      }
      const checkbox = new state.Token("html_inline", "", 0);
      checkbox.content = `<input class="task-list-item-checkbox" type="checkbox"${checked ? " checked" : ""} disabled> `;
      children!.unshift(checkbox);
      item.attrJoin("class", "task-list-item");
    }
    return true;
  });
}

md.use(taskListsPlugin);

/** 带 scheme 的 URL（`http:`、`data:`、`mdexasset:` …）。 */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * 相对路径 → 归档 key。
 *
 * markdown 的目标可能已经是百分号编码的（带空格的路径必须如此，如 `assets/my%20image.png`），
 * 因此要逐段解码回原始 key；逐段而非整体解码是为了保住 `/` 分隔符。
 */
function toArchiveKey(src: string): string {
  return src
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

// 改写相对图片路径。
const defaultImageRule = md.renderer.rules.image;

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const src = token.attrGet("src") ?? "";
  const resolveAsset = (env as RenderEnv | null)?.resolveAsset;

  // 跳过带 scheme 的绝对 URL、页内锚点和站点绝对路径——它们本来就能直接用。
  if (resolveAsset && src && !HAS_SCHEME.test(src) && !src.startsWith("#") && !src.startsWith("/")) {
    const key = toArchiveKey(src);
    const resolved = resolveAsset(key);
    if (resolved === null) {
      // 资源不存在：整张图都不输出，而不是留一个会 404 的 src
      return "";
    }
    token.attrSet("src", resolved);
    token.attrSet("data-mdex-key", key);
    // 大型文档里几十张原图解码后可能占几百 MB 显存，惰性加载是必需品而非优化
    token.attrSet("loading", "lazy");
    token.attrSet("decoding", "async");
  }

  return defaultImageRule
    ? defaultImageRule(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
};

/**
 * DOMPurify 默认的 `ALLOWED_URI_REGEXP` 只放行
 * `ftp|ftps|http|https|mailto|tel|callto|sms|cid|xmpp|matrix` 这几种 scheme
 * （见 dompurify 3.4.16 源码 `IS_ALLOWED_URI`）。`blob:` 不在其中，若不修正，
 * **编辑页所有用 blob URL 的图片都会被剥掉 src**——这正是方案里要求实测的那一条。
 *
 * 这里在默认表达式的基础上追加 `blob`。放行 `blob:` 不构成新的 XSS 面：
 * blob URL 由浏览器的 `URL.createObjectURL` 生成、形如 `blob:<origin>/<uuid>`，
 * 攻击者无法在自己的文档里凭空写出一个有效的 blob URL，而文档内的脚本又被 CSP
 * （`script-src 'self'`）与 DOMPurify 双双挡掉。
 */
export const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

const PURIFY_CONFIG: Config = {
  ADD_TAGS: ["input"],
  ADD_ATTR: ["data-mdex-key", "target", "rel", "loading", "decoding"],
  ALLOWED_URI_REGEXP,
};

/**
 * 外链统一带上 `target="_blank" rel="noopener noreferrer"`。
 *
 * 用 DOMPurify 的 hook 而不是 markdown-it 的 `link_open` 规则，是为了让**文档里的裸 HTML**
 * `<a href="https://...">` 也一并被覆盖——只改 renderer 规则会漏掉这部分。
 */
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName !== "A") return;
  const href = node.getAttribute("href") ?? "";
  if (/^(https?:|mailto:)/i.test(href)) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** markdown → 已消毒的 HTML 字符串。 */
export function renderMarkdown(source: string, env: RenderEnv = {}): string {
  return DOMPurify.sanitize(md.render(source, env), PURIFY_CONFIG);
}
