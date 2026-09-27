import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { describe, expect, it } from "vitest";

import { uniqueAssetKey, sanitizeStem } from "../src/shared/assetKey";
import { buildMdexSync, newArchive, parseMdexSync } from "../src/shared/mdex";
import { MdexError } from "../src/shared/mdexError";
import { DOC_ENTRY, META_ENTRY, type MdexMeta } from "../src/shared/types";

const FIXTURE = fileURLToPath(new URL("./fixtures/sample.mdex", import.meta.url));
const sampleBytes = new Uint8Array(readFileSync(FIXTURE));

/** 按 ZIP 本地文件头的物理顺序读出条目名，用于验证写入顺序。 */
function localEntryOrder(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names: string[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    names.push(new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLen)));
    offset += 30 + nameLen + extraLen + compressedSize;
  }
  return names;
}

function metaBytes(overrides: Record<string, unknown>): Uint8Array {
  return strToU8(JSON.stringify({ format: "mdex", version: 1, created: "C", modified: "M", ...overrides }));
}

function makeArchive(entries: Zippable): Uint8Array {
  return zipSync(entries, { level: 6 });
}

function expectMdexError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MdexError);
    expect((e as MdexError).code).toBe(code);
    return;
  }
  throw new Error(`预期抛出 MdexError(${code})，但函数正常返回了`);
}

