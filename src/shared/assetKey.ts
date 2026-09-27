/**
 * 资源 key 的生成规则，逐条移植参考实现 `mdex.rs` 的 `sanitize_stem()` 与 `unique_asset_key()`。
 *
 * 强制 ASCII 命名不只是为了整洁：ZIP 条目名的编码在历史上依赖「通用位标志 bit 11」，
 * 第三方工具写出的中文名可能既不是 UTF-8 也没置标志，读取端无法可靠还原。
 * 让**我们自己写出的**名字永远是 ASCII，就从根上避开了这一类问题。
 */

import { ASSET_PREFIX } from "./types";

/** 把任意显示名压成安全的 ASCII 文件名主干。 */
export function sanitizeStem(input: string): string {
  let out = "";
  let lastDash = false;
  for (const ch of input) {
    if (/[0-9a-zA-Z]/.test(ch) || ch === "-" || ch === "_") {
      out += ch.toLowerCase();
      lastDash = false;
    } else if (!lastDash) {
      out += "-";
      lastDash = true;
    }
  }
  // 先去掉首尾连字符，再截断——顺序与 Rust 版一致
  let result = out.replace(/^-+/, "").replace(/-+$/, "").slice(0, 48);
  if (result.length === 0) result = "asset";
  return result;
}

/**
 * 生成一个不与 `existing` 冲突的 `assets/<name>` key。
 * 重名时依次尝试 `-1`、`-2`…（迭代次数受现有 key 数量约束，必然终止）。
 */
export function uniqueAssetKey(
  existing: Iterable<string>,
  originalName: string,
  fallbackExt: string,
): string {
  const taken = new Set(existing);

  const fileName = originalName.replace(/\\/g, "/");
  const base = fileName.slice(fileName.lastIndexOf("/") + 1);

  // 等价于 Rust 的 `rsplit_once('.')`：取最后一个点，且要求后缀非空
  const dot = base.lastIndexOf(".");
  let stemRaw: string;
  let extRaw: string;
  if (dot >= 0 && dot < base.length - 1) {
    stemRaw = base.slice(0, dot);
    extRaw = base.slice(dot + 1);
  } else {
    stemRaw = base;
    extRaw = fallbackExt;
  }

  let ext = extRaw.replace(/[^0-9a-zA-Z]/g, "").slice(0, 8).toLowerCase();
  if (ext.length === 0) ext = "bin";

  const stem = sanitizeStem(stemRaw);
  const first = `${ASSET_PREFIX}${stem}.${ext}`;
  if (!taken.has(first)) return first;

  for (let counter = 1; ; counter++) {
    const candidate = `${ASSET_PREFIX}${stem}-${counter}.${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}
