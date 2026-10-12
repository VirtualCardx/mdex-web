/**
 * 订阅一条 CSS 媒体查询。
 *
 * 只在「CSS 无法表达、必须在 JS 里分支布局」时才用它——例如编辑页窄屏要换成单栏
 * 标签页，而这决定了哪些组件该挂载、哪些该隐藏，纯 CSS 做不到。能靠 `max-md:` 这类
 * 工具类或媒体查询解决的场景，就不要引入它。
 */

import { useEffect, useState } from "react";

/** 窄屏断点。必须与 `index.css` 里 `@media (max-width: 767.98px)` 保持一致。 */
export const MOBILE_QUERY = "(max-width: 767.98px)";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    // query 变化时先对齐一次，否则会拿上一条查询的结果继续渲染
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** 是否窄屏（手机 / 小屏设备）。 */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}