describe("parseMdexSync", () => {
  it("解析参考实现的 sample.mdex", () => {
    const archive = parseMdexSync(sampleBytes);

    expect(archive.meta.format).toBe("mdex");
    expect(archive.meta.version).toBe(1);
    expect(archive.meta.title).toBe("Welcome to mdex");
    expect(archive.meta.created).toBe("2026-09-25T00:00:00Z");
    expect(archive.meta.modified).toBe("2026-09-25T00:00:00Z");
    expect(archive.markdownPath).toBe(DOC_ENTRY);
    expect(archive.assetKeys).toEqual(["assets/icon.png"]);
    expect(archive.assets.get("assets/icon.png")!.byteLength).toBe(39344);
    expect(archive.ignoredEntries).toEqual([]);
    expect(archive.warnings).toEqual([]);
    // 参考实现渲染管线依赖的 KaTeX 与代码块内容确实在里面
    expect(archive.markdown).toContain("$$");
    expect(archive.markdown).toContain("```rust");
  });

  it("空文件报 EMPTY_FILE、非 zip 报 NOT_A_ZIP", () => {
    expectMdexError(() => parseMdexSync(new Uint8Array(0)), "EMPTY_FILE");
    expectMdexError(() => parseMdexSync(strToU8("definitely not a zip file")), "NOT_A_ZIP");
  });

  it("缺少 meta.json 报 META_MISSING", () => {
    const bytes = makeArchive({ [DOC_ENTRY]: strToU8("# hi\n") });
    expectMdexError(() => parseMdexSync(bytes), "META_MISSING");
  });

  it("meta.json 不是合法 JSON 报 META_INVALID_JSON", () => {
    const bytes = makeArchive({ [META_ENTRY]: strToU8("{ not json"), [DOC_ENTRY]: strToU8("# hi\n") });
    expectMdexError(() => parseMdexSync(bytes), "META_INVALID_JSON");
  });

  it("format 不是 mdex 报 META_INVALID_FORMAT", () => {
    const bytes = makeArchive({
      [META_ENTRY]: metaBytes({ format: "other" }),
      [DOC_ENTRY]: strToU8("# hi\n"),
    });
    expectMdexError(() => parseMdexSync(bytes), "META_INVALID_FORMAT");
  });

  it("version > 1 报 UNSUPPORTED_VERSION", () => {
    const bytes = makeArchive({
      [META_ENTRY]: metaBytes({ version: 2 }),
      [DOC_ENTRY]: strToU8("# hi\n"),
    });
    expectMdexError(() => parseMdexSync(bytes), "UNSUPPORTED_VERSION");
  });

  it("version 缺失时按 1 处理并记 warning", () => {
    const bytes = makeArchive({
      [META_ENTRY]: strToU8(JSON.stringify({ format: "mdex", created: "C", modified: "M" })),
      [DOC_ENTRY]: strToU8("# hi\n"),
    });
    const archive = parseMdexSync(bytes);
    expect(archive.meta.version).toBe(1);
    expect(archive.warnings.map((w) => w.code)).toContain("VERSION_LOWER");
  });

  it("缺少 document.md 报 MARKDOWN_MISSING，有其它 .md 时回退并记 warning", () => {
    const none = makeArchive({ [META_ENTRY]: metaBytes({}), "notes.txt": strToU8("x") });
    expectMdexError(() => parseMdexSync(none), "MARKDOWN_MISSING");

    const fallback = makeArchive({
      [META_ENTRY]: metaBytes({}),
      "README.md": strToU8("# from readme\n"),
    });
    const archive = parseMdexSync(fallback);
    expect(archive.markdownPath).toBe("README.md");
    expect(archive.markdown).toBe("# from readme\n");
    expect(archive.warnings.map((w) => w.code)).toContain("MARKDOWN_FALLBACK");
  });

  it("未知条目被忽略但记入 ignoredEntries", () => {
    const bytes = makeArchive({
      [META_ENTRY]: metaBytes({}),
      [DOC_ENTRY]: strToU8("# hi\n"),
      "notes/todo.txt": strToU8("later"),
      "styles.css": strToU8("body{}"),
    });
    const archive = parseMdexSync(bytes);
    expect(archive.ignoredEntries.sort()).toEqual(["notes/todo.txt", "styles.css"]);
    expect(archive.warnings.map((w) => w.code)).toContain("UNKNOWN_ENTRIES");
  });

  it("只有 assets/ 前缀下的条目算资源", () => {
    const bytes = makeArchive({
      [META_ENTRY]: metaBytes({}),
      [DOC_ENTRY]: strToU8("# hi\n"),
      "assets/a.png": new Uint8Array([1, 2, 3]),
      "other/b.png": new Uint8Array([4, 5, 6]),
    });
    const archive = parseMdexSync(bytes);
    expect(archive.assetKeys).toEqual(["assets/a.png"]);
  });

  it("用 filter 在解压前拦下超限条目", () => {
    const bytes = makeArchive({
      [META_ENTRY]: metaBytes({}),
      [DOC_ENTRY]: strToU8("# hi\n"),
      "assets/big.bin": new Uint8Array(4096),
    });
    expectMdexError(() => parseMdexSync(bytes, { maxEntryBytes: 1024 }), "TOO_LARGE");
    expectMdexError(() => parseMdexSync(bytes, { maxEntries: 2 }), "TOO_MANY_ENTRIES");
  });

  it("includeAssetBytes: false 时不解压资源字节，但 assetKeys 仍完整", () => {
    const archive = parseMdexSync(sampleBytes, { includeAssetBytes: false });
    expect(archive.assetKeys).toEqual(["assets/icon.png"]);
    expect(archive.assets.size).toBe(0);
    // 未解压的资源不应被误判成「无法识别的条目」
    expect(archive.ignoredEntries).toEqual([]);
    expect(archive.warnings).toEqual([]);
    // 正文与元数据照常可用
    expect(archive.markdown).toContain("```rust");
  });

  it("Windows 风格的反斜杠条目名可正常解析", () => {
    const bytes = makeArchive({
      "meta.json": metaBytes({}),
      "document.md": strToU8("# hi\n"),
      "assets\\win.png": new Uint8Array([7, 7]),
    });
    const archive = parseMdexSync(bytes);
    expect(archive.markdownPath).toBe(DOC_ENTRY);
    expect(archive.assetKeys).toEqual(["assets/win.png"]);
  });
});

