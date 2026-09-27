/**
 * `.mdex` 归档的解析与打包。这是全项目的核心模块，Worker 与浏览器共用。
 *
 * 归档布局（与参考实现 `mdex\src-tauri\src\mdex.rs` 完全一致）：
 *
 * ```text
 * meta.json      {"format":"mdex","version":1,"title":...,"created":...,"modified":...}
 * document.md    正文
 * assets/        正文以 assets/<name> 引用的二进制资源
 * ```
 *
 * 两侧的环境约束不同，因此同时导出同步与异步两套 API：
 * - **Worker** 只能用 `*Sync`：workerd 里没有 `Worker` 全局对象，fflate 的异步实现会直接抛错。
 * - **浏览器** 用异步：`unzip`/`zip` 会自动把工作放到独立线程，大文档不会卡死主线程。
 */

import { strFromU8, strToU8, unzip, unzipSync, zip, zipSync, type UnzipFileInfo, type Zippable } from "fflate";

import { MdexError, toMdexError } from "./mdexError";
import { mimeFor } from "./mime";
import { toRfc3339 } from "./time";
import {
  ASSET_PREFIX,
  DOC_ENTRY,
  MDEX_FORMAT,
  MDEX_VERSION,
  META_ENTRY,
  type MdexArchive,
  type MdexMeta,
  type MdexWarning,
} from "./types";

export interface ParseOptions {
  /** 单个条目解压后的字节上限（zip 炸弹防护）。 */
  maxEntryBytes?: number;
  /** 全部条目解压后的总字节上限。 */
  maxTotalBytes?: number;
  /** 条目数上限。 */
  maxEntries?: number;
  /**
   * 是否解压 `assets/**` 的字节。默认 true。
   *
   * Worker 侧只关心元数据与正文，设为 false 后大文档的峰值内存不会随图片体积增长；
   * 此时 `assets` 为空 Map，但 `assetKeys` 仍会从条目清单里得出。
   */
  includeAssetBytes?: boolean;
}

export interface BuildOptions {
  /** 覆盖 `modified`；不传则取当前时间。`created` 永远原样保留。 */
  modified?: Date | string;
  /** 覆盖标题；不传（或为 undefined）则沿用原 meta，仍为空时省略该字段。 */
  title?: string;
}

const DEFAULT_LIMITS: Required<ParseOptions> = {
  maxEntryBytes: 128 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntries: 2048,
  includeAssetBytes: true,
};

/** `meta.json` 的已知字段；其余字段一律原样保留并写回。 */
const KNOWN_META_KEYS = new Set(["format", "version", "title", "created", "modified"]);

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

interface Scan {
  /** 归档顺序的规范化条目名（含目录条目）。 */
  order: string[];
  /** 解压前的检查中发现的第一个致命问题。 */
  violation: MdexError | null;
}

/** 规范化条目名：统一分隔符，并做 NFC 规范化以消除 macOS 的 NFD 差异。 */
function normalizeEntryName(raw: string): string {
  return raw.replace(/\\/g, "/").normalize("NFC");
}

