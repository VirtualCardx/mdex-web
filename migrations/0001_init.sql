-- MDexWeb 文档索引。
--
-- `created` / `modified` 是文档语义时间（原样来自归档内的 meta.json）；
-- `created_at` / `updated_at` 是服务端审计时间。两组时间语义不同，不混用。
--
-- 时间统一存 ISO8601 字符串（UTC，以 Z 结尾），字典序即时间序，因此可以直接
-- 用于 ORDER BY 与索引。
CREATE TABLE IF NOT EXISTS docs (
  id             TEXT    PRIMARY KEY,          -- crypto.randomUUID()
  title          TEXT    NOT NULL DEFAULT '',
  markdown_path  TEXT    NOT NULL DEFAULT 'document.md',
  format_version INTEGER NOT NULL DEFAULT 1,
  r2_key         TEXT    NOT NULL,             -- R2 里的归档对象 key
  size           INTEGER NOT NULL,             -- 归档字节数
  asset_count    INTEGER NOT NULL DEFAULT 0,
  asset_keys     TEXT    NOT NULL DEFAULT '[]',-- 资源 key 的 JSON 数组，供资产面板展示
  rev            INTEGER NOT NULL DEFAULT 1,   -- 乐观锁版本号，同时作为 If-Match
  markdown       TEXT,                         -- 正文缓存；超过 512KB 时写 NULL
  created        TEXT    NOT NULL,
  modified       TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

-- 一个 R2 对象只对应一行
CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_r2_key ON docs(r2_key);

-- 排序索引的列顺序与方向都跟查询保持一致，避免 SQLite 建临时 B-tree。
-- 带上 id 作为并列项，否则相同时间/大小的行会在翻页时重复或丢失。
CREATE INDEX IF NOT EXISTS idx_docs_modified ON docs(modified DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_docs_created  ON docs(created DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_docs_size     ON docs(size DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_docs_title    ON docs(title COLLATE NOCASE, id);
