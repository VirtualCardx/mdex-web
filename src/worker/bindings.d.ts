/**
 * `wrangler types` 只会把 wrangler.jsonc 里的 `vars` 推导进 `Env`，secrets 不在配置
 * 文件里，因此必须在这里手工合并声明。
 *
 * 两个都声明为可选：未配置时 API 走 fail-closed（503 NOT_CONFIGURED），不静默放行。
 *
 * 生成文件 `worker-configuration.d.ts` 里同时有全局 `interface Env` 与
 * `declare namespace Cloudflare { interface Env }`，两处都要补，否则代码里用哪个
 * 名字都会缺字段。
 */
interface Env {
  /** 站点访问口令。 */
  MDEX_PASSWORD?: string;
  /** 会话 Cookie 的 HMAC 签名密钥。 */
  SESSION_SECRET?: string;
}

declare namespace Cloudflare {
  interface Env {
    MDEX_PASSWORD?: string;
    SESSION_SECRET?: string;
  }
}