function isMarkdownName(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

function isDirEntry(name: string): boolean {
  return name.endsWith("/");
}

/**
 * fflate 的 `filter` 会在**解压之前**对每个条目调用，用它做零成本的清单收集与体积检查。
 * 只有 `meta.json`、候选正文和 `assets/**` 会被真正解压——图片一律跳过，
 * 否则 50MB 带图文档的峰值内存会从 ~51MB 膨胀到 200MB 以上。
 */
function makeFilter(scan: Scan, limits: Required<ParseOptions>): (info: UnzipFileInfo) => boolean {
  let total = 0;
  return (info) => {
    if (scan.order.length >= limits.maxEntries) {
      scan.violation ??= new MdexError("TOO_MANY_ENTRIES", `条目数超过 ${limits.maxEntries}`);
      return false;
    }

    const name = normalizeEntryName(info.name);
    scan.order.push(name);

    if (isDirEntry(name)) return false;

    const wanted = name === META_ENTRY || isMarkdownName(name) || (name.startsWith(ASSET_PREFIX) && limits.includeAssetBytes);

    // 体积预算只统计**会被解压**的条目。不解压的 `assets/**` 若计入总量，大文档会被误判为
    // 超限；而真正需要防御的 zip 炸弹是「解压后被分配的内存」，正是这里的 total。
    if (wanted) {
      if (info.originalSize > limits.maxEntryBytes) {
        scan.violation ??= new MdexError("TOO_LARGE", `${name} 解压后 ${info.originalSize} 字节`);
        return false;
      }
      total += info.originalSize;
      if (total > limits.maxTotalBytes) {
        scan.violation ??= new MdexError("TOO_LARGE", `解压后总量超过 ${limits.maxTotalBytes} 字节`);
        return false;
      }
    }

    if (!wanted) return false;

    // 0 = 存储，8 = deflate。其他方式 fflate 无法解压，提前给出可读的错误。
    if (info.compression !== 0 && info.compression !== 8) {
      scan.violation ??= new MdexError("NOT_A_ZIP", `${name} 使用了不支持的压缩方式 ${info.compression}`);
      return false;
    }

    return true;
  };
}

/** 在解压前做快速失败检查，避免 fflate 抛出晦涩的错误。 */
function precheck(bytes: Uint8Array): void {
  if (bytes.byteLength === 0) throw new MdexError("EMPTY_FILE");
  // ZIP 的 "PK" 魔数
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new MdexError("NOT_A_ZIP", `首字节为 ${bytes[0]?.toString(16)} ${bytes[1]?.toString(16)}`);
  }
}

/** UTF-8 解码；出现替换字符时退回 GBK 再试一次。 */
function decodeText(bytes: Uint8Array): string {
  const utf8 = strFromU8(bytes);
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    const gbk = new TextDecoder("gbk", { fatal: false, ignoreBOM: false }).decode(bytes);
    return gbk.includes("\uFFFD") ? utf8 : gbk;
  } catch {
    // workerd 可能不提供 GBK 解码器
    return utf8;
  }
}

function pickUnknownMeta(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_META_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/** 从已解压的条目组装出 `MdexArchive`，并完成全部语义校验。 */
function assemble(extracted: Map<string, Uint8Array>, scan: Scan, limits: Required<ParseOptions>): MdexArchive {
  if (scan.violation) throw scan.violation;

  const warnings: MdexWarning[] = [];

  // --- meta.json ---
  const metaBytes = extracted.get(META_ENTRY);
  if (!metaBytes) throw new MdexError("META_MISSING");

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeText(metaBytes));
  } catch (e) {
    throw new MdexError("META_INVALID_JSON", e instanceof Error ? e.message : String(e));
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MdexError("META_INVALID_FORMAT", `meta.json 的顶层不是对象`);
  }

  const raw = parsed as Record<string, unknown>;
  const format = typeof raw.format === "string" ? raw.format.toLowerCase() : "";
  if (format !== MDEX_FORMAT) {
    throw new MdexError("META_INVALID_FORMAT", `format=${JSON.stringify(raw.format)}`);
  }

  // --- 版本（读宽松，写严格，与 mdex.rs:192 一致）---
  const version = typeof raw.version === "number" && Number.isFinite(raw.version) ? raw.version : Number.NaN;
  if (Number.isFinite(version) && version > MDEX_VERSION) {
    throw new MdexError("UNSUPPORTED_VERSION", `version=${version}`);
  }
  if (version !== MDEX_VERSION) {
    warnings.push({
      code: "VERSION_LOWER",
      message: `元数据 version 为 ${JSON.stringify(raw.version ?? null)}，已按 1 处理。`,
    });
  }

  const missing: string[] = [];
  if (typeof raw.created !== "string") missing.push("created");
  if (typeof raw.modified !== "string") missing.push("modified");
  if (missing.length > 0) {
    warnings.push({
      code: "META_FIELDS_MISSING",
      message: `meta.json 缺少 ${missing.join("、")}，已用当前时间补齐。`,
    });
  }
  const created = typeof raw.created === "string" ? raw.created : new Date().toISOString();
  const modified = typeof raw.modified === "string" ? raw.modified : created;

  const meta: MdexMeta = {
    ...raw,
    format: MDEX_FORMAT,
    version: MDEX_VERSION,
    created,
    modified,
  };
  if (typeof raw.title !== "string") delete meta.title;

  // --- 正文 ---
  const markdownPath = locateMarkdown(extracted, scan.order, warnings);
  const markdown = decodeText(extracted.get(markdownPath)!);

  // --- 资源 ---
  // includeAssetBytes 为 false 时没有字节，但 key 仍能从条目清单得出
  const assets = new Map<string, Uint8Array>();
  if (limits.includeAssetBytes) {
    for (const [name, bytes] of extracted) {
      if (name.startsWith(ASSET_PREFIX)) assets.set(name, bytes);
    }
  }
  const assetKeys = (
    limits.includeAssetBytes
      ? [...assets.keys()]
      : scan.order.filter((name) => name.startsWith(ASSET_PREFIX) && !isDirEntry(name))
  ).sort();

  // --- 被忽略的条目 ---
  // 「被识别但未解压」（如 Worker 侧跳过的图片）不算忽略
  const recognized = (name: string) =>
    name === META_ENTRY || isMarkdownName(name) || name.startsWith(ASSET_PREFIX);
  const ignoredEntries = scan.order.filter((name) => !isDirEntry(name) && !recognized(name));
  if (ignoredEntries.length > 0) {
    warnings.push({
      code: "UNKNOWN_ENTRIES",
      message: `已忽略 ${ignoredEntries.length} 个无法识别的条目。`,
    });
  }

  return {
    meta,
    markdownPath,
    markdown,
    assets,
    assetKeys,
    ignoredEntries,
    warnings,
  };
}

