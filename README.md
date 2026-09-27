# MDexWeb

[English](README.en.md) | 简体中文

把 `.mdex` 文档放到 Cloudflare Workers 上：在线存储、预览与编辑。

`.mdex` 是一种 Markdown 文档归档格式（zip 容器），由桌面版参考实现（Rust/Tauri）定义；本项目是其 Web 端的完整实现，与桌面版文件互通。单密码登录，适合个人文档库自托管。

## 功能特性

- **密码登录**：单用户密码认证，HttpOnly 签名 Cookie 会话
- **文档管理**：列表（标题 / 大小 / 资源数 / 时间）、上传与下载 `.mdex` 整包
- **在线预览**：KaTeX 数学公式、highlight.js 代码高亮、DOMPurify HTML 消毒
- **在线编辑**：CodeMirror 6 编辑器 + 左右分屏实时预览，支持粘贴截图自动入库、资源面板管理附件、`Ctrl/Cmd+S` 保存
- **乐观锁**：每次保存携带 `If-Match: "<rev>"`，409 冲突时提供「重新载入 / 强制覆盖」两条出路，杜绝静默丢稿
- **历史快照**：每次保存的整包按 rev 归档到 R2，可回溯
- **移动端适配**：正常 / 窄边距切换（偏好持久化到 localStorage），触屏下滚动条不占布局空间

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 19 · Vite 8 · Tailwind CSS 4 · CodeMirror 6 · KaTeX |
| Worker | Hono 4 · TypeScript（Vite 构建，`@cloudflare/vite-plugin`） |
| 存储 | Cloudflare D1（文档元数据）· R2（整包 / 历史快照 / 资源） |
| 测试 | vitest（`src/shared` 核心模块单测） |

## 快速开始

前置要求：Node.js 20+，并已 `wrangler login`。

```bash
# 1. 安装依赖
npm install

# 2. 本地环境变量（复制后填写）
cp .dev.vars.example .dev.vars

# 3. 本地 D1 迁移
npm run db:migrate:local

# 4. 启动开发服务器
npm run dev
```

## 部署

```bash
wrangler login

# 创建资源，并把回显的 database_id 填入 wrangler.jsonc
wrangler d1 create mdexweb
wrangler r2 bucket create mdexweb-docs

# 远端迁移 + 密钥
npm run db:migrate:remote
wrangler secret put MDEX_PASSWORD
wrangler secret put SESSION_SECRET

# 构建并部署
npm run deploy
```

## 配置说明

| 变量 | 类型 | 说明 |
|---|---|---|
| `MDEX_PASSWORD` | Secret | 登录密码 |
| `SESSION_SECRET` | Secret | 会话 Cookie 签名密钥（长随机串） |
| `MAX_UPLOAD_MB` | 变量 | 整包上传大小上限，默认 `32` |

## `.mdex` 格式

zip 归档，布局如下：

```text
meta.json      {"format":"mdex","version":1,"title":...,"created":...,"modified":...}
document.md    正文
assets/        正文以 assets/<name> 引用的二进制资源
```

Worker 侧同步解析（带 zip 炸弹防护：单条目 / 总量 / 条目数上限），浏览器侧异步解压避免卡顿；`meta.json` 的未知字段在往返中保留，时间戳按原始字符串原样透传，确保与桌面版字节级兼容。

## API 概览

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/auth/login` | 登录 |
| `POST` | `/api/auth/logout` | 退出 |
| `GET` | `/api/auth/session` | 会话状态 |
| `GET` | `/api/docs` | 文档列表（分页） |
| `POST` | `/api/docs` | 上传新文档 |
| `GET` | `/api/docs/:id` | 文档详情与正文缓存 |
| `PUT` | `/api/docs/:id` | 更新（需 `If-Match: "<rev>"`） |
| `DELETE` | `/api/docs/:id` | 删除 |
| `GET` | `/api/docs/:id/raw` | 下载整包 |
| `GET` | `/api/docs/:id/asset?key=` | 读取资源 |

## 开发

```bash
npm test    # vitest 单测
npm run build   # 类型检查 + 构建
```

目录结构：

```text
src/
  client/    React 前端（登录 / 列表 / 预览 / 编辑分屏）
  worker/    Hono Worker（认证 / 文档 API / D1·R2 存取）
  shared/    Worker 与浏览器共用的核心模块（.mdex 解析打包、类型、工具）
migrations/  D1 迁移
```
