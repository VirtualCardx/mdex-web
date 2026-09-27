import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";

import { readConfig, type AppEnv } from "./env";
import { apiError } from "./http";

/** 会话有效期：30 天。 */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const COOKIE_NAME_SECURE = "__Host-mdex_session";
/**
 * `__Host-` 前缀要求 Secure，而 http 下的浏览器会**静默丢弃**它，本地开发会表现为
 * 「登录成功但立刻又要求登录」。因此只在 https 下使用带前缀的名字。
 */
const COOKIE_NAME_DEV = "mdex_session";

/**
 * 免鉴权端点。用精确匹配的 Set 而不是 `startsWith`，避免
 * `/api/auth/login/../docs` 这类规范化差异造成的绕过。
 */
const PUBLIC_PATHS = new Set(["/api/auth/login", "/api/auth/session", "/api/health"]);

/** 无副作用的方法，不做 Origin 校验。 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function cookieName(url: URL): string {
  return url.protocol === "https:" ? COOKIE_NAME_SECURE : COOKIE_NAME_DEV;
}

function cookieOptions(url: URL) {
  const secure = url.protocol === "https:";
  return {
    path: "/",
    httpOnly: true,
    sameSite: "Lax" as const,
    secure,
    maxAge: SESSION_TTL_SECONDS,
  };
}

/**
 * 恒定时间比对：先各自 SHA-256，再比较等长摘要。
 *
 * 直接比原始字符串会因长度不同而短路返回，泄漏口令长度；比较摘要既避免了这一点，
 * 也让 `timingSafeEqual` 拿到的永远是等长输入。
 */
export async function verifyPassword(candidate: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * 会话负载就是过期时间戳本身。
 *
 * Hono 的签名 Cookie 只保证完整性、不代表时效，过期判断必须自己做。
 */
export async function issueSession(c: Context, url: URL, secret: string): Promise<string> {
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  await setSignedCookie(c, cookieName(url), String(expiresAt), secret, cookieOptions(url));
  return new Date(expiresAt).toISOString();
}

export function clearSession(c: Context, url: URL): void {
  deleteCookie(c, cookieName(url), {
    path: "/",
    secure: url.protocol === "https:",
    httpOnly: true,
    sameSite: "Lax",
  });
}

/** 读取并校验会话；未登录或已过期返回 null。 */
export async function readSession(c: Context, secret: string): Promise<number | null> {
  const raw = await getSignedCookie(c, secret, cookieName(new URL(c.req.url)));
  if (typeof raw !== "string") return null;

  const expiresAt = Number(raw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return expiresAt;
}

/**
 * 变异请求的同源校验。
 *
 * 纯粹的纵深防御：`SameSite=Lax` 已经拦下跨站携带 Cookie 的请求。缺少 `Origin`
 * 头时放行，否则 `curl` 之类的命令行客户端全都会被拒。
 */
function isTrustedOrigin(origin: string | undefined, url: URL): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

export function createAuthMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    if (PUBLIC_PATHS.has(url.pathname)) return next();

    if (!SAFE_METHODS.has(c.req.method) && !isTrustedOrigin(c.req.header("origin"), url)) {
      return apiError(c, "FORBIDDEN_ORIGIN", `Origin: ${c.req.header("origin")}`);
    }

    const { sessionSecret } = readConfig(c.env);
    if (!sessionSecret) return apiError(c, "NOT_CONFIGURED");

    const expiresAt = await readSession(c, sessionSecret);
    if (expiresAt === null) return apiError(c, "UNAUTHORIZED");

    c.set("sessionExpiresAt", expiresAt);
    await next();
  };
}
