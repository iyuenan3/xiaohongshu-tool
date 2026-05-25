# ARCHITECTURE — 小红书自运营系统
<!-- 内部结构 + 不能动什么。决策理由→DECISIONS(这里只放结论+链接)；对外契约→SPEC。 -->

## 组件 + 数据流
3 个自有组件 + 1 个 vendored 依赖：

- **`app/`** — Electron 客户端 (主体)。主进程 (CDP attach + Go 子进程管理 + AI agent + SQLite + license) + renderer (React 4-tab UI：控制台 / 素材库 / 帮助，核心 ChatPanel)。
- **`worker/`** — 自有 license server (TS)。激活码授权 + newapi 资源 provisioning。**当前 Cloudflare Worker (v0.6.0 LIVE)；迁移中 → 抽出本 repo，落新 sibling monorepo `doubleL-license` 的 `apps/xhs-license` (Hono Node 服务，见 DECISIONS ADR-011/012 + DEPLOYMENT)**。worker/ 迁后留作参考素材 (crypto/admin-ui 复用源)，B' 跑通后清。
- **`xiaohongshu-mcp/`** — **vendored 上游开源 Go MCP**，作为子进程被 app 拉起，提供 12 个小红书工具。其 README / CLAUDE / CONTRIBUTING 是**上游的**，fork 维护策略见 DECISIONS ADR-010。
- **`x-mcp/`** — ⚠️ **参考代码，gitignored 不跟踪、未复用** (原 MCP 插件版，仅留参考)。非活跃组件。

**数据流**：用户 → ChatPanel → `agent.ts` (调 LLM via newapi 中转) → tool_calls → ① Go MCP (HTTP 调子进程，CDP attach 同一 Chromium 操作小红书) 或 ② renderer 本地工具 (search_local_assets / web_search) → 结果回 agent → 流式渲染。

| 场景 | 流向 |
|---|---|
| AI 侧边栏发消息 | Renderer → LLM (newapi 中转 HTTPS) → Renderer |
| AI 调 MCP 工具 | Renderer → IPC → Main → HTTP localhost → Go → CDP → Chromium |
| 激活 / 心跳 | Renderer → IPC → Main → license server (HTTPS) → 写本地 license |
| 工作流到点 | Main `WorkflowScheduler` → 固定骨架 → callTool (Go MCP) + callLLM (单次 completion) |

## 进程模型 + 启动顺序
Main (Node) 编排：App 生命周期 / Go 子进程 / LicenseManager / ipcMain / updater。spawn Go 子进程 (HTTP server on 127.0.0.1) + 创建 Renderer (Chromium)。

**冷启动 state machine**：加载 userData 配置 → License 检查 (无 token / 过期 → 激活窗口；machine_id 不匹配 → 提示联系客服换绑；valid → 继续) → spawn Go (等 ready) → 创建 BrowserWindow → CDP 握手 attach → 显示主窗 + AI 侧边栏 → 后台 heartbeat 调度。

**CDP attach 握手 (禁改链路)**：主进程 `pickFreePort()` → `appendSwitch('remote-debugging-port', 0)` → spawn Go (`--port=:0`) → 解析 stdout `BIND_PORT=` → fetch `http://127.0.0.1:<dbg>/json/version` 拿 `webSocketDebuggerUrl` → POST Go `/internal/attach {cdp_endpoint}` → Go `rod.New().ControlURL(ws).MustConnect()` → `selectAttachedPage()` 选小红书页。go-rod attach 同一 Chromium → UI 窗口 + 小红书窗口共进程、cookies 共享。

