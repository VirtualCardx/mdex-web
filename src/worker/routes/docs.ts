import { Hono } from "hono";
import type { Context } from "hono";

import { extractAssetsSync, parseMdexSync } from "../../shared/mdex";
import { nowRfc3339 } from "../../shared/time";
import { ASSET_PREFIX, type DocDetail, type DocSummary, type MdexArchive } from "../../shared/types";
import {
  MARKDOWN_CACHE_LIMIT,
  commitContentUpdate,
  commitTitle,
  findDoc,
  insertDoc,
  listDocs,
  parseAssetKeys,
  parseListParams,
  removeDoc,
  toSummary,
} from "../db";
import { VALIDATION_LIMITS, assetLimits, readConfig, type AppConfig, type AppEnv } from "../env";
import { apiError, failFromUnknown } from "../http";
import {
  archiveKey,
  assetKey,
  deleteDocObjects,
  deletePrefix,
  pruneRevisions,
  putAssets,
  revisionPrefix,
} from "../storage";

const app = new Hono<AppEnv>();

/** 标题长度上限，避免超长标题把列表撑坏。 */
const TITLE_MAX_LENGTH = 200;

// ---------------------------------------------------------------------------
// 公共逻辑
// ---------------------------------------------------------------------------

/** 从归档解析出的、需要写进 D1 的字段。 */
interface StoredFields {
  title: string;
  markdownPath: string;
  formatVersion: number;
  size: number;
  assetKeys: string[];
  markdown: string | null;
  created: string;
  modified: string;
}

function clampTitle(title: string): string {
  return title.slice(0, TITLE_MAX_LENGTH);
}

/**
 * 标题的权威来源是**归档内的 meta.json**：它才是能被桌面版读到的值。
 * `X-Mdex-Filename` 只是文件本身没写标题时的回退（中文文件名必须走
 * `encodeURIComponent`，因为 HTTP header 值是 latin-1）。
 */
function resolveTitle(archive: MdexArchive, filenameHeader: string | undefined): string {
  const fromMeta = typeof archive.meta.title === "string" ? archive.meta.title.trim() : "";
  if (fromMeta) return clampTitle(fromMeta);

  if (filenameHeader) {
    try {
      const decoded = decodeURIComponent(filenameHeader).replace(/\.mdex$/i, "").trim();
      if (decoded) return clampTitle(decoded);
    } catch {
      // 非法百分号编码，忽略这个回退来源
    }
  }
  return "未命名文档";
}

/**
 * 正文缓存。`length` 是 UTF-16 码元数而非字节数，作为缓存阈值够用 ——
 * 这里要的是「大得没必要缓存」，不是精确的字节统计。
 */
function cacheMarkdown(markdown: string): string | null {
  return markdown.length > MARKDOWN_CACHE_LIMIT ? null : markdown;
}

function fieldsFrom(archive: MdexArchive, byteLength: number, title: string): StoredFields {
  return {
    title,
    markdownPath: archive.markdownPath,
    formatVersion: archive.meta.version,
    size: byteLength,
    assetKeys: archive.assetKeys,
    markdown: cacheMarkdown(archive.markdown),
    created: archive.meta.created,
    modified: archive.meta.modified,
  };
}

interface Upload {
  bytes: Uint8Array;
  archive: MdexArchive;
}

/**
 * 读取并校验上传的压缩包。
 *
 * 先看 `Content-Length`：超限时连 body 都不读，这是最省资源的失败方式。
 * 校验用 `VALIDATION_LIMITS`（只解压 meta.json 与正文），图片字节完全不进内存。
 */
async function readUpload(c: Context<AppEnv>, cfg: AppConfig): Promise<Upload | Response> {
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cfg.maxUploadBytes) {
    return apiError(c, "PAYLOAD_TOO_LARGE", `Content-Length ${declared} 超过上限 ${cfg.maxUploadBytes}`);
  }

  const body = await c.req.arrayBuffer();
  if (body.byteLength > cfg.maxUploadBytes) {
    return apiError(c, "PAYLOAD_TOO_LARGE", `实际 ${body.byteLength} 字节超过上限 ${cfg.maxUploadBytes}`);
  }

  const bytes = new Uint8Array(body);
  try {
    return { bytes, archive: parseMdexSync(bytes, VALIDATION_LIMITS) };
  } catch (e) {
    return failFromUnknown(c, e);
  }
}

