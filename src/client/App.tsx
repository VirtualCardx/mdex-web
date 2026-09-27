/**
 * 应用外壳与路由。
 *
 * 这里刻意没有单独的 AuthProvider：登录态只有一处需要判断（受保护路由的布局），
 * 布局自己请求 `/api/auth/session` 即可，省掉一层跨文件循环依赖。
 */

import { useEffect, useState } from "react";
import {
  createBrowserRouter,
  Link,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
  useNavigate,
} from "react-router-dom";

import { getSession, logout, setUnauthorizedHandler } from "./lib/api";
import { ToastProvider } from "./components/Toast";
import EditPage from "./pages/EditPage";
import ListPage from "./pages/ListPage";
import LoginPage from "./pages/LoginPage";
import PreviewPage from "./pages/PreviewPage";

type Theme = "dark" | "light";

const THEME_KEY = "mdex.theme";

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage 不可用：退回系统偏好
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

// 在首帧之前就把主题写到 <html> 上，避免亮色系统下先闪一下深色。
const initialTheme = readTheme();
document.documentElement.dataset.theme = initialTheme;

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // 写入失败：主题只在本次会话生效
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
      className="rounded-md border border-line px-2.5 py-1 text-xs text-fg transition-colors hover:bg-raised"
    >
      {theme === "dark" ? "☾" : "☀"}
    </button>
  );
}

type SessionState = "checking" | "authenticated" | "anonymous";

/** 受保护路由的布局：未登录直接跳登录页，并带上回跳地址。 */
function ProtectedLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionState>("checking");

  useEffect(() => {
    let active = true;
    getSession()
      .then((info) => {
        if (active) setSession(info.authenticated ? "authenticated" : "anonymous");
      })
      .catch(() => {
        if (active) setSession("anonymous");
      });
    return () => {
      active = false;
    };
  }, []);

  // 任何请求收到 401 都会走到这里：把登录态翻成未登录，由下面的 Navigate 统一跳转。
  useEffect(() => {
    setUnauthorizedHandler(() => setSession("anonymous"));
    return () => setUnauthorizedHandler(null);
  }, []);

  if (session === "checking") {
    return (
      <div className="flex h-screen items-center justify-center bg-bg text-sm text-muted">
        正在检查登录状态…
      </div>
    );
  }

  if (session === "anonymous") {
    const redirect = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?redirect=${encodeURIComponent(redirect)}`} replace />;
  }

  const handleLogout = async () => {
    try {
      await logout();
    } finally {
      setSession("anonymous");
      navigate("/login", { replace: true });
    }
  };

  return (
    <ToastProvider>
      <div className="flex h-screen min-h-0 flex-col bg-bg">
        <header className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2">
          <Link to="/" className="text-sm font-semibold text-heading">
            MDexWeb
          </Link>
          <span className="hidden text-xs text-muted sm:inline">在线 .mdex 文档</span>
          <span className="flex-1" />
          <ThemeToggle />
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="rounded-md border border-line px-2.5 py-1 text-xs text-fg transition-colors hover:bg-raised"
          >
            退出登录
          </button>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </ToastProvider>
  );
}

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    element: <ProtectedLayout />,
    children: [
      { path: "/", element: <ListPage /> },
      { path: "/d/:id", element: <PreviewPage /> },
      { path: "/d/:id/edit", element: <EditPage /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
