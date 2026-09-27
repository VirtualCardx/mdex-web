import type { ExtractAssetsOptions, ParseOptions } from "../shared/mdex";

/** Hono 的 env 泛型：绑定来自 wrangler.jsonc + bindings.d.ts，变量放本次请求的会话状态。 */
export interface AppEnv {
  Bindings: Cloudflare.Env;
  Variables: {
    sessionExpiresAt: number;
  };
}

export interface AppConfig {
  /** 单次上传的字节上限。 */
  maxUploadBytes: number;
  /** 站点口令；未配置为 null。 */
  password: string | null;
  /** 会话签名密钥；未配置为 null。 */
  sessionSecret: string | null;
}

const DEFAULT_MAX_UPLOAD_MB = 32;

/** `wrangler secret put` 常把行尾换行一并写进去，因此 secrets 一律 trim 后再用。 */
function nonEmptySecret(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function readConfig(env: Cloudflare.Env): AppConfig {
  const parsed = Number.parseInt(env.MAX_UPLOAD_MB ?? "", 10);
  const mb = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_UPLOAD_MB;
  return {
    maxUploadBytes: mb * 1024 * 1024,
    password: nonEmptySecret(env.MDEX_PASSWORD),
    sessionSecret: nonEmptySecret(env.SESSION_SECRET),
  };
}

/** 正文解压上限。一份 8MB 的 markdown 已是极端值。 */
const MARKDOWN_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 校验阶段只解压 `meta.json` 与候选正文（`includeAssetBytes: false`）。
 *
 * 图片字节既不入内存、也不计入预算，所以这里的数字回答的只是「正文能有多大」，
 * 与上传体积无关 —— 32MB 的压缩包配上 16MB 的解压预算，峰值内存完全可控。
 */
export const VALIDATION_LIMITS: ParseOptions = {
  includeAssetBytes: false,
  maxEntryBytes: MARKDOWN_MAX_BYTES,
  maxTotalBytes: MARKDOWN_MAX_BYTES * 2,
  maxEntries: 4096,
};

/**
 * 资源解压预算。图片本身几乎不可压缩，解压后总量按上传上限放行即可；
 * 这个数字同时是 zip 炸弹的防线（压缩率 1000:1 的构造包会在这里被拒）。
 */
export function assetLimits(cfg: AppConfig): ExtractAssetsOptions {
  return {
    maxEntryBytes: cfg.maxUploadBytes,
    maxTotalBytes: cfg.maxUploadBytes,
    maxEntries: 4096,
  };
}