/** 把资源拆成独立 R2 对象。调用方负责在失败时回收整个修订版目录。 */
async function persistRevision(
  c: Context<AppEnv>,
  id: string,
  rev: number,
  bytes: Uint8Array,
  cfg: AppConfig,
): Promise<void> {
  await c.env.BUCKET.put(archiveKey(id, rev), bytes, {
    httpMetadata: { contentType: "application/x-mdex" },
  });
  await putAssets(c.env.BUCKET, id, rev, extractAssetsSync(bytes, assetLimits(cfg)));
}

function isResponse(value: Upload | Response): value is Response {
  return value instanceof Response;
}

/** `If-Match` 里可能是 `"3"` 或 `3`，两种都认。 */
function parseIfMatch(header: string | undefined): number | null {
  if (header === undefined) return null;
  const value = Number(header.replaceAll('"', "").trim());
  return Number.isInteger(value) && value > 0 ? value : Number.NaN;
}

// ---------------------------------------------------------------------------
// 列表 / 上传
// ---------------------------------------------------------------------------

app.get("/", async (c) => {
  const params = parseListParams(new URL(c.req.url).searchParams);
  return c.json(await listDocs(c.env.DB, params));
});

app.post("/", async (c) => {
  const cfg = readConfig(c.env);
  const upload = await readUpload(c, cfg);
  if (isResponse(upload)) return upload;

  const { bytes, archive } = upload;
  const id = crypto.randomUUID();
  const now = nowRfc3339();
  const fields = fieldsFrom(archive, bytes.byteLength, resolveTitle(archive, c.req.header("x-mdex-filename")));

  try {
    await persistRevision(c, id, 1, bytes, cfg);
  } catch (e) {
    await deleteDocObjects(c.env.BUCKET, id);
    throw e;
  }

  try {
    await insertDoc(c.env.DB, {
      id,
      r2Key: archiveKey(id, 1),
      now,
      title: fields.title,
      markdownPath: fields.markdownPath,
      formatVersion: fields.formatVersion,
      size: fields.size,
      assetKeys: fields.assetKeys,
      markdown: fields.markdown,
      created: fields.created,
      modified: fields.modified,
    });
  } catch (e) {
    // 补偿：绝不留下没有索引的孤儿对象
    await deleteDocObjects(c.env.BUCKET, id);
    throw e;
  }

  const doc: DocSummary = {
    id,
    title: fields.title,
    size: fields.size,
    assetCount: fields.assetKeys.length,
    markdownPath: fields.markdownPath,
    formatVersion: fields.formatVersion,
    rev: 1,
    created: fields.created,
    modified: fields.modified,
    updatedAt: now,
  };
  return c.json({ doc }, 201, { Location: `/api/docs/${id}` });
});

// ---------------------------------------------------------------------------
// 单文档
// ---------------------------------------------------------------------------

app.get("/:id", async (c) => {
  const row = await findDoc(c.env.DB, c.req.param("id"));
  if (!row) return apiError(c, "NOT_FOUND");

  const detail: DocDetail = {
    doc: toSummary(row),
    markdown: row.markdown,
    markdownPath: row.markdown_path,
    assetKeys: parseAssetKeys(row.asset_keys),
  };
  return c.json(detail);
});

