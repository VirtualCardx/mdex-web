# MDexWeb

English | [简体中文](README.md)

Host your `.mdex` documents on Cloudflare Workers: online storage, preview and editing.

`.mdex` is a Markdown document archive format (a zip container) defined by the desktop reference implementation (Rust/Tauri); this project is a complete web implementation that is fully interoperable with the desktop version. Single-password login makes it ideal for self-hosting a personal document library.

## Features

- **Password login**: single-user password auth with a signed HttpOnly cookie session
- **Document management**: list (title / size / asset count / timestamps), upload and download `.mdex` archives
- **Preview**: KaTeX math, highlight.js code highlighting, DOMPurify HTML sanitization
- **Online editing**: CodeMirror 6 editor with a live split-pane preview, paste screenshots as assets, an asset panel for attachments, and `Ctrl/Cmd+S` to save
- **Optimistic locking**: every save sends `If-Match: "<rev>"`; on a 409 conflict you can reload or force-overwrite — no silent lost edits
- **Revision snapshots**: every saved archive is stored in R2 keyed by rev for traceability
- **Mobile friendly**: normal / narrow margin toggle (persisted in localStorage) with scrollbars that take no layout space on touch devices

## Tech Stack

| Layer | Choices |
|---|---|
| Frontend | React 19 · Vite 8 · Tailwind CSS 4 · CodeMirror 6 · KaTeX |
| Worker | Hono 4 · TypeScript (built with Vite + `@cloudflare/vite-plugin`) |
| Storage | Cloudflare D1 (document metadata) · R2 (archives / snapshots / assets) |
| Testing | vitest (unit tests for the shared `src/shared` modules) |

## Getting Started

Prerequisites: Node.js 20+ and an authenticated `wrangler login`.

```bash
# 1. Install dependencies
npm install

# 2. Local environment variables (copy, then fill in)
cp .dev.vars.example .dev.vars

# 3. Apply local D1 migrations
npm run db:migrate:local

# 4. Start the dev server
npm run dev
```

## Deployment

```bash
wrangler login

# Create resources, then paste the returned database_id into wrangler.jsonc
wrangler d1 create mdexweb
wrangler r2 bucket create mdexweb-docs

# Remote migrations + secrets
npm run db:migrate:remote
wrangler secret put MDEX_PASSWORD
wrangler secret put SESSION_SECRET

# Build and deploy
npm run deploy
```

## Configuration

| Variable | Type | Description |
|---|---|---|
| `MDEX_PASSWORD` | Secret | Login password |
| `SESSION_SECRET` | Secret | Session cookie signing key (long random string) |
| `MAX_UPLOAD_MB` | Variable | Max archive upload size, defaults to `32` |

## The `.mdex` Format

A zip archive laid out as:

```text
meta.json      {"format":"mdex","version":1,"title":...,"created":...,"modified":...}
document.md    document body
assets/        binary assets referenced from the body as assets/<name>
```

Parsed synchronously on the Worker side (with zip-bomb guards: per-entry / total size / entry count limits) and asynchronously in the browser to keep the UI responsive. Unknown `meta.json` fields are preserved across round-trips and timestamps are passed through verbatim as raw strings, ensuring byte-level compatibility with the desktop version.

## API Overview

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Log in |
| `POST` | `/api/auth/logout` | Log out |
| `GET` | `/api/auth/session` | Session status |
| `GET` | `/api/docs` | Document list (paginated) |
| `POST` | `/api/docs` | Upload a new document |
| `GET` | `/api/docs/:id` | Document detail with cached body |
| `PUT` | `/api/docs/:id` | Update (requires `If-Match: "<rev>"`) |
| `DELETE` | `/api/docs/:id` | Delete |
| `GET` | `/api/docs/:id/raw` | Download the archive |
| `GET` | `/api/docs/:id/asset?key=` | Fetch an asset |

## Development

```bash
npm test    # vitest unit tests
npm run build   # type check + build
```

Project layout:

```text
src/
  client/    React frontend (login / list / preview / split-pane editor)
  worker/    Hono Worker (auth / document API / D1 & R2 access)
  shared/    Core modules shared by Worker and browser (.mdex parsing/packing, types, utils)
migrations/  D1 migrations
```
