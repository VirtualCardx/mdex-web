import type { DocList, DocSummary } from "../shared/types";

/** D1 `docs` 表的一行。 */
export interface DocRow {
  id: string;
  title: string;
  markdown_path: string;
  format_version: number;
  r2_key: string;
  size: number;
  asset_count: number;
  asset_keys: string;
  rev: number;
  markdown: string | null;
  created: string;
  modified: string;
  created_at: string;
  updated_at: string;
}

/** 正文缓存上限；超过则写 NULL，预览页改走 `/raw`。 */
export const MARKDOWN_CACHE_LIMIT = 512 * 1024;

/** 列表查询用的列：刻意不含 `markdown` 与 `asset_keys`，列表响应才不会被正文拖大。 */
const LIST_COLUMNS = `id, title, markdown_path, format_version, r2_key, size, asset_count, rev,
                      created, modified, created_at, updated_at`;

export function toSummary(row: DocRow): DocSummary {
  return {
    id: row.id,
    title: row.title,
    size: row.size,
    assetCount: row.asset_count,
    markdownPath: row.markdown_path,
    formatVersion: row.format_version,
    rev: row.rev,
    created: row.created,
    modified: row.modified,
    updatedAt: row.updated_at,
  };
}

/** `asset_keys` 列（JSON 数组）→ 字符串数组；内容坏掉时退化为空列表而不是抛错。 */
export function parseAssetKeys(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key): key is string => typeof key === "string");
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 列表查询
// ---------------------------------------------------------------------------

/**
 * 排序列白名单。SQL 标识符不能 bind，只能这样映射；同时也天然挡掉了注入。
 *
 * `title` 用 `COLLATE NOCASE`，否则中英混排的标题排序会全按字节序，大小写乱序。
 */
const SORT_COLUMNS = {
  modified: "modified",
  created: "created",
  updatedAt: "updated_at",
  title: "title COLLATE NOCASE",
  size: "size",
} as const;

export type SortKey = keyof typeof SORT_COLUMNS;

export interface ListParams {
  q: string;
  sort: SortKey;
  order: "ASC" | "DESC";
  page: number;
  pageSize: number;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/** 转义 LIKE 元字符，配合 SQL 里的 `ESCAPE '\'` 使用。 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function parseListParams(searchParams: URLSearchParams): ListParams {
  const rawSort = searchParams.get("sort") ?? "";
  const rawOrder = (searchParams.get("order") ?? "").toLowerCase();

  return {
    q: (searchParams.get("q") ?? "").trim().slice(0, 200),
    sort: Object.hasOwn(SORT_COLUMNS, rawSort) ? (rawSort as SortKey) : "modified",
    order: rawOrder === "asc" ? "ASC" : "DESC",
    page: clampInt(searchParams.get("page"), 1, 1, Number.MAX_SAFE_INTEGER),
    pageSize: clampInt(searchParams.get("pageSize"), 24, 1, 100),
  };
}

export async function listDocs(db: D1Database, params: ListParams): Promise<DocList> {
  const column = SORT_COLUMNS[params.sort];
  const search = params.q ? `%${escapeLike(params.q)}%` : null;

  // 标题与正文都搜：文档数是个位数~几百，LIKE 扫描的代价可以忽略，而「记不清标题
  // 但记得内容」是更常见的检索方式。正文未缓存（>512KB）的行只按标题匹配。
  const where = search ? `WHERE (title LIKE ?1 ESCAPE '\\' OR markdown LIKE ?1 ESCAPE '\\')` : "";

  // LIMIT/OFFSET 由上面夹取过的整数拼出，不含外部字符串，安全。
  const limit = params.pageSize;
  const offset = (params.page - 1) * params.pageSize;

  const pageSql = `SELECT ${LIST_COLUMNS} FROM docs ${where} ORDER BY ${column} ${params.order}, id DESC LIMIT ${limit} OFFSET ${offset}`;
  const countSql = `SELECT COUNT(*) AS total FROM docs ${where}`;

  // 两次查询走 batch 只往返一次 D1。T 取交集是为了让 page 与 count 两个形状
  // 共用同一次 batch 的泛型（结果里既有行字段，也有 total）。
  const [page, count] = await db.batch<DocRow & { total: number }>([
    search ? db.prepare(pageSql).bind(search) : db.prepare(pageSql),
    search ? db.prepare(countSql).bind(search) : db.prepare(countSql),
  ]);

  return {
    items: page.results.map(toSummary),
    total: count.results[0]?.total ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  };
}

// ---------------------------------------------------------------------------
// 单文档
// ---------------------------------------------------------------------------

export async function findDoc(db: D1Database, id: string): Promise<DocRow | null> {
  return db.prepare(`SELECT * FROM docs WHERE id = ?1`).bind(id).first<DocRow>();
}

export interface NewDoc {
  id: string;
  title: string;
  markdownPath: string;
  formatVersion: number;
  r2Key: string;
  size: number;
  assetKeys: string[];
  markdown: string | null;
  created: string;
  modified: string;
  now: string;
}

export async function insertDoc(db: D1Database, doc: NewDoc): Promise<void> {
  await db
    .prepare(
      `INSERT INTO docs
         (id, title, markdown_path, format_version, r2_key, size, asset_count, asset_keys,
          rev, markdown, created, modified, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10, ?11, ?12, ?12)`,
    )
    .bind(
      doc.id,
      doc.title,
      doc.markdownPath,
      doc.formatVersion,
      doc.r2Key,
      doc.size,
      doc.assetKeys.length,
      JSON.stringify(doc.assetKeys),
      doc.markdown,
      doc.created,
      doc.modified,
      doc.now,
    )
    .run();
}

export interface ContentUpdate {
  title: string;
  markdownPath: string;
  formatVersion: number;
  size: number;
  assetKeys: string[];
  /** 新修订版的归档对象 key。必须一并更新：旧 rev 目录会被 pruneRevisions 回收。 */
  r2Key: string;
  markdown: string | null;
  created: string;
  modified: string;
  now: string;
}

/**
 * 提交新内容。
 *
 * `AND rev = ?` 是提交点：并发的第二个写者会拿到 0 行变更从而得到 409。
 * 返回值表示是否抢占成功。
 */
export async function commitContentUpdate(
  db: D1Database,
  id: string,
  expectedRev: number,
  update: ContentUpdate,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE docs SET
         title = ?2, markdown_path = ?3, format_version = ?4, size = ?5, asset_count = ?6,
         asset_keys = ?7, markdown = ?8, created = ?9, modified = ?10, updated_at = ?11,
         r2_key = ?13, rev = rev + 1
       WHERE id = ?1 AND rev = ?12`,
    )
    .bind(
      id,
      update.title,
      update.markdownPath,
      update.formatVersion,
      update.size,
      update.assetKeys.length,
      JSON.stringify(update.assetKeys),
      update.markdown,
      update.created,
      update.modified,
      update.now,
      expectedRev,
      update.r2Key,
    )
    .run();

  return result.meta.changes > 0;
}

/**
 * 只改标题。
 *
 * 标题也存在于归档内的 meta.json 里，但为一个改名把整个包重压一遍并不值得；
 * 下次在编辑页保存时，meta.json 会自然同步为这里的值。
 */
export async function commitTitle(db: D1Database, id: string, title: string, now: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE docs SET title = ?2, updated_at = ?3 WHERE id = ?1`)
    .bind(id, title, now)
    .run();
  return result.meta.changes > 0;
}

export async function removeDoc(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM docs WHERE id = ?1`).bind(id).run();
}
