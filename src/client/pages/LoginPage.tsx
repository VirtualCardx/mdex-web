/**
 * 登录页。口令校验通过后写入 HttpOnly 签名 Cookie，因此后续请求自动带凭证。
 */

import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";

import { errorMessage, getSession, login } from "../lib/api";

/** 只接受站内路径，挡掉 `//evil.com` 这类开放重定向。 */
function safeRedirect(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [checking, setChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const redirectTo = safeRedirect(searchParams.get("redirect"));

  useEffect(() => {
    let active = true;
    getSession()
      .then((session) => {
        if (!active) return;
        setAuthenticated(session.authenticated);
        setNotConfigured(!session.configured);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (checking) {
    return (
      <div className="app-shell flex items-center justify-center bg-bg text-sm text-muted">
        正在检查登录状态…
      </div>
    );
  }

  if (authenticated) return <Navigate to={redirectTo} replace />;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(password);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    // 软键盘弹出会压缩 dvh，overflow-y-auto 保证表单仍可滚到可见区域
    <div className="app-shell flex items-center justify-center overflow-y-auto bg-bg px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-2xl border border-line bg-panel p-6 shadow-xl"
      >
        <h1 className="text-lg font-semibold text-heading">MDexWeb</h1>
        <p className="mt-1 text-sm text-muted">在线存储、预览与编辑 .mdex 文档</p>

        <label htmlFor="password" className="mt-6 block text-xs font-medium text-soft">
          访问口令
        </label>
        <input
          id="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1.5 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
          placeholder="请输入站点访问口令"
        />

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        {notConfigured && (
          <p className="mt-3 text-sm text-amber-400">
            站点尚未配置访问口令（Worker 的 MDEX_PASSWORD），登录不可用。
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || !password}
          className="mt-5 w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/85 disabled:opacity-40"
        >
          {submitting ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}
