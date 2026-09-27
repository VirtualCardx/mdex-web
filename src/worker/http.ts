import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { MDEX_ERROR_MESSAGES, MdexError, type MdexErrorCode } from "../shared/mdexError";
import type { ApiErrorBody } from "../shared/types";

/** 与 `.mdex` 校验无关的接口级错误码。 */
export type ApiErrorCode =
  | "NOT_CONFIGURED"
  | "INVALID_CREDENTIALS"
  | "UNAUTHORIZED"
  | "FORBIDDEN_ORIGIN"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "PAYLOAD_TOO_LARGE"
  | "REVISION_MISMATCH"
  | "INTERNAL";

export type ErrorCode = ApiErrorCode | MdexErrorCode;

interface ErrorEntry {
  status: ContentfulStatusCode;
  message: string;
}

/**
 * 单一的错误码表：状态码 + 可直接展示的中文文案。
 * `.mdex` 那部分的文案直接复用 `MDEX_ERROR_MESSAGES`，避免两处措辞漂移。
 */
const ERRORS: Record<ErrorCode, ErrorEntry> = {
  NOT_CONFIGURED: { status: 503, message: "站点尚未配置访问口令，请在 Worker 里设置 MDEX_PASSWORD。" },
  INVALID_CREDENTIALS: { status: 401, message: "访问口令不正确。" },
  UNAUTHORIZED: { status: 401, message: "登录状态已失效，请重新登录。" },
  FORBIDDEN_ORIGIN: { status: 403, message: "请求来源不被信任。" },
  INVALID_REQUEST: { status: 400, message: "请求格式不正确。" },
  NOT_FOUND: { status: 404, message: "资源不存在。" },
  PAYLOAD_TOO_LARGE: { status: 413, message: "文件超出大小限制。" },
  REVISION_MISMATCH: { status: 409, message: "该文档已在别处被修改，请重新载入后再保存。" },
  INTERNAL: { status: 500, message: "服务器内部错误。" },

  EMPTY_FILE: { status: 400, message: MDEX_ERROR_MESSAGES.EMPTY_FILE },
  NOT_A_ZIP: { status: 400, message: MDEX_ERROR_MESSAGES.NOT_A_ZIP },
  META_MISSING: { status: 400, message: MDEX_ERROR_MESSAGES.META_MISSING },
  META_INVALID_JSON: { status: 400, message: MDEX_ERROR_MESSAGES.META_INVALID_JSON },
  META_INVALID_FORMAT: { status: 400, message: MDEX_ERROR_MESSAGES.META_INVALID_FORMAT },
  UNSUPPORTED_VERSION: { status: 415, message: MDEX_ERROR_MESSAGES.UNSUPPORTED_VERSION },
  MARKDOWN_MISSING: { status: 400, message: MDEX_ERROR_MESSAGES.MARKDOWN_MISSING },
  TOO_LARGE: { status: 413, message: MDEX_ERROR_MESSAGES.TOO_LARGE },
  TOO_MANY_ENTRIES: { status: 400, message: MDEX_ERROR_MESSAGES.TOO_MANY_ENTRIES },
  BUILD_FAILED: { status: 500, message: MDEX_ERROR_MESSAGES.BUILD_FAILED },
};

/** 统一的 JSON 错误响应体。`detail` 只用于排障，不含预期外的内部信息。 */
export function apiError(c: Context, code: ErrorCode, detail?: string): Response {
  const entry = ERRORS[code];
  const body: ApiErrorBody = {
    error: { code, message: entry.message, ...(detail ? { detail } : {}) },
  };
  return c.json(body, entry.status);
}

/** 把任意异常归一成 JSON 错误。`MdexError` 的 code/文案直接透传，其余记日志后返回 500。 */
export function failFromUnknown(c: Context, e: unknown): Response {
  if (e instanceof MdexError) return apiError(c, e.code, e.detail);
  console.error("[mdexweb] 未处理的错误:", e);
  return apiError(c, "INTERNAL");
}
