import { Hono } from "hono";

import { clearSession, issueSession, readSession, verifyPassword } from "../auth";
import { readConfig, type AppEnv } from "../env";
import { apiError } from "../http";

const app = new Hono<AppEnv>();

/** 从任意 JSON 里安全取出 `password` 字段。 */
function readPassword(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>).password;
  return typeof value === "string" ? value : null;
}

app.post("/login", async (c) => {
  const { password, sessionSecret } = readConfig(c.env);
  // fail-closed：没配 secret 就不放行，绝不静默变成「无口令站点」
  if (!password || !sessionSecret) return apiError(c, "NOT_CONFIGURED");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, "INVALID_REQUEST", "请求体不是合法 JSON");
  }

  const candidate = readPassword(body);
  if (candidate === null) return apiError(c, "INVALID_REQUEST", "缺少 password 字段");

  if (!(await verifyPassword(candidate, password))) {
    return apiError(c, "INVALID_CREDENTIALS");
  }

  const expiresAt = await issueSession(c, new URL(c.req.url), sessionSecret);
  return c.json({ authenticated: true, expiresAt });
});

app.post("/logout", (c) => {
  clearSession(c, new URL(c.req.url));
  return c.body(null, 204);
});

/** 供前端启动时判断是否已登录；未配置口令时视为未登录，由登录页给出提示。 */
app.get("/session", async (c) => {
  const { sessionSecret } = readConfig(c.env);
  if (!sessionSecret) return c.json({ authenticated: false, configured: false });

  const expiresAt = await readSession(c, sessionSecret);
  return c.json({
    authenticated: expiresAt !== null,
    configured: true,
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
  });
});

export default app;
