import { mimeFor } from "../shared/mdex";
import { ASSET_PREFIX } from "../shared/types";

/**
 * R2 的对象布局 —— 按修订版整目录隔离：
 *
 * ```text
 * docs/{id}/{rev}/archive.mdex        归档本体（原样保存上传/保存时的字节）
 * docs/{id}/{rev}/assets/{name}       单个资源，供 /asset 按需直取
 * ```
 *
 * **为什么资源要额外存一份独立对象**：预览页就能一张图一个请求地取，而不是为每张图
 * 把整个压缩包读回来再解压。代价是图片类文档占用约两倍空间，换来的是预览页与编辑页
 * 彻底解耦（编辑页才需要把整包解到浏览器里）。
 *
 * **为什么 key 里带 `rev`**：两个标签页同时保存时只有一个能抢到修订号 N。
 * 每个写者都只在自己算出的 `{rev}` 目录里落对象，失败者的目录无人引用，整目录删掉
 * 即可，永远不可能污染赢家已经提交的内容。`docs.r2_key` 指向当前修订版的归档。
 */

/** 某文档的全部修订版目录前缀。 */
export function docPrefix(id: string): string {
  return `docs/${id}/`;
}

/** 某个修订版的目录前缀。 */
export function revisionPrefix(id: string, rev: number): string {
  return `docs/${id}/${rev}/`;
}

/** 归档对象的 key；写入 `docs.r2_key` 的就是它。 */
export function archiveKey(id: string, rev: number): string {
  return `${revisionPrefix(id, rev)}archive.mdex`;
}

/** 资源对象的 key；`assets/foo.png` → `docs/{id}/{rev}/assets/foo.png`。 */
export function assetKey(id: string, rev: number, key: string): string {
  return `${revisionPrefix(id, rev)}assets/${key.slice(ASSET_PREFIX.length)}`;
}

/** R2 单次 `delete` 的 key 数量上限。 */
const DELETE_BATCH = 1000;

/** 批量写资源时的并发度：既要快，又不能一次抛出上千个子请求。 */
const WRITE_CONCURRENCY = 8;

/** 删除某前缀下的全部对象，自动翻页。对不存在的 key 是幂等的。 */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const listed = await bucket.list({ prefix, cursor, limit: DELETE_BATCH });
    if (listed.objects.length > 0) {
      await bucket.delete(listed.objects.map((object) => object.key));
    }
    if (!listed.truncated) return;
    cursor = listed.cursor;
  }
}

/** 把资源写成独立对象。 */
export async function putAssets(
  bucket: R2Bucket,
  id: string,
  rev: number,
  assets: Map<string, Uint8Array>,
): Promise<void> {
  const entries = [...assets.entries()];
  for (let i = 0; i < entries.length; i += WRITE_CONCURRENCY) {
    const chunk = entries.slice(i, i + WRITE_CONCURRENCY);
    await Promise.all(
      chunk.map(([key, bytes]) =>
        bucket.put(assetKey(id, rev, key), bytes, {
          httpMetadata: { contentType: mimeFor(key) },
        }),
      ),
    );
  }
}

/** 删除除 `keepRev` 之外的所有修订版目录，回收旧版归档与图片。 */
export async function pruneRevisions(bucket: R2Bucket, id: string, keepRev: number): Promise<void> {
  const listed = await bucket.list({ prefix: docPrefix(id), delimiter: "/" });
  const stale = listed.delimitedPrefixes.filter((prefix) => prefix !== revisionPrefix(id, keepRev));
  await Promise.all(stale.map((prefix) => deletePrefix(bucket, prefix)));
}

/** 整篇删除：所有修订版目录一把清掉。 */
export async function deleteDocObjects(bucket: R2Bucket, id: string): Promise<void> {
  await deletePrefix(bucket, docPrefix(id));
}