describe("buildMdexSync", () => {
  it("往返后正文、资源与 created 不变，条目顺序与参考实现一致", () => {
    const original = parseMdexSync(sampleBytes);
    const regenerated = buildMdexSync(original, { modified: new Date("2026-09-26T12:46:44.922Z") });
    const reparsed = parseMdexSync(regenerated);

    expect(reparsed.markdown).toBe(original.markdown);
    expect(reparsed.assetKeys).toEqual(original.assetKeys);
    expect(reparsed.assets.get("assets/icon.png")).toEqual(original.assets.get("assets/icon.png"));
    expect(reparsed.meta.created).toBe(original.meta.created);
    expect(reparsed.meta.title).toBe(original.meta.title);
    expect(reparsed.meta.modified).toBe("2026-09-26T12:46:44.922Z");
    expect(reparsed.meta.format).toBe("mdex");
    expect(reparsed.meta.version).toBe(1);

    expect(localEntryOrder(regenerated)).toEqual(["meta.json", "document.md", "assets/icon.png"]);
  });

  it("meta.json 为 pretty JSON，且保留未知字段", () => {
    const bytes = makeArchive({
      [META_ENTRY]: metaBytes({ title: "T", customField: { a: 1 } }),
      [DOC_ENTRY]: strToU8("# hi\n"),
    });
    const archive = parseMdexSync(bytes);
    expect(archive.meta.customField).toEqual({ a: 1 });

    const rebuilt = parseMdexSync(buildMdexSync(archive, { modified: "2026-01-01T00:00:00Z" }));
    expect(rebuilt.meta.customField).toEqual({ a: 1 });

    const raw = new TextDecoder().decode(
      // 直接从重新打包的归档里取 meta.json，验证序列化格式
      parseRawEntry(buildMdexSync(archive, { modified: "2026-01-01T00:00:00Z" }), META_ENTRY),
    );
    expect(raw).toContain("\n  ");
    expect(raw.endsWith("\n}")).toBe(true);
  });

  it("title 为空时省略该字段（对齐 serde 的 skip_serializing_if）", () => {
    const archive = newArchive("");
    const rebuilt = buildMdexSync({ ...archive, meta: { ...archive.meta, title: undefined } });
    const reparsed = parseMdexSync(rebuilt);
    expect("title" in reparsed.meta).toBe(false);
  });

  it("把非 document.md 的正文规范化到 document.md", () => {
    const bytes = makeArchive({
      [META_ENTRY]: metaBytes({}),
      "README.md": strToU8("# hello\n"),
    });
    const archive = parseMdexSync(bytes);
    const rebuilt = buildMdexSync(archive);
    expect(localEntryOrder(rebuilt)).toEqual(["meta.json", "document.md"]);
    expect(parseMdexSync(rebuilt).markdown).toBe("# hello\n");
  });
});

describe("assetKey", () => {
  it("sanitizeStem 与参考实现规则一致", () => {
    expect(sanitizeStem("Screen Shot 2026.png")).toBe("screen-shot-2026-png");
    expect(sanitizeStem("图片")).toBe("asset");
    expect(sanitizeStem("--a--")).toBe("a");
    expect(sanitizeStem("x".repeat(80))).toHaveLength(48);
  });

  it("uniqueAssetKey 在重名时追加计数", () => {
    const existing = ["assets/photo.png"];
    const next = uniqueAssetKey(existing, "photo.png", "png");
    expect(next).toBe("assets/photo-1.png");
    expect(uniqueAssetKey([...existing, next], "photo.png", "png")).toBe("assets/photo-2.png");
  });

  it("uniqueAssetKey 对无名文件使用扩展名回退", () => {
    expect(uniqueAssetKey([], "", "png")).toBe("assets/asset.png");
    expect(uniqueAssetKey([], "C:\\dir\\My Photo.JPEG", "png")).toBe("assets/my-photo.jpeg");
  });
});

/** 只解压指定条目，用于断言归档内部的原始文本。 */
function parseRawEntry(bytes: Uint8Array, name: string): Uint8Array {
  return unzipSync(bytes, { filter: (f) => f.name === name })[name];
}

describe("MdexMeta 类型可用性", () => {
  it("索引签名允许携带未知字段", () => {
    const meta: MdexMeta = {
      format: "mdex",
      version: 1,
      created: "C",
      modified: "M",
      extra: 42,
    };
    expect(meta.extra).toBe(42);
  });
});