app.put("/:id", async (c) => {
  const cfg = readConfig(c.env);
  const id = c.req.param("id");

  const existing = await findDoc(c.env.DB, id);
  if (!existing) return apiError(c, "NOT_FOUND");

  // If-Match 只是提前给出友好的 409；真正的提交点仍是 UPDATE 里的 `AND rev = ?`
  const ifMatch = parseIfMatch(c.req.header("if-match"));
  if (ifMatch !== null && ifMatch !== existing.rev) {
    return apiError(c, "REVISION_MISMATCH", `If-Match=${ifMatch}，当前 rev=${existing.rev}`);
  }

  const upload = await readUpload(c, cfg);
  if (isResponse(upload)) return upload;

  const { bytes, archive } = upload;
  const fields = fieldsFrom(archive, bytes.byteLength, resolveTitle(archive, c.req.header("x-mdex-filename")));
  const nextRev = existing.rev + 1;
  const now = nowRfc3339();

  // 先落 R2、后提交 D1：D1 的 UPDATE 是唯一提交点，失败者的对象全在自己的 rev 目录里
  try {
    await persistRevision(c, id, nextRev, bytes, cfg);
  } catch (e) {
    await deletePrefix(c.env.BUCKET, revisionPrefix(id, nextRev));
    throw e;
  }

  const committed = await commitContentUpdate(c.env.DB, id, existing.rev, {
    title: fields.title,
    markdownPath: fields.markdownPath,
    formatVersion: fields.formatVersion,
    size: fields.size,
    assetKeys: fields.assetKeys,
    r2Key: archiveKey(id, nextRev),
    markdown: fields.markdown,
    created: fields.created,
    modified: fields.modified,
    now,
  });

  if (!committed) {
    // 并发的另一个写者抢到了同一个修订号，我们这份无人引用，整目录回收
    await deletePrefix(c.env.BUCKET, revisionPrefix(id, nextRev));
    return apiError(c, "REVISION_MISMATCH");
  }

  await pruneRevisions(c.env.BUCKET, id, nextRev);

  const doc: DocSummary = {
    id,
    title: fields.title,
    size: fields.size,
    assetCount: fields.assetKeys.length,
    markdownPath: fields.markdownPath,
    formatVersion: fields.formatVersion,
    rev: nextRev,
    created: fields.created,
    modified: fields.modified,
    updatedAt: now,
  };
  return c.json({ doc });
});

app.patch("/:id", async (c) => {
  const id = c.req.param("id");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, "INVALID_REQUEST", "请求体不是合法 JSON");
  }

  const raw =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>).title : undefined;
  if (typeof raw !== "string") return apiError(c, "INVALID_REQUEST", "缺少 title 字段");

  const title = clampTitle(raw.trim());
  if (!(await commitTitle(c.env.DB, id, title, nowRfc3339()))) {
    return apiError(c, "NOT_FOUND");
  }

  const row = await findDoc(c.env.DB, id);
  if (!row) return apiError(c, "NOT_FOUND");
  return c.json({ doc: toSummary(row) });
});

app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await findDoc(c.env.DB, id);
  if (!row) return apiError(c, "NOT_FOUND");

  await removeDoc(c.env.DB, id);
  await deleteDocObjects(c.env.BUCKET, id);
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// 二进制端点
// ---------------------------------------------------------------------------

/** 生成同时兼容新旧浏览器的 `Content-Disposition`（非 ASCII 文件名必须走 `filename*`）。 */
function contentDisposition(title: string): string {
  const base = (title.trim() || "document").replace(/[\r\n"\\/]/g, "_").slice(0, 80) || "document";
  const ascii = base.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}.mdex"; filename*=UTF-8''${encodeURIComponent(`${base}.mdex`)}`;
}

app.get("/:id/raw", async (c) => {
  const row = await findDoc(c.env.DB, c.req.param("id"));
  if (!row) return apiError(c, "NOT_FOUND");

  const object = await c.env.BUCKET.get(row.r2_key);
  if (!object) {
    console.error(`[mdexweb] R2 对象缺失: ${row.r2_key}`);
    return apiError(c, "NOT_FOUND", "归档对象不存在");
  }

  const headers = new Headers({
    "Content-Type": "application/x-mdex",
    "Content-Length": String(object.size),
    "Content-Disposition": contentDisposition(row.title),
    // rev 变化即内容变化，因此它天然是合格的 ETag
    ETag: `"${row.rev}"`,
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(object.body, { headers });
});

app.get("/:id/asset", async (c) => {
  const row = await findDoc(c.env.DB, c.req.param("id"));
  if (!row) return apiError(c, "NOT_FOUND");

  const key = c.req.query("key") ?? "";
  // 只放行本归档自己的资源路径，挡掉 `..` 与绝对路径
  if (!key.startsWith(ASSET_PREFIX) || key.includes("..") || key.includes("\\")) {
    return apiError(c, "INVALID_REQUEST", `非法资源 key: ${key}`);
  }

  const object = await c.env.BUCKET.get(assetKey(row.id, row.rev, key));
  if (!object) return apiError(c, "NOT_FOUND", `资源不存在: ${key}`);

  const headers = new Headers({
    "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "Content-Length": String(object.size),
    "X-Content-Type-Options": "nosniff",
    // 资源只在保存时变化，而 URL 里带了 rev 作为缓存键，可以放心长缓存。
    // private：接口需要 Cookie 鉴权，不能被共享缓存存下来。
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  return new Response(object.body, { headers });
});

export default app;