## 客户端模块结构 (`app/src/`)
- **主进程 (`main/`)**：`index.ts` (编排启动) · `go-subprocess.ts` (spawn + health + HTTP 透传 `go:api(method,path,body)`) · `license.ts` (machine-id 加盐 SHA-256 + activate/heartbeat + Ed25519 验签 + **file-base64 存储**，去 safeStorage、安全靠服务端 verify machine_id) · `ipc.ts` (统一 ipcMain.handle，`contextBridge.exposeInMainWorld('api', …)`) · `assets.ts` (素材库) · `web-search.ts` (隐藏 BrowserWindow 抓搜狗，串行 mutex + 15s timeout) · `workflow-scheduler.ts` (M7) · `stealth.ts`。
- **renderer (`renderer/`)**：4-tab (控制台 / 小红书 webview / 素材库 / 帮助)。控制台 = `ConsolePane` (`grid 25%/75%`) 容 `CommandPalette` + `ConversationList` + `WorkflowList` (左) / `ChatPanel` (右)。AI 核心：`llm/agent.ts` tool-calling loop (累积 stream → tool_calls → 确认 → 回灌 → 直到无 tool_call) + `llm/provider.ts` (openai-node, `dangerouslyAllowBrowser`) + `llm/sensitivity.ts` (`SENSITIVE_TOOLS` 6 个：publish_content / publish_with_video / post_comment_to_feed / reply_comment_in_feed / like_feed / favorite_feed → 弹确认)。
- **页面上下文感知**：chat 触发时 `webContents.executeJavaScript` 取 `{url, title, body.innerText 截 4000}` 注入 system message 末尾。
- **频率护栏**：`rate-limit/guards.ts` publish 3/天 + 30min gap、comment 10/h、like/favorite 30/h；计数存 `rate_log`，超限返 `warn` 弹二次确认 (软不硬拦，红线见 CORE)。

## Go 端改造 (vendored `xiaohongshu-mcp/`)
- **新增 `--cdp-endpoint` + attach 模式**：非空走 attach (不自启 Chrome)，空则维持原自启 (向后兼容 Docker)。
- **`--port=:0`** 随机端口，stdout 打 `BIND_PORT=<n>` 供主进程解析。
- **`/internal/attach`** (仅 127.0.0.1)：主进程注入 CDP endpoint，Go 用 rod attach。
- **cookies 路径** = `$XHS_USER_DATA_DIR/cookies.json` (主进程传 `app.getPath('userData')`)。
- **`cmd/login` 弃用** (用户直接在 Electron 窗口登录；代码留供 Docker 用户)。
> attach 模式的多 page 隔离 / `defer page.Close()` 风险 / chromium switch / `minimize` 不 `hide` 见**禁改项**。

## 客户端数据模型
- **SQLite (`userData/app.db`，better-sqlite3 单例，同步写天然串行)**：会话 / 消息 / 频率 (`rate_log`) / 素材库 (`media_assets` + `tags`/`description`/`analyzed` 列) / 草稿 (`drafts`) + **M7**: `workflows` / `workflow_runs` / `appConfig` (含 `schema_version` / `workflow_risk_accepted`)。schema migration 走 `db/migrations.ts` (`user_version` pragma 递增建新表，老用户升级不影响老功能、无需回滚)。
- **文件存储 (`userData/`)**：`app.db` (明文) · `license.json/.bin` (激活 token + 元数据 + 中转 llm 配置，base64 JSON) · `byok.bin` (BYOK key，safeStorage 加密) · `config.json` (偏好) · `cookies.json` (Go 写) · `logs/{main,renderer,go}.log`。
- **自定义协议 `xhs-asset://`**：`protocol.handle` 把 `xhs-asset://<id>` 映射本地素材文件 (绕 `file://` 在 localhost 的 mixed-content / CORS)。

