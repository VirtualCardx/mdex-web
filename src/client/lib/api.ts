/**
 * 后端 API 的 fetch 封装。
 *
 * 三件事集中在这里做：
 * 1. JSON 解析 —— 调用方拿到的是类型化的对象，不是 `Response`。
 * 2. 错误归一 —— 所有失败都变成 `ApiError`（`code` + 可直接展示的中文 `message`），
 *    调用方只需 `catch` 一种类型，不必各自解析错误体。
 * 3. 401 处理 —— 会话失效时抛 `UnauthorizedError`，同时通知全局跳转 `/login`。
 */

import type { ApiErrorBody, DocDetail, DocList, DocSummary } from "../../shared/types";

export interface SessionInfo {
  authenticated: boolean;
  configured: boolean;
  expiresAt: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** 仅用于排障的技术细节，不要直接展示。 */
  readonly detail: string | undefined;

  constructor(status: number, code: string, message: string, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** 会话失效（`code === "UNAUTHORIZED"`）专用异常，便于全局统一跳登录页。 */
export class UnauthorizedError extends ApiError {
  constructor(code: string, message: string, detail?: string) {
    super(401, code, message, detail);
    this.name = "UnauthorizedError";
  }
}

/** 可由 `App` 注册的「会话失效」回调；不注册时静默，仅抛异常。 */
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

interface RequestOptions {
  method?: string;
  body?: BodyInit | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * 该请求的 401 只当作普通错误（不触发全局跳转）。
   * 登录接口用它：口令错误也是 401，但此时用户就在登录页。
   */
  localUnauthorized?: boolean;
}

async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body ?? null,
    signal: options.signal,
  });

  if (!response.ok) {
    const error = await toApiError(response);
    if (error instanceof UnauthorizedError && !options.localUnauthorized) {
      unauthorizedHandler?.();
    }
    throw error;
  }
  return response;
}

async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await request(path, options);
  return (await response.json()) as T;
}

/** 把非 2xx 响应归一为 `ApiError`；响应体不是 JSON 时用兜底文案。 */
async function toApiError(response: Response): Promise<ApiError> {
  let code = "INTERNAL";
  let message = `请求失败（HTTP ${response.status}）`;
  let detail: string | undefined;
  try {
    const body = (await response.json()) as ApiErrorBody;
    if (body?.error) {
      code = body.error.code;
      message = body.error.message || message;
      detail = body.error.detail;
    }
  } catch {
    // 非 JSON 响应（如静态资源 404 返回 HTML），保留兜底文案
  }
  // 只有会话失效才用 UnauthorizedError。登录接口的 INVALID_CREDENTIALS 同样是 401，
  // 若一并算作「未登录」会在登录页引起无意义的重复跳转。
  if (response.status === 401 && code === "UNAUTHORIZED") {
    return new UnauthorizedError(code, message, detail);
  }
  return new ApiError(response.status, code, message, detail);
}

/** 任意异常 → 可展示的中文文案。 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 把 ZIP 字节交给 fetch/XHR 时用的类型收窄。
 *
 * TypeScript 5.7 起 `lib.dom` 把 `BodyInit` 收窄为 `ArrayBufferView<ArrayBuffer>`，
 * 而 fflate 返回的是 `Uint8Array<ArrayBufferLike>`，两者在运行时完全一致，
 * 只是类型系统无法证明。这里刻意**不复制字节**——上传 32MB 文档时多复制一份
 * 是实打实的内存与时间开销，换来的是一个纯类型层面的干净。
 *
 * 返回类型取 `BodyInit & XMLHttpRequestBodyInit` 的交集，是为了同时喂给
 * `fetch`（`BodyInit`）与 `XMLHttpRequest.send`（`XMLHttpRequestBodyInit`）。
 */
function toBodyInit(bytes: Uint8Array): BodyInit & XMLHttpRequestBodyInit {
  return bytes as unknown as BodyInit & XMLHttpRequestBodyInit;
}

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------

export function getSession(signal?: AbortSignal): Promise<SessionInfo> {
  // session 接口本身不鉴权，但网络异常时也要能给出可读提示
  return requestJson<SessionInfo>("/api/auth/session", { signal, localUnauthorized: true });
}

export function login(password: string): Promise<{ authenticated: boolean; expiresAt: string }> {
  return requestJson("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    localUnauthorized: true,
  });
}

