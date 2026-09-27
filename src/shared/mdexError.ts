/**
 * `.mdex` 解析/打包的错误类型。
 *
 * `message` 直接就是可展示的中文文案，UI 层 `catch` 后丢进 toast 即可；
 * `code` 用于分支逻辑（例如 `UNSUPPORTED_VERSION` 时应禁用保存，避免降级破坏文件）。
 */

export type MdexErrorCode =
  | "EMPTY_FILE"
  | "NOT_A_ZIP"
  | "META_MISSING"
  | "META_INVALID_JSON"
  | "META_INVALID_FORMAT"
  | "UNSUPPORTED_VERSION"
  | "MARKDOWN_MISSING"
  | "TOO_LARGE"
  | "TOO_MANY_ENTRIES"
  | "BUILD_FAILED";

export const MDEX_ERROR_MESSAGES: Record<MdexErrorCode, string> = {
  EMPTY_FILE: "文件为空，可能上传不完整。",
  NOT_A_ZIP: "这不是有效的 .mdex 文件（ZIP 结构已损坏或使用了不支持的压缩方式）。",
  META_MISSING: "文件缺少 meta.json，不是有效的 .mdex 文档。",
  META_INVALID_JSON: "meta.json 格式错误，无法解析元数据。",
  META_INVALID_FORMAT: "该文件不是 mdex 格式（无法识别的 format 字段）。",
  UNSUPPORTED_VERSION: "文件由更新版本的 mdex 创建，当前站点暂不支持。",
  MARKDOWN_MISSING: "压缩包内找不到 Markdown 正文文件。",
  TOO_LARGE: "文件过大，超出当前允许的上限。",
  TOO_MANY_ENTRIES: "压缩包内文件数量异常，已拒绝解析。",
  BUILD_FAILED: "打包 .mdex 时出错。",
};

export class MdexError extends Error {
  readonly code: MdexErrorCode;
  /** 技术细节，只进日志与 API 响应的 detail 字段，不直接展示给用户。 */
  readonly detail?: string;

  constructor(code: MdexErrorCode, detail?: string) {
    super(MDEX_ERROR_MESSAGES[code]);
    this.name = "MdexError";
    this.code = code;
    this.detail = detail;
  }
}

/** 把任意异常归一为 `MdexError`，让调用方只需处理一种类型。 */
export function toMdexError(e: unknown, fallback: MdexErrorCode = "NOT_A_ZIP"): MdexError {
  if (e instanceof MdexError) return e;
  return new MdexError(fallback, e instanceof Error ? e.message : String(e));
}