/**
 * 定位正文。
 *
 * 优先精确的 `document.md`（参考实现只认这个文件名）；找不到时按归档顺序回退到
 * 根目录下第一个 `.md`，再回退到任意 `.md`，并记一条 warning。
 * 注意**写入端永远写回 `document.md`**，见 `collectEntries()` 的说明。
 */
function locateMarkdown(
  extracted: Map<string, Uint8Array>,
  order: string[],
  warnings: MdexWarning[],
): string {
  if (extracted.has(DOC_ENTRY)) return DOC_ENTRY;

  const candidates = order.filter((name) => extracted.has(name) && isMarkdownName(name));
  const picked = candidates.find((name) => !name.includes("/")) ?? candidates[0];
  if (!picked) throw new MdexError("MARKDOWN_MISSING", `条目：${order.join(", ")}`);

  warnings.push({
    code: "MARKDOWN_FALLBACK",
    message: `归档里没有 document.md，已改用 ${picked} 作为正文；保存时会规范化为 document.md。`,
  });
  return picked;
}

export function parseMdexSync(bytes: Uint8Array, opts: ParseOptions = {}): MdexArchive {
  precheck(bytes);
  const limits = { ...DEFAULT_LIMITS, ...opts };
  const scan: Scan = { order: [], violation: null };

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: makeFilter(scan, limits) });
  } catch (e) {
    throw toMdexError(e);
  }
  return assemble(toNormalizedMap(files), scan, limits);
}

export function parseMdex(bytes: Uint8Array, opts: ParseOptions = {}): Promise<MdexArchive> {
  precheck(bytes);
  const limits = { ...DEFAULT_LIMITS, ...opts };
  const scan: Scan = { order: [], violation: null };
  const filter = makeFilter(scan, limits);

  return new Promise<MdexArchive>((resolve, reject) => {
    unzip(bytes, { filter }, (err, files) => {
      if (err) {
        reject(toMdexError(err));
        return;
      }
      try {
        resolve(assemble(toNormalizedMap(files), scan, limits));
      } catch (e) {
        reject(toMdexError(e, "NOT_A_ZIP"));
      }
    });
  });
}

/** fflate 用原始条目名作为结果的 key，这里统一规范化。 */
function toNormalizedMap(files: Record<string, Uint8Array>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [rawName, bytes] of Object.entries(files)) {
    out.set(normalizeEntryName(rawName), bytes);
  }
  return out;
}

export interface ExtractAssetsOptions {
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  maxEntries?: number;
}

