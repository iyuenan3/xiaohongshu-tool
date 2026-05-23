# ARCHITECTURE — 小红书自运营系统
<!-- 内部结构 + 不能动什么。决策理由→DECISIONS(这里只放结论+链接)；对外契约→SPEC。 -->

## 组件 + 数据流
3 个自有组件 + 1 个 vendored 依赖：

- **`app/`** — Electron 客户端 (主体)。主进程 (CDP attach + Go 子进程管理 + AI agent + SQLite + license) + renderer (React 4-tab UI：控制台 / 素材库 / 帮助，核心 ChatPanel)。
- **`worker/`** — 自有 license server (TS)。激活码授权 + newapi 资源 provisioning。**当前 Cloudflare Worker，迁移中 → alicloud-bj Node 服务** (见 DEPLOYMENT)。
- **`xiaohongshu-mcp/`** — **vendored 上游开源 Go MCP**，作为子进程被 app 拉起，提供 12 个小红书工具。其 README / CLAUDE / CONTRIBUTING 是**上游的**，fork 维护策略见 DECISIONS ADR-010。
- **`x-mcp/`** — ⚠️ **参考代码，gitignored 不跟踪、未复用** (原 MCP 插件版，仅留参考)。非活跃组件。

**数据流**：用户 → ChatPanel → `agent.ts` (调 LLM via newapi 中转) → tool_calls → ① Go MCP (HTTP 调子进程，CDP attach 同一 Chromium 操作小红书) 或 ② renderer 本地工具 (search_local_assets / web_search) → 结果回 agent → 流式渲染。

**CDP attach 关键链路**：主进程 `pickFreePort()` → `appendSwitch('remote-debugging-port')` → spawn Go → 解析 `BIND_PORT` → fetch `/json/version` 拿 wsUrl → POST `/internal/attach`。go-rod attach 同一 Chromium → UI 窗口 + 小红书窗口共进程、cookies 共享。

## 关键技术选型 (理由 → DECISIONS)
- CDP attach (非 launcher 模式) — ADR-002
- 单窗口 + helper-popup 独立小红书窗口 (绕 macOS Retina viewport lock) — DECISIONS + MEMORY
- 所有 MCP 交互走 AI 聊天 (否决 ToolPanel) — ADR-004
- BYOK 通用 OpenAI 三字段 (不预设 provider) — DECISIONS
- license push 通道 (`LicenseManager.onChanged` → `webContents.send`) — 外部状态变化实时反映 UI
- vendored Go MCP 删 `.git` 嵌入顶层跟踪 — ADR-010

## 禁改项 / Forbidden Refactors（防偏差核心）
- **4 个 chromium command-line switch 缺一不可**：`disable-features=CalculateNativeWinOcclusion,BackForwardCache` + `disable-background-timer-throttling` + `disable-renderer-backgrounding` + `disable-backgrounding-occluded-windows`。少 → 窗口隐藏后 Go CDP 报 `-32000` / `context destroyed`。
- **小红书窗口 close 用 `minimize()` 不用 `hide()`** (hide 让 page 从 active targets 消失，Go 看不到)。
- **webview / tab 切换用 `left:-99999px + visibility:hidden`，绝不 `display:none`** (guest page 被 destroy 丢 cookies)。
- **attach 模式 go-rod 绝不调 `MustPage`** (Electron 不支持 `Target.createTarget`)；必走 `selectAttachedPage()` (含 webview target fallback)。
- **`service.go` 所有 `defer page.Close()` 必走 `closeIfNotAttached()`** (attach 下关 page = 关用户窗口)。
- **GET/HEAD 绝不带 body** (`callApi` 检查 `Object.keys(body).length > 0`；空对象也 truthy)。
- **主控窗口锁 1280×800 + `resizable:false`** (macOS Tahoe + Retina fractional scaling viewport lock；别再尝试主控 popup 解锁，见 MEMORY)。
- **newapi 写操作前 `assertXhsTenant`/`assertXhsToken` 护栏** (多租户隔离红线)。