export async function logout(): Promise<void> {
  await request("/api/auth/logout", { method: "POST", localUnauthorized: true });
}

// ---------------------------------------------------------------------------
// 文档
// ---------------------------------------------------------------------------

export interface ListQuery {
  q?: string;
  sort?: string;
  order?: string;
  page?: number;
  pageSize?: number;
}

export function listDocs(query: ListQuery, signal?: AbortSignal): Promise<DocList> {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.sort) params.set("sort", query.sort);
  if (query.order) params.set("order", query.order);
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
  return requestJson<DocList>(`/api/docs?${params.toString()}`, { signal });
}

export function getDoc(id: string, signal?: AbortSignal): Promise<DocDetail> {
  return requestJson<DocDetail>(`/api/docs/${encodeURIComponent(id)}`, { signal });
}

/** 下载整包并解成字节。编辑页与大文档预览页用它。 */
export async function fetchRaw(id: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await request(rawUrl(id), { signal });
  return new Uint8Array(await response.arrayBuffer());
}

export function createDoc(bytes: Uint8Array, filename: string): Promise<{ doc: DocSummary }> {
  return requestJson("/api/docs", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-mdex",
      "X-Mdex-Filename": encodeURIComponent(filename),
    },
    body: toBodyInit(bytes),
  });
}

/** 乐观锁保存：`rev` 与 `If-Match` 不匹配时抛 409 `REVISION_MISMATCH`。 */
export function updateDoc(id: string, bytes: Uint8Array, rev: number): Promise<{ doc: DocSummary }> {
  return requestJson(`/api/docs/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/x-mdex",
      "If-Match": `"${rev}"`,
    },
    body: toBodyInit(bytes),
  });
}

export function renameDoc(id: string, title: string): Promise<{ doc: DocSummary }> {
  return requestJson(`/api/docs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export async function deleteDoc(id: string): Promise<void> {
  await request(`/api/docs/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function rawUrl(id: string): string {
  return `/api/docs/${encodeURIComponent(id)}/raw`;
}

/**
 * 单个资源的直链。
 *
 * `rev` 在这里只是浏览器的缓存键（服务端忽略它），但它是必要的：不带上它，
 * 保存后 rev 变化而 URL 不变，浏览器会继续用 `immutable` 的旧缓存。
 */
export function assetUrl(id: string, key: string, rev: number): string {
  return `/api/docs/${encodeURIComponent(id)}/asset?key=${encodeURIComponent(key)}&v=${rev}`;
}

// ---------------------------------------------------------------------------
// 上传（带进度）
// ---------------------------------------------------------------------------

export interface UploadProgress {
  loaded: number;
  total: number;
}

function toXhrError(xhr: XMLHttpRequest): ApiError {
  const body = xhr.response as ApiErrorBody | null;
  const info = body?.error;
  return new ApiError(
    xhr.status,
    info?.code ?? "INTERNAL",
    info?.message ?? `上传失败（HTTP ${xhr.status}）`,
    info?.detail,
  );
}

/**
 * 用 XHR 上传，只为了能拿到真实的上传进度（fetch 没有上传进度事件）。
 * 32MB 上限下进度条体验值得这一份复杂度。
 */
export function uploadDoc(
  bytes: Uint8Array,
  filename: string,
  onProgress?: (progress: UploadProgress) => void,
): Promise<DocSummary> {
  return new Promise<DocSummary>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/docs");
    xhr.responseType = "json";
    xhr.setRequestHeader("Content-Type", "application/x-mdex");
    xhr.setRequestHeader("X-Mdex-Filename", encodeURIComponent(filename));

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress({ loaded: event.loaded, total: event.total });
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const body = xhr.response as { doc?: DocSummary } | null;
        if (body?.doc) {
          resolve(body.doc);
        } else {
          reject(new ApiError(xhr.status, "INTERNAL", "上传成功但响应缺少 doc 字段。"));
        }
        return;
      }
      if (xhr.status === 401) {
        unauthorizedHandler?.();
        reject(new UnauthorizedError("UNAUTHORIZED", "登录状态已失效，请重新登录。"));
        return;
      }
      reject(toXhrError(xhr));
    };

    xhr.onerror = () => reject(new ApiError(0, "NETWORK", "网络错误，上传失败。"));
    xhr.send(toBodyInit(bytes));
  });
}