/**
 * 只解压 `assets/**`，返回「归档内完整路径 → 字节」。
 *
 * Worker 用它把资源拆成独立的 R2 对象，让 `/asset` 端点能按需直取一张图，而不必为
 * 每张图把整个压缩包读回来再解压。条目名的规范化与 `parseMdexSync` 完全一致，
 * 因此返回的 key 必然与 `archive.assetKeys` 对得上。
 */
export function extractAssetsSync(bytes: Uint8Array, opts: ExtractAssetsOptions = {}): Map<string, Uint8Array> {
  precheck(bytes);
  const maxEntryBytes = opts.maxEntryBytes ?? DEFAULT_LIMITS.maxEntryBytes;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes;
  const maxEntries = opts.maxEntries ?? DEFAULT_LIMITS.maxEntries;

  let seen = 0;
  let total = 0;
  let violation: MdexError | null = null;

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (info) => {
        if (++seen > maxEntries) {
          violation ??= new MdexError("TOO_MANY_ENTRIES", `条目数超过 ${maxEntries}`);
          return false;
        }
        const name = normalizeEntryName(info.name);
        if (isDirEntry(name) || !name.startsWith(ASSET_PREFIX)) return false;

        if (info.originalSize > maxEntryBytes) {
          violation ??= new MdexError("TOO_LARGE", `${name} 解压后 ${info.originalSize} 字节`);
          return false;
        }
        total += info.originalSize;
        if (total > maxTotalBytes) {
          violation ??= new MdexError("TOO_LARGE", `资源解压后总量超过 ${maxTotalBytes} 字节`);
          return false;
        }
        if (info.compression !== 0 && info.compression !== 8) {
          violation ??= new MdexError("NOT_A_ZIP", `${name} 使用了不支持的压缩方式 ${info.compression}`);
          return false;
        }
        return true;
      },
    });
  } catch (e) {
    throw toMdexError(e);
  }
  if (violation) throw violation;
  return toNormalizedMap(files);
}

// ---------------------------------------------------------------------------
// 打包
// ---------------------------------------------------------------------------

/**
 * 构造待压缩的条目表。
 *
 * **正文一律写到 `document.md`**：参考实现的 `open()` 严格要求这个条目名
 * （`mdex.rs:198`），若把第三方归档里的 `README.md` 原样写回，桌面版会拒绝打开。
 * 规范化即修复。
 *
 * 条目顺序与 `mdex.rs:228` 保持一致：`meta.json` → `document.md` → 按字典序的资源。
 */
function collectEntries(archive: MdexArchive, opts: BuildOptions): Zippable {
  const meta: Record<string, unknown> = {
    ...pickUnknownMeta(archive.meta),
    format: MDEX_FORMAT,
    version: MDEX_VERSION,
  };

  const title = opts.title ?? archive.meta.title;
  if (typeof title === "string" && title.length > 0) meta.title = title;

  meta.created = archive.meta.created; // 原样透传，绝不 Date 往返
  meta.modified = toRfc3339(opts.modified);

  const files: Zippable = {
    [META_ENTRY]: strToU8(JSON.stringify(meta, null, 2)),
    [DOC_ENTRY]: strToU8(archive.markdown),
  };
  for (const key of [...archive.assets.keys()].sort()) {
    files[key] = archive.assets.get(key)!;
  }
  return files;
}

export function buildMdexSync(archive: MdexArchive, opts: BuildOptions = {}): Uint8Array {
  try {
    return zipSync(collectEntries(archive, opts), { level: 6 });
  } catch (e) {
    throw toMdexError(e, "BUILD_FAILED");
  }
}

export function buildMdex(archive: MdexArchive, opts: BuildOptions = {}): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    zip(collectEntries(archive, opts), { level: 6 }, (err, data) => {
      if (err) {
        reject(toMdexError(err, "BUILD_FAILED"));
        return;
      }
      resolve(data);
    });
  });
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 新建一个空白文档。 */
export function newArchive(title: string, markdown = "# Untitled\n"): MdexArchive {
  const now = new Date().toISOString();
  return {
    meta: { format: MDEX_FORMAT, version: MDEX_VERSION, title, created: now, modified: now },
    markdownPath: DOC_ENTRY,
    markdown,
    assets: new Map(),
    assetKeys: [],
    ignoredEntries: [],
    warnings: [],
  };
}

export { mimeFor };
