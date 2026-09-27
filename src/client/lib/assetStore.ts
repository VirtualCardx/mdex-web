/**
 * 内存中的资源字节 + blob URL 生命周期管理。
 *
 * 为什么必须集中管理：blob URL 不会随组件卸载自动释放，散落各处的
 * `URL.createObjectURL` 会让「打开十个文档」直接吃掉几百 MB 显存；反过来，
 * 过早 `revokeObjectURL` 又会让**已经渲染出来的 `<img>` 立刻变成裂图**——
 * 因为它持有的就是那个字符串。所以策略是：
 *
 * - **懒创建**：key 第一次被 markdown 引用时才建 URL，而不是解包后给所有资源都建。
 * - **只在整份文档关闭/切换时批量回收**；同一 key 被覆盖时先撤销旧 URL。
 * - 字节本身托管在 `Archive.assets` 这个 Map 上（本类按引用持有），
 *   所以 `set`/`delete` 后重新打包时用的就是最新数据。
 */

import { mimeFor } from "../../shared/mime";

export class AssetStore {
  /** 与 `MdexArchive.assets` 是同一个 Map 实例，避免两份真相。 */
  private readonly assets: Map<string, Uint8Array>;
  private readonly urls = new Map<string, string>();
  private disposed = false;

  constructor(assets: Map<string, Uint8Array> = new Map()) {
    this.assets = assets;
  }

  get size(): number {
    return this.assets.size;
  }

  /** 已排序的 key 列表，供 UI 稳定渲染。 */
  keys(): string[] {
    return [...this.assets.keys()].sort();
  }

  has(key: string): boolean {
    return this.assets.has(key);
  }

  bytes(key: string): Uint8Array | undefined {
    return this.assets.get(key);
  }

  totalBytes(): number {
    let total = 0;
    for (const bytes of this.assets.values()) total += bytes.byteLength;
    return total;
  }

  /**
   * 取（必要时创建）key 对应的 blob URL。
   *
   * 必须带 MIME：`new Blob([bytes])` 的默认类型是 `application/octet-stream`，
   * `<img>` 拿到这个 Content-Type 大多不会渲染，图片会「无声地」不显示。
   */
  url(key: string): string | null {
    if (this.disposed) return null;
    const existing = this.urls.get(key);
    if (existing !== undefined) return existing;
    const bytes = this.assets.get(key);
    if (!bytes) return null;
    const url = URL.createObjectURL(
      // `BlobPart` 同样被 TS 5.7+ 的 lib.dom 收窄为 `ArrayBufferView<ArrayBuffer>`，
      // 而 fflate 给的是 `Uint8Array<ArrayBufferLike>`；运行时一致，只做类型收窄，不复制字节。
      new Blob([bytes as unknown as BlobPart], { type: mimeFor(key) }),
    );
    this.urls.set(key, url);
    return url;
  }

  /** 新增或覆盖一个资源；覆盖时先撤销旧 URL（旧字符串随即失效，由调用方触发重渲染）。 */
  set(key: string, bytes: Uint8Array): void {
    this.revoke(key);
    this.assets.set(key, bytes);
  }

  /** 改名：把字节挪到新 key 上，并撤销旧 key 的 URL。 */
  rename(from: string, to: string): void {
    const bytes = this.assets.get(from);
    if (!bytes) return;
    this.revoke(from);
    this.assets.delete(from);
    this.set(to, bytes);
  }

  delete(key: string): void {
    this.revoke(key);
    this.assets.delete(key);
  }

  /** 切文档或卸载时调用；调用后本实例不可再用（`url()` 返回 null）。 */
  dispose(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.assets.clear();
    this.disposed = true;
  }

  private revoke(key: string): void {
    const url = this.urls.get(key);
    if (url === undefined) return;
    URL.revokeObjectURL(url);
    this.urls.delete(key);
  }
}
