import { Hono } from "hono";

import { buildMdexSync, newArchive, parseMdexSync } from "../shared/mdex";
import { nowRfc3339 } from "../shared/time";
import { MDEX_FORMAT } from "../shared/types";
import { createAuthMiddleware } from "./auth";
import type { AppEnv } from "./env";
import { apiError, failFromUnknown } from "./http";
import authRoutes from "./routes/auth";
import docsRoutes from "./routes/docs";

const app = new Hono<AppEnv>();

app.use("/api/*", createAuthMiddleware());

/**
 * 自检 fflate 在 workerd 里可用。
 *
 * 这里刻意走**同步**入口并真的打包再解开一次：fflate 的异步 API 依赖 `Worker` 全局
 * 对象，而 workerd 没有，一旦误用（例如从 mdex.ts 里 import 了异步实现并触发求值）
 * 就会在这里以 `Worker is not defined` 暴露出来，而不是等到用户上传文件时才发现。
 * 结果按 isolate 缓存，不重复付出代价。
 */
let zipSelfCheck: { ok: boolean; detail?: string } | null = null;

function runZipSelfCheck(): { ok: boolean; detail?: string } {
  try {
    const bytes = buildMdexSync(newArchive("health"));
    const archive = parseMdexSync(bytes);
    if (archive.meta.format !== MDEX_FORMAT) {
      return { ok: false, detail: `format 读回为 ${archive.meta.format}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

app.get("/api/health", (c) => {
  zipSelfCheck ??= runZipSelfCheck();
  return c.json({
    ok: zipSelfCheck.ok,
    now: nowRfc3339(),
    zip: zipSelfCheck,
  });
});

app.route("/api/auth", authRoutes);
app.route("/api/docs", docsRoutes);

/**
 * 只有 `/api/*` 会以 worker-first 方式进来（见 wrangler.jsonc 的 `run_worker_first`），
 * 其余路径由静态资源直接返回并回退到 SPA。所以这里的 404 一律是接口 404。
 */
app.notFound((c) => apiError(c, "NOT_FOUND", `无此接口: ${new URL(c.req.url).pathname}`));

app.onError((err, c) => failFromUnknown(c, err));

export default app;
