/** 当前时间的 RFC3339 字符串（UTC，毫秒精度）。 */
export function nowRfc3339(): string {
  return new Date().toISOString();
}

/** 把可选的 `Date | string` 归一为 RFC3339 字符串，未提供时取当前时间。 */
export function toRfc3339(value: Date | string | undefined): string {
  if (value === undefined) return nowRfc3339();
  return typeof value === "string" ? value : value.toISOString();
}
