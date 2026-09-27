import { defineConfig } from "vitest/config";

// 独立于 vite.config.ts：单元测试只覆盖 src/shared 的同构代码，
// 不需要 @cloudflare/vite-plugin 去启动 workerd。
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
