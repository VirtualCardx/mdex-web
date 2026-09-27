/** `.mdex` 格式的常量与跨端共享类型。 */

export const MDEX_FORMAT = "mdex";
export const MDEX_VERSION = 1;
export const META_ENTRY = "meta.json";
export const DOC_ENTRY = "document.md";
export const ASSET_PREFIX = "assets/";

/**
 * `meta.json` 的内容。
 *
 * `created` / `modified` 一律按**原始字符串**保留，绝不做 `Date` 往返：参考实现写出的
 * 是 7 位小数（.NET round-trip 风格），JS 的 `toISOString()` 只有 3 位，往返会改变字节。
 *
 * 索引签名用于保留未知字段——参考实现用 serde 反序列化会丢弃它们，我们保留，这样
 * Web 端往返一次不会比桌面版丢更多信息。
 */
export interface MdexMeta {
  format: string;
  version: number;
  title?: string;
  created: string;
  modified: string;
  [unknown: string]: unknown;
}

export type MdexWarningCode =
  | "VERSION_LOWER"
  | "META_FIELDS_MISSING"
  | "MARKDOWN_FALLBACK"
  | "UNKNOWN_ENTRIES";

export interface MdexWarning {
  code: MdexWarningCode;
  message: string;
}

export interface MdexArchive {
  meta: MdexMeta;
  /** 归档里实际承载正文的路径。 */
  markdownPath: string;
  markdown: string;
  /** 归档内完整路径（如 `assets/foo.png`）→ 原始字节。 */
  assets: Map<string, Uint8Array>;
  /** `assets` 的 key，已排序，便于发给前端。 */
  assetKeys: string[];
  /** 归档里存在但被忽略的条目（参考实现同样忽略它们，仅为诊断）。 */
  ignoredEntries: string[];
  warnings: MdexWarning[];
}

/** 列表接口返回的文档摘要。 */
export interface DocSummary {
  id: string;
  title: string;
  size: number;
  assetCount: number;
  markdownPath: string;
  formatVersion: number;
  /** 乐观锁版本号，同时作为 `If-Match` 的值。 */
  rev: number;
  created: string;
  modified: string;
  updatedAt: string;
}

export interface DocList {
  items: DocSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DocDetail {
  doc: DocSummary;
  /** 正文缓存；为 null 表示正文过大未缓存，需改从 `/raw` 取整包。 */
  markdown: string | null;
  markdownPath: string;
  assetKeys: string[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; detail?: string };
}
