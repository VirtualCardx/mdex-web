/** 从扩展名推断 MIME 类型，与参考实现 `mdex.rs` 的 `mime_for()` 保持一致。 */

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  txt: "text/plain",
  json: "application/json",
};

export function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME_BY_EXT[path.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}
