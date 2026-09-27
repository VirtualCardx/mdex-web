/**
 * Markdown 正文渲染组件。
 *
 * 渲染结果通过 `dangerouslySetInnerHTML` 注入，但字符串已经过 DOMPurify 消毒
 * （见 `lib/mdRender.ts`），页面本身不执行任何来自文档的脚本。
 */

import { useMemo } from "react";

import { renderMarkdown } from "../lib/mdRender";

export interface MarkdownViewProps {
  source: string;
  /** 归档内相对路径 → URL；不传时相对路径原样保留。 */
  resolveAsset?: (key: string) => string | null;
  /**
   * 资源版本号。markdown 没变但资源变了（粘贴图片、改名、删除）时，
   * 必须靠它打破 memo 才会重新生成含新 blob URL 的 HTML。
   */
  assetVersion?: number;
  className?: string;
}

export default function MarkdownView({
  source,
  resolveAsset,
  assetVersion = 0,
  className,
}: MarkdownViewProps) {
  const html = useMemo(
    () => renderMarkdown(source, resolveAsset ? { resolveAsset } : {}),
    [source, resolveAsset, assetVersion],
  );

  return (
    <article
      className={className ? `md-body ${className}` : "md-body"}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