## 工作流引擎 (M7 / v0.7，已 ship)
- **模型**：用户预定义「模板 + 参数 + 调度」→ 主进程 `WorkflowScheduler` 到点触发**固定骨架**，创意步骤 (如评论文案) 调 LLM 单次 completion (非 agent loop)。共享 license.llm 凭证 / RateLimiter / app.db / 工具实现。
- **`WorkflowScheduler` (`main/workflow-scheduler.ts`)**：`timers` Map (workflow_id→setTimeout) + `running`/`queue` 串行 + `fireMutex` 防 IPC race。`computeNextFireTime` 按**创建时锁定的 tz** 算 base + ±10min 抖动 (不跟系统漂移)。`powerMonitor.on('resume')` → `recomputeAll` (睡眠期 setTimeout 不推进的兜底)。错过调度写 `missed` 不补跑；连续 3 fail → `enabled=0` auto-disable (partial 不计 fail)。
- **风控加固**：调度抖动 ±10min / 步骤间随机 30-90s / 步骤硬上限 (top_n≤5, comment<3) / 全局 RateLimiter / 首次启用 `RiskWarningDialog` / LLM call timeout 30s + retry 1 (指数退避) / 跨工作流 quota 冲突 queue 串行 + 单步跳过记 partial。
- **模板 (`main/workflow-templates/*.ts`)**：P1 `daily_like_comment` (✅) + P2 `scheduled_publish` / `daily_signin_interact` / `daily_data_snapshot` / `keyword_like_comment`。每个 export `{id, name, emoji, paramsSchema, execute(params, helpers)}`，helpers = `{callTool, callLLM, sleep, log}`。
- **错误矩阵**：run status = running / success / partial / failed / missed / aborted；`fail_reason` 标准化 = llm_timeout / llm_5xx / quota_exhausted / llm_auth / rate_limited / xhs_reject / network / user_abort / unknown，每类映射用户视角中文 summary；`classifyError` 按异常类型 + message 关键字归类。
- **IPC (`workflow:*`)**：list / create / update / delete (soft-delete) / enable / run-now / runs / get-templates / dev-fire-soon + push events (run-started / run-step-update / run-finished / auto-disabled)。
- **护栏继承**：复用 agent.ts 的 license LLM 路径，D6 quota / overdue 软停 / 多租户隔离 / cert 放行全生效；suspended → callLLM 抛 InsufficientQuotaError、revoked → scheduler init 跳过注册。工作流 LLM 消耗计入同一月度 quota，超额标 `quota_exhausted`、下月 reset 自动恢复 (不另收费，M8 前评估是否分桶)。

## 关键技术选型 (理由 → DECISIONS)
- CDP attach (非 launcher 模式) — ADR-002
- 单窗口 + helper-popup 独立小红书窗口 (绕 macOS Retina viewport lock) — DECISIONS + MEMORY
- 所有 MCP 交互走 AI 聊天 (否决 ToolPanel) — ADR-004
- BYOK 通用 OpenAI 三字段 (不预设 provider) — DECISIONS
- license push 通道 (`LicenseManager.onChanged` → `webContents.send`) — 外部状态变化实时反映 UI
- vendored Go MCP 删 `.git` 嵌入顶层跟踪 — ADR-010
- 栈：Electron + TS/Node + React/Vite + Zustand + better-sqlite3 + openai-node + Ed25519 + electron-builder + electron-log

## 禁改项 / Forbidden Refactors（防偏差核心）
- **4 个 chromium command-line switch 缺一不可**：`disable-features=CalculateNativeWinOcclusion,BackForwardCache` + `disable-background-timer-throttling` + `disable-renderer-backgrounding` + `disable-backgrounding-occluded-windows`。少 → 窗口隐藏后 Go CDP 报 `-32000` / `context destroyed`。
- **小红书窗口 close 用 `minimize()` 不用 `hide()`** (hide 让 page 从 active targets 消失，Go 看不到)。
- **webview / tab 切换用 `left:-99999px + visibility:hidden`，绝不 `display:none`** (guest page 被 destroy 丢 cookies)。
- **attach 模式 go-rod 绝不调 `MustPage`** (Electron 不支持 `Target.createTarget`)；必走 `selectAttachedPage()` (含 webview target fallback)。
- **`service.go` 所有 `defer page.Close()` 必走 `closeIfNotAttached()`** (attach 下关 page = 关用户窗口)。
- **GET/HEAD 绝不带 body** (`callApi` 检查 `Object.keys(body).length > 0`；空对象也 truthy)。
- **主控窗口锁 1280×800 + `resizable:false`** (macOS Tahoe + Retina fractional scaling viewport lock；别再尝试主控 popup 解锁，见 MEMORY)。
- **stealth 注入**：`web-contents-created` 时注 `navigator.webdriver=undefined` + plugins/languages + 真 Chrome UA。
- **newapi 写操作前 `assertXhsTenant`/`assertXhsToken` 护栏** (多租户隔离红线，见 CORE)。
