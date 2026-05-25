# 小红书自运营系统 SPEC

> 技术规格说明书 v0.4 · 2026-05-20 · 配套 PRD v0.7
>
> **v0.4 变更 (2026-05-20)**: M7 工作流模块拍板, 文末追加 §13 工作流引擎 (SQLite schema + WorkflowScheduler 主进程 + IPC contract + 5 模板规格 + 风控加固实现细节).
>
> **v0.3 变更 (2026-05-19)**: D6 LLM Gateway 拍板, 文末追加 §12.10 中转架构 (newapi 资源 + Worker 端点改动 + 客户端 license.json schema 扩展 + cert 放行 + dev 模式暗号 + 配额展示).
>
> **v0.2 变更 (2026-05-17)**: v0.2.0~v0.3.0 系列 ship 完毕, 文末追加 §12 增量模块章节 (素材库 / 联网搜索 / 自定义协议 / 网页管理后台 / mac 打包流水线).
> v0.1 部分内容仍 valid, 但部分被取代:
> - §2.2 `license.ts` 改用文件 base64 (§12.5 详述)
> - §3.2 ChatSidebar.tsx → ChatPanel.tsx + ConsolePane / CommandPalette / ConversationList (§12.1 详述)
> - 11 工具变 13 工具 (新增 `search_local_assets` + `web_search` §12.3)
> - §3.2 BYOK 配置 UI 默认隐藏, dev 模式暗号解锁 (§12.10 详述)

## 0. 文档定位

- **读者**：开发者（你自己 + 未来协作者 / AI 助手）
- **关系**：PRD 回答"做什么/为什么"，SPEC 回答"怎么做"
- **粒度**：轻量级——模块边界 + 接口签名 + 关键数据结构。具体代码实现留给开发阶段。
- **配套文档**：[PRD.md](./PRD.md) · [ROADMAP.md](./ROADMAP.md)

## 1. 系统全景

### 1.1 进程模型

```
┌─────────────────────────────────────────────────────────────┐
│ Electron App (用户本机)                                       │
│                                                              │
│   ┌─ Main Process (Node.js) ──────────────────────┐         │
│   │  • App lifecycle / Window management          │         │
│   │  • Go subprocess management                   │         │
│   │  • License Manager                            │         │
│   │  • IPC handler (ipcMain)                      │         │
│   │  • Auto updater                               │         │
│   └────────┬─────────────────┬─────────────────────┘        │
│            │ IPC             │ spawn + stdio                │
│            ↓                 ↓                              │
│   ┌─ Renderer (Chromium) ─┐ ┌─ Go Subprocess ──────────┐   │
│   │ • AI Sidebar (React)  │ │ xiaohongshu-mcp           │   │
│   │ • Settings / Activate │ │ HTTP server (127.0.0.1)   │   │
│   │ • Browser tabs        │ │ go-rod via CDP            │   │
│   │ • LLM client (BYOK)   │ │                           │   │
│   └───────────────────────┘ └───────────────────────────┘   │
│            ↑                          ↑                      │
│            │ remote-debugging-port    │ CDP attach           │
│            └──────────────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTPS (仅激活/心跳)
                                    ↓
                ┌──────────────────────────────────┐
                │ Cloudflare Worker (License)      │
                └──────────────────────────────────┘
```

### 1.2 关键数据流

| 场景 | 流向 |
|---|---|
| 用户在 AI 侧边栏发消息 | Renderer → LLM API（HTTPS 直连）→ Renderer |
| AI 调用 MCP 工具 | Renderer → IPC → Main → HTTP localhost → Go → CDP → Chromium |
| 用户在浏览器登录小红书 | Renderer 直接操作 Chromium 页面 |
| 应用启动 | Main spawn Go subprocess → Go 等待 CDP endpoint → Main 启 BrowserWindow 拿到 ws → IPC 给 Go → Go attach |
| 激活 | Renderer → IPC → Main → Cloudflare Worker → 写本地 token |

### 1.3 技术选型表（简要理由）

| 维度 | 选型 | 一句话理由 |
|---|---|---|
| 桌面框架 | Electron | 唯一稳定打包完整 Chromium 的方案 |
| 主进程语言 | TypeScript + Node 20 | Electron 原生支持 |
| 渲染端框架 | React + Vite | 生态成熟，HMR 体验最好 |
| 状态管理 | Zustand | 比 Redux 轻 10 倍，对一人项目刚好 |
| MCP 服务 | 复用现有 Go (`xiaohongshu-mcp`) | 12 个 Go 工具已实现, 加 2 个 renderer 本地工具 (v0.2/v0.3) |
| LLM 客户端 | `openai-node` npm 包 | OpenAI 兼容端点全覆盖，流式 + tool calling 一等公民 |
| 本地存储 | SQLite (better-sqlite3) | 零配置、单文件、同步 API 简单 |
| 加密存储 | Electron `safeStorage` | 跨平台自动用系统 keychain |
| 机器指纹 | `node-machine-id` | 一行代码跨平台 |
| 激活服务 | Cloudflare Workers + KV | 免费、零运维、自带 HTTPS 域名 |
| 签名算法 | Ed25519 | 短、快、Node `crypto` 原生支持 |
| 打包 | electron-builder | macOS dmg + Win NSIS + 自动更新一站式 |
| 进程间通信 | Electron IPC (contextBridge) | 安全默认（context isolation） |
| 日志 | electron-log | 自动轮转 + 多平台路径 |

## 2. Electron 主进程

### 2.1 启动流程（State Machine）

```
[Cold Start]
    ↓
[Load Config from app.getPath('userData')]
    ↓
[License Check]
    ├─ no token → [Show Activation Window] → /activate → save token → continue
    ├─ token expired → [Show Activation Window] → /activate → ...
    ├─ token valid + machine_id mismatch → [Show Error: 联系客服换绑]
    └─ token valid + machine_id ok → continue
    ↓
[Spawn Go Subprocess]
    ├─ wait Go ready signal (stdout "READY" or HTTP /health 200)
    └─ get assigned port
    ↓
[Create BrowserWindow]
    ├─ open with --remote-debugging-port=<random>
    └─ wait for CDP WebSocket URL
    ↓
[Send CDP URL → Go via HTTP POST /internal/attach]
    ↓
[Show Main Window with AI Sidebar]
    ↓
[Background: heartbeat scheduler (every 15 days)]
```

### 2.2 模块清单

> ⚠️ **v0.2 重构通知**: 本节中部分接口/模块签名已过时, 真实清单见 §12 增量模块 + `app/src/preload/index.ts`. 具体变化:
> - `window.ts` 不存在 (mainWindow 在 `index.ts` 直接 new BrowserWindow, 锁 1280×800 + resizable:false, 见 [[decisions_macos_tahoe_chromium]])
> - `license.ts` 已重写为 file-base64 存储 (见 §12.5), 取代下方 `safeStorage` 描述
> - `mcp:call` → 实际 `go:api(method, path, body)` HTTP 透传, 不再走 MCP protocol
> - `mcp:listTools` 不暴露 (客户端硬编码 schemas in `ai/tools.ts`)
> - `config:get / set` / `byok:test` 不存在 (BYOK 直接存 localStorage)
> - 新增 30+ IPC: `assets:*` (§12.2) / `web:search` (§12.3) / `license:changed` push event (§12.5 B-001 修复) / `conv:*` / `rate:*` / `updater:check` / `protocol xhs-asset://` (§12.4)
>
> 下方代码仅作为 v0.1 设计意图保留, 不反映 v0.3 实际。

#### `src/main/index.ts`
应用入口，编排上面的启动流程。

#### `src/main/window.ts`
```ts
export function createMainWindow(opts: {
  cdpPort: number;
}): BrowserWindow;

export function createActivationWindow(): BrowserWindow;
```

#### `src/main/go-subprocess.ts`
```ts
export class GoSubprocess {
  start(): Promise<{ port: number; cdpAttach: (wsUrl: string) => Promise<void> }>;
  stop(): Promise<void>;
  health(): Promise<boolean>;
  callMCP(method: string, params: any): Promise<any>;  // 内部 HTTP
}
```

启动参数：
```
./xiaohongshu-mcp --port=:0 --cdp-endpoint=<填占位,运行时 POST 注入>
```

`--port=:0` 让 Go 选择空闲端口，主进程从 stdout 解析。

#### `src/main/license.ts`
```ts
export interface LicenseState {
  status: 'unactivated' | 'active' | 'expired' | 'revoked' | 'mismatch';
  token?: SignedToken;
  machineId: string;
  validUntil?: Date;
}

export class LicenseManager {
  getMachineId(): string;  // 包装 node-machine-id, 加盐 + SHA-256
  loadLocal(): LicenseState;
  async activate(code: string): Promise<LicenseState>;
  async heartbeat(): Promise<LicenseState>;
  verifyToken(token: SignedToken, machineId: string): boolean;  // Ed25519
  clear(): void;  // 退出登录
}
```

加密存储：用 `safeStorage.encryptString` 把 token JSON 加密后存到 `userData/license.bin`。

#### `src/main/ipc.ts`
统一 ipcMain handler 注册：

```ts
ipcMain.handle('license:state', () => licenseMgr.loadLocal());
ipcMain.handle('license:activate', (_, code: string) => licenseMgr.activate(code));
ipcMain.handle('mcp:call', (_, tool: string, args: any) => goProc.callMCP(tool, args));
ipcMain.handle('mcp:listTools', () => goProc.callMCP('tools/list', {}));
ipcMain.handle('config:get', (_, key: string) => config.get(key));
ipcMain.handle('config:set', (_, key: string, value: any) => config.set(key, value));
ipcMain.handle('byok:test', (_, providerCfg) => testLLMConnection(providerCfg));
```

通过 `contextBridge.exposeInMainWorld('api', { ... })` 暴露给 renderer。

#### `src/main/updater.ts`
- 集成 `electron-updater`
- 配置 GitHub Releases 作为 update channel
- 自动更新检查间隔：24 小时
- 强制更新逻辑：服务端心跳响应里带 `min_version`，低于该版本拦截使用

## 3. Renderer 进程

### 3.1 路由结构

```
/activation       (无 token 时强制路由)
/onboarding       (首次激活成功后, BYOK 配置引导)
/                 (主界面: 浏览器 + 侧边栏)
/settings         (设置页)
/dashboard        (运营面板, P1)
```

### 3.2 模块清单

#### AI Sidebar 核心

```ts
// src/renderer/llm/provider.ts
export interface LLMProvider {
  id: 'volcengine' | 'deepseek' | 'custom';
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

export class LLMClient {
  constructor(provider: LLMProvider, tools: ToolSchema[]);
  async *chat(messages: Message[], options?: ChatOptions): AsyncIterable<ChatChunk>;
}
```

底层用 `openai` 包：

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: provider.baseURL,
  apiKey: provider.apiKey,
  dangerouslyAllowBrowser: true,  // Electron renderer 视为浏览器
});

const stream = await client.chat.completions.create({
  model: provider.model,
  messages,
  tools,
  stream: true,
  stream_options: { include_usage: true },
});
```

#### Tool Calling Loop

```ts
// src/renderer/llm/agent.ts
export async function runAgent(opts: {
  llm: LLMClient;
  userMessage: string;
  conversationId: string;
  onChunk: (chunk: ChatChunk) => void;
  onToolCall: (call: ToolCall) => Promise<ToolResult>;  // 含确认弹窗
  abortSignal?: AbortSignal;
}): Promise<void>;
```

伪代码（在 `agent.ts` 内）：

```ts
const messages = loadConversation(conversationId);
messages.push({ role: 'user', content: userMessage });

while (true) {
  const stream = llm.chat(messages);
  let assistant = { role: 'assistant', content: '', tool_calls: [] };
  for await (const chunk of stream) {
    accumulate(assistant, chunk);
    onChunk(chunk);
    if (abortSignal?.aborted) throw new AbortError();
  }
  messages.push(assistant);
  saveConversation(conversationId, messages);

  if (assistant.tool_calls.length === 0) break;

  for (const tc of assistant.tool_calls) {
    const result = await onToolCall(tc);  // 内部含敏感操作确认
    messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
  }
}
```

#### 敏感操作确认

```ts
// src/renderer/llm/sensitivity.ts
const SENSITIVE_TOOLS = new Set([
  'publish_content',
  'publish_with_video',
  'post_comment_to_feed',
  'reply_comment_in_feed',
  'like_feed',
  'favorite_feed',
]);

export function isSensitive(toolName: string): boolean {
  return SENSITIVE_TOOLS.has(toolName);
}
```

UI：用 React 的 `useImperativeHandle` + Portal 实现全局可调起的确认对话框。

#### Conversation 存储

SQLite schema：

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  pinned INTEGER DEFAULT 0
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT,
  role TEXT,             -- 'system' | 'user' | 'assistant' | 'tool'
  content TEXT,
  tool_calls TEXT,       -- JSON, 仅 role=assistant 时
  tool_call_id TEXT,     -- 仅 role=tool 时
  created_at INTEGER,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE INDEX idx_messages_conv ON messages(conversation_id, id);
```

文件路径：`app.getPath('userData')/conversations.db`。

#### BYOK 配置存储

加密存（不进 SQLite，避免误同步）：

```ts
// userData/byok.bin (encrypted via safeStorage)
{
  active_provider: 'volcengine' | 'deepseek' | 'custom',
  providers: {
    volcengine: { apiKey, model },
    deepseek:   { apiKey, model },
    custom:     { baseURL, apiKey, model }
  }
}
```

### 3.3 页面上下文感知

侧边栏需要"读取当前页面"作为 prompt 上下文。

实现：
1. Main 进程注册 `webContents.executeJavaScript()` IPC
2. Renderer 在 chat 触发时：
   ```ts
   const ctx = await api.page.getContext();
   // ctx = { url, title, mainText: <document.body.innerText 截前 4000 字符> }
   ```
3. 自动注入到 system message 末尾："当前页面：<title> (<url>)，内容摘要：..."

### 3.4 频率护栏

```ts
// src/renderer/rate-limit/guards.ts
export const GUARDS = {
  publish:   { max: 3,  windowMs: 86400_000, gapMs: 1800_000 },
  comment:   { max: 10, windowMs: 3600_000 },
  like:      { max: 30, windowMs: 3600_000 },
};

export function checkGuard(action: keyof typeof GUARDS): { allowed: boolean, warn?: string };
```

存计数到 SQLite `rate_log` 表，按时间窗口统计。超限时返回 `warn` 字符串，UI 弹二次确认（不硬拦截）。

## 4. xiaohongshu-mcp Go 端改造

### 4.1 新增 CLI 参数

```diff
// main.go
flag.BoolVar(&headless, "headless", true, "...")
flag.StringVar(&binPath, "bin", "", "...")
flag.StringVar(&port, "port", ":18060", "...")
+ flag.StringVar(&cdpEndpoint, "cdp-endpoint", "", "CDP WebSocket endpoint (attach mode)")
```

逻辑：
- 如果 `--cdp-endpoint` 非空：browser 模块用 attach 模式（不启 Chrome）
- 否则维持现有行为（向后兼容 Docker 部署）

### 4.2 `browser/browser.go` 新增 attach 模式

```go
type browserConfig struct {
    binPath     string
    cdpEndpoint string  // 新增
}

func WithCDPEndpoint(endpoint string) Option {
    return func(c *browserConfig) {
        c.cdpEndpoint = endpoint
    }
}

func NewBrowser(headless bool, options ...Option) *headless_browser.Browser {
    cfg := &browserConfig{}
    for _, opt := range options {
        opt(cfg)
    }

    // attach 模式优先
    if cfg.cdpEndpoint != "" {
        return headless_browser.NewWithCDP(cfg.cdpEndpoint)
    }
    // 维持原有自启 Chrome 逻辑
    ...
}
```

`headless_browser` 包（外部依赖）需要新增 `NewWithCDP`。如果上游不支持，包一层用 `rod.New().ControlURL(endpoint).MustConnect()` 自己实现。

### 4.3 端口选择

```diff
- flag.StringVar(&port, "port", ":18060", "端口")
+ flag.StringVar(&port, "port", ":0", "端口 (:0 = 随机)")
```

启动后向 stdout 打印实际绑定端口（Main 进程用于 IPC）：

```go
logrus.Infof("BIND_PORT=%d", actualPort)  // Main 进程 grep "BIND_PORT="
```

### 4.4 等待 CDP 注入

Go 服务启动后，**先不开浏览器**，等 Main 进程 POST `/internal/attach` 注入 CDP endpoint：

```go
// 新增内部接口
router.POST("/internal/attach", func(c *gin.Context) {
    var req struct{ CDPEndpoint string `json:"cdp_endpoint"` }
    c.BindJSON(&req)
    if err := xiaohongshuService.AttachCDP(req.CDPEndpoint); err != nil {
        c.JSON(500, gin.H{"error": err.Error()})
        return
    }
    c.JSON(200, gin.H{"ok": true})
})
```

`/internal/*` 路由仅绑定 127.0.0.1，不对外暴露（理论上整个 Go 服务都不对外，这是再加一层防护）。

### 4.5 Cookies 路径

```diff
// cookies/cookies.go
func GetCookiesFilePath() string {
-   path := os.Getenv("COOKIES_PATH")
-   if path == "" { path = "cookies.json" }
+   path := os.Getenv("XHS_USER_DATA_DIR")
+   if path == "" { return "cookies.json" }
+   return filepath.Join(path, "cookies.json")
}
```

Main 进程启动 Go subprocess 时通过环境变量传入：
```ts
spawn(goBinary, args, {
  env: { ...process.env, XHS_USER_DATA_DIR: app.getPath('userData') }
});
```

### 4.6 弃用 `cmd/login`

不再需要独立登录入口（用户直接在 Electron 浏览器窗口登录）。代码保留供 Docker 部署用户继续使用。

## 5. CDP 联调细节

### 5.1 启动顺序

```
T0: Main spawn Go subprocess (port=:0)
T1: Go 启动 HTTP server, stdout "BIND_PORT=37281"
T2: Main 读到 BIND_PORT, 标记 goProc.ready=true
T3: Main 创建 BrowserWindow with webPreferences.devTools=false (生产)
T4: Main 调用 webContents.debugger.attach('1.3')
T5: Main 调用 webContents.debugger.sendCommand('Target.getTargets') 或读取 webContents.getProcessId
    → 拿到 ws://127.0.0.1:<port>/devtools/browser/<id>
T6: Main POST http://127.0.0.1:37281/internal/attach { cdp_endpoint: ws://... }
T7: Go 用 rod.New().ControlURL(...).MustConnect()
T8: Go 通过返回的 *rod.Browser 拿到 page, 现在可以操作小红书
```

### 5.2 获取 CDP WebSocket URL 的方案

Electron 默认不开 `--remote-debugging-port`。两种方法启用：

**方案 A: 启动参数**（推荐）

```ts
app.commandLine.appendSwitch('remote-debugging-port', '0');  // 0 = 随机
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');

app.on('ready', async () => {
  // 等几百 ms 让 DevTools server 绑端口
  await sleep(500);
  const debuggerPort = await getActualDebuggerPort();  // 读 chrome 内部 API 或 lsof
  const json = await fetch(`http://127.0.0.1:${debuggerPort}/json/version`).then(r => r.json());
  const wsUrl = json.webSocketDebuggerUrl;
  // wsUrl = ws://127.0.0.1:<port>/devtools/browser/<uuid>
});
```

**方案 B: `webContents.debugger`** API

Electron 自带 API，无需开 remote-debugging-port，但只能操作单个 webContents，不能获取浏览器级 ws endpoint。**不适合**，go-rod 需要浏览器级 endpoint 才能管理多 page。

**结论：用方案 A。**

### 5.3 多 Page 隔离

go-rod attach 后可以看到所有 page。我们的应用窗口可能有多个 webContents（主窗口、设置窗口、登录窗口等），需要让 go-rod 只操作"小红书页面"。

策略：

```go
// go 端
browser := rod.New().ControlURL(cdpEndpoint).MustConnect()
pages, _ := browser.Pages()
for _, p := range pages {
    info, _ := p.Info()
    if strings.Contains(info.URL, "xiaohongshu.com") {
        return p  // 使用这个 page
    }
}
```

或者由 Main 显式传 targetId（更精确）：

```
Main: webContents.getProcessId() / mainFrame.routingId
   → 转 chrome targetId (需通过 CDP Target.getTargets)
   → 传给 Go
Go: browser.PageFromTargetID(targetId)
```

### 5.4 Stealth 注入

Main 进程在 BrowserWindow 创建后立即注入：

```ts
// src/main/stealth.ts
export async function applyStealth(wc: WebContents) {
  await wc.executeJavaScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  `);
  await wc.setUserAgent(getStandardChromeUA());
}
```

需要在每个新 webContents 创建时调用：

```ts
app.on('web-contents-created', (_, wc) => applyStealth(wc));
```

## 6. License Worker (Cloudflare)

### 6.1 项目结构

```
license-worker/
├── src/
│   ├── index.ts        # Router
│   ├── handlers/
│   │   ├── activate.ts
│   │   ├── heartbeat.ts
│   │   └── admin.ts
│   ├── crypto.ts       # Ed25519 sign / verify
│   └── kv.ts           # KV 封装
├── wrangler.toml
└── package.json
```

### 6.2 接口契约

```ts
// POST /activate
interface ActivateRequest {
  code: string;        // "XHS-XXXX-XXXX-XXXX-XXXX"
  machine_id: string;  // 客户端生成的指纹哈希
}
interface ActivateResponse {
  ok: true;
  token: string;       // base64 编码的 SignedToken
  valid_until: string; // ISO timestamp
  status: 'active' | 'suspended';     // v0.6 D6: 通常 active, 也可能 suspended (Maxwell 之前停过, 客户刚续费但还没 resume)
  llm: {                              // v0.6 D6: 中转 LLM 配置, 客户端写 license.json
    base_url: string;
    api_key: string;
    model: string;                    // 写死 'auto-llm'
  } | null;                           // null = newapi 后端调用失败, 客户端 dialog 提示
}
interface ActivateError {
  ok: false;
  code: 'CODE_NOT_FOUND' | 'CODE_REVOKED' | 'CODE_SUSPENDED' | 'CODE_BOUND_OTHER' | 'CODE_EXPIRED' | 'INTERNAL';
  message: string;
}
// 注: /activate 入口检查 KV status:
//   - status='unused' → 正常绑机激活, 返回 active
//   - status='active' + machine_id 匹配 → 重激活同机 OK
//   - status='active' + 不匹配 → CODE_BOUND_OTHER (走 /admin/rebind)
//   - status='suspended' → CODE_SUSPENDED (拒绝重激活, 防止清重装绕过 suspend)
//   - status='revoked' → CODE_REVOKED

// POST /heartbeat
interface HeartbeatRequest {
  token: string;
}
interface HeartbeatResponse {
  ok: true;
  latest_version: string;       // 最新软件版本
  min_version: string;          // 最低支持版本 (< min 拦截使用)
  revoked: boolean;             // 当前 code 是否被吊销 (兼容 v0.3 字段, 等价 status==='revoked')
  status: 'active' | 'suspended' | 'revoked';   // v0.6 D6 新增, 客户端 license.ts diff 触发 push
  suspend_reason: string | null;                 // v0.6 D6 新增, 仅运营内部用, 客户端不显示给用户 (banner 用固定文案)
  llm: {                                         // v0.6 D6 新增, 允许 base_url / api_key 变更后客户端 catch
    base_url: string;
    api_key: string;
    model: string;
  } | null;
  new_token?: string;           // 如果剩余有效期 < 60 天, 下发新 token
  new_valid_until?: string;
}

// POST /admin/codes  (Bearer ADMIN_TOKEN)
interface IssueCodesRequest {
  quantity: number;
  notes?: string;          // "买家张三 / 微信 ¥299 / 2026-05-15"
  expire_at?: string;      // ISO, 不传 = 永不过期
}
interface IssueCodesResponse {
  codes: string[];
}

// POST /admin/revoke  (Bearer ADMIN_TOKEN)
interface RevokeRequest {
  code: string;
  reason?: string;
}

// POST /admin/rebind  (Bearer ADMIN_TOKEN)
interface RebindRequest {
  code: string;
  new_machine_id: string;
}
// 注: suspended / revoked 状态拒绝 rebind, 返回 INVALID_STATE

// POST /admin/suspend  (Bearer ADMIN_TOKEN, v0.6 D6)
interface SuspendRequest {
  code: string;
  reason?: string;          // 仅运营内部用 (e.g. "未续 5 月 LLM 月费"), 不暴露给客户
}
interface SuspendError {
  ok: false;
  code: 'INVALID_STATE';
  current: 'unused' | 'suspended' | 'revoked';   // 当前实际 status, 帮 Maxwell 判断
  hint: string;             // e.g. "已是 suspended 状态" / "已 revoked 不可重 suspend"
}

// POST /admin/resume  (Bearer ADMIN_TOKEN, v0.6 D6)
interface ResumeRequest {
  code: string;
}
// 错误同 SuspendError, current 表示当前状态
// 注: resume 仅 enable newapi token, **不补 quota** — suspend 期已用部分不返还。
//     如需补 quota Maxwell 在 newapi UI 手动加; 或调用 newapi `POST /api/subscription/admin/users/:id/subscriptions` 重新绑 plan 触发 reset。
```

### 6.3 SignedToken 结构

```ts
interface SignedTokenPayload {
  code: string;
  machine_id: string;
  issued_at: number;     // unix ts
  valid_until: number;   // unix ts (issued_at + 365 days)
}

// 序列化:
//   base64( JSON(payload) ) + '.' + base64( ed25519_sign(JSON(payload), PRIVATE_KEY) )
// 客户端用打包的 PUBLIC_KEY 验签
```

### 6.4 KV Schema

```
key:                       value (JSON):
─────────────────────      ─────────────────────────────────────
code:XHS-A1B2-C3D4-...     {
                             status: 'unused' | 'active' | 'suspended' | 'revoked',
                             bound_machine_id: string | null,
                             bound_at: number | null,
                             expire_at: number | null,
                             rebind_count: number,
                             notes: string,
                             revoked_reason: string | null,
                             // v0.6 D6 新增 (LLM 中转资源关联)
                             newapi_user_id: number | null,
                             newapi_sub_id: number | null,
                             newapi_token_id: number | null,
                             api_key_encrypted: string | null,
                             // v0.6 D6 新增 (suspend/resume)
                             suspended_at: ISO timestamp | null,
                             suspend_reason: string | null,
                             resumed_at: ISO timestamp | null,
                             revoked_at: ISO timestamp | null
                           }

config:min_version         "0.5.0"
config:latest_version      "1.2.3"
```

### 6.5 安全

- `ADMIN_TOKEN`: 在 `wrangler secret put ADMIN_TOKEN` 配置，不在代码
- Ed25519 私钥: 同上，`wrangler secret put SIGNING_PRIVATE_KEY`（base64 编码）
- 客户端打包的公钥: 写在 native addon (C++ N-API) 或至少混淆过的 JS 常量
- Rate limit: 单 IP `/activate` 10 次/分钟（防爆破）；`/admin/*` 50 次/分钟

### 6.6 部署

```
npm install -g wrangler
wrangler login
wrangler kv:namespace create LICENSES
wrangler secret put ADMIN_TOKEN
wrangler secret put SIGNING_PRIVATE_KEY
wrangler deploy
```

最终域名：`xhs-license.<your-cf-account>.workers.dev`

## 7. 数据模型汇总

### 7.1 客户端 SQLite (`userData/app.db`)

```sql
-- 对话历史
CREATE TABLE conversations (id, title, created_at, updated_at, pinned);
CREATE TABLE messages (id, conversation_id, role, content, tool_calls, tool_call_id, created_at);

-- 频率限制
CREATE TABLE rate_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT,              -- 'publish' | 'comment' | 'like' | 'favorite'
  created_at INTEGER
);

-- 草稿 (P1)
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  type TEXT,                -- 'image' | 'video'
  title TEXT,
  content TEXT,
  tags TEXT,                -- JSON array
  media_paths TEXT,         -- JSON array
  scheduled_at INTEGER,     -- null = 未排程
  status TEXT,              -- 'draft' | 'scheduled' | 'published' | 'failed'
  created_at INTEGER,
  updated_at INTEGER
);
```

### 7.2 客户端文件存储 (`userData/`)

| 文件 | 内容 | 加密 |
|---|---|---|
| `app.db` | SQLite 数据库 | 否 |
| `license.bin` | 激活 token + 元数据 | safeStorage |
| `byok.bin` | BYOK API keys + 配置 | safeStorage |
| `config.json` | 用户偏好（主题、快捷键等） | 否 |
| `cookies.json` | 小红书 cookies（Go 写入） | 否 |
| `logs/main.log` | 主进程日志 | 否 |
| `logs/go.log` | Go subprocess 日志 | 否 |

### 7.3 Worker KV

见 §6.4。

## 8. 安全规范

| 项 | 规范 |
|---|---|
| API key 不入日志 | 所有日志 redact `sk-***` / `Bearer ***` 模式 |
| Token 验签 | 每次启动 + 每次 IPC mcp:call 前 |
| Renderer 隔离 | `contextIsolation: true`, `nodeIntegration: false` |
| HTTPS only | LLM provider baseURL 校验必须 `https://` |
| Go 服务对外不暴露 | 监听 `127.0.0.1`，不监听 `0.0.0.0` |
| 用户协议必同意 | 首次启动强制弹出 |
| asar 加密 | electron-builder `asar: { smartUnpack: false, asarUnpack: ['xiaohongshu-mcp'] }` + 自定义加密 |
| 公钥保护 | 写入 native addon，避免明文 JS |

## 9. 错误码规范

错误码格式：`<DOMAIN>_<SPECIFIC>`，全大写下划线分隔。

### 9.1 License

> ⚠️ **命名约定**: **Worker 端响应 `code` 字段不带 `LICENSE_` 前缀** (例如 `CODE_NOT_FOUND` 而非 `LICENSE_CODE_NOT_FOUND`, 见 §6.2 接口契约). 下表中带 `LICENSE_` 前缀的是**客户端展示 i18n key**, Worker 错误转 i18n 时由客户端补上前缀:
> ```
>   Worker code            i18n key (客户端补前缀)
>   CODE_NOT_FOUND     →   LICENSE_CODE_NOT_FOUND
>   CODE_REVOKED       →   LICENSE_CODE_REVOKED
>   CODE_BOUND_OTHER   →   LICENSE_CODE_BOUND_OTHER
>   CODE_EXPIRED       →   LICENSE_TOKEN_EXPIRED
> ```

| 码 (i18n key) | 含义 | 用户文案 |
|---|---|---|
| `LICENSE_NOT_ACTIVATED` | 无 token (客户端独有) | 请输入激活码 |
| `LICENSE_INVALID_CODE` | 激活码格式错误 (客户端独有) | 激活码格式错误 |
| `LICENSE_CODE_NOT_FOUND` | Worker 返 `CODE_NOT_FOUND` | 激活码无效 |
| `LICENSE_CODE_REVOKED` | Worker 返 `CODE_REVOKED` | 此激活码已停用，请联系客服 |
| `LICENSE_CODE_BOUND_OTHER` | Worker 返 `CODE_BOUND_OTHER` | 此激活码已绑定其他设备，请联系客服换绑 |
| `LICENSE_TOKEN_EXPIRED` | Worker 返 `CODE_EXPIRED` 或本地校验过期 | 需要重新激活（系统会自动尝试） |
| `LICENSE_MACHINE_MISMATCH` | 本地 token 与机器不匹配 (客户端独有) | 设备指纹变更，请联系客服 |
| `LICENSE_NETWORK_ERROR` | 网络问题 (客户端独有) | 网络异常，请检查后重试 |

### 9.2 MCP

| 码 | 含义 |
|---|---|
| `MCP_NOT_READY` | Go subprocess 未就绪 |
| `MCP_NOT_LOGGED_IN` | 小红书未登录 |
| `MCP_TOOL_NOT_FOUND` | 工具名不存在 |
| `MCP_INVALID_PARAMS` | 工具参数校验失败 |
| `MCP_EXECUTION_FAILED` | 工具执行失败（含小红书侧错误） |
| `MCP_RATE_LIMITED` | 触发频率护栏 |

### 9.3 LLM

| 码 | 含义 |
|---|---|
| `LLM_NOT_CONFIGURED` | BYOK 未配置 |
| `LLM_AUTH_FAILED` | API key 无效（401） |
| `LLM_QUOTA_EXCEEDED` | provider 余额不足（402） |
| `LLM_RATE_LIMITED` | provider 限流（429） |
| `LLM_NETWORK_ERROR` | 网络错误 |
| `LLM_INVALID_RESPONSE` | 响应解析失败 |

### 9.4 错误响应格式

所有 IPC handler 抛错时统一格式：

```ts
{ code: 'LICENSE_CODE_REVOKED', message: '此激活码已停用，请联系客服', detail?: any }
```

Renderer 统一捕获、统一展示。

## 10. 日志规范

- 工具：`electron-log`
- 文件位置：`userData/logs/main.log` / `userData/logs/renderer.log` / `userData/logs/go.log`
- 单文件 ≤ 10MB，保留 5 份
- 级别：dev = debug，prod = info
- 敏感字段 redact 列表：`api_key`, `apiKey`, `token`, `password`, `cookies`

## 11. 测试策略（轻量）

| 层级 | 范围 | 工具 |
|---|---|---|
| 单元测试 | License 加解密、频率护栏、token 验签 | Vitest |
| 集成测试 | Go subprocess + IPC + License Worker mock | Playwright + Vitest |
| 手动验收 | 14 个工具 (12 Go + 2 local) + 激活流程 + 跨平台打包 | checklist |

不做覆盖率指标，关注关键路径不回归即可。

## 12. v0.2 ~ v0.3 增量模块（已上线）

> 对应 git tag `v0.2.0` ~ `v0.3.0`。原 §2-§9 仍有效, 这里只列**新增 / 修改**部分。

### 12.1 Renderer 重构: 控制台 4-tab 架构

```
App.tsx
├── tabbar [控制台 / 小红书 / 素材库 / 帮助]
├── ConsolePane.tsx  (控制台容器, hoist state)
│   ├── CommandPalette.tsx       (左上 · 5 常用命令: 预填 prompt)
│   ├── ConversationList.tsx     (左下 · 会话列表 + 新建/重命名/删除)
│   └── ChatPanel.tsx            (右 · 消息流 + 输入框 + 📎 附件)
│       ├── AttachmentPicker.tsx (modal 多选素材)
│       ├── ConfirmDialog.tsx
│       └── 内嵌 ToolCallItem    (默认折叠 / 错误自动展开)
├── AssetLibrary.tsx (素材库 tab)
├── HelpPanel.tsx     (帮助 tab)
└── <webview src="xiaohongshu.com" partition="persist:xhs"> (小红书 tab)
```

**控制台布局**:`grid-template-columns: 25% 1fr` (左 25% 命令+会话 / 右 75% 聊天)

**会话 state machine**:
- ConsolePane 持有 `convId / conversations[]` (SQLite 来源)
- ChatPanel.useEffect([convId]) 监听切换,加载该对话历史
- `chatRef.setDraft(text)` 暴露给 CommandPalette,把命令文案塞入输入框 + `___` 占位光标定位

### 12.2 智能素材库 (main + renderer)

**main/assets.ts**:
```ts
pickAndImport()              // dialog 选图 → nativeImage.toJPEG(75) 压缩 (不缩尺寸) + 重命名 picture-YYYYMMDD-HHmmss-N.jpg + DB insert
importFromUrl(url)           // net.fetch 下载 → 同 pipeline
listAssets() → MediaAsset[]
getAssetPath(id) → string
touchUsed(ids[])             // 更新 last_used_at
deleteAsset(id)              // 删文件 + DB
setAssetTags(id, tags[], description)  // analyzed=1
searchAssets(query, limit=10) → MediaAsset[]  // LIKE on tags/description/filename
```

**DB schema** (新增列, ALTER 升级):
```sql
ALTER TABLE media_assets ADD COLUMN tags TEXT DEFAULT '[]';
ALTER TABLE media_assets ADD COLUMN description TEXT;
ALTER TABLE media_assets ADD COLUMN analyzed INTEGER DEFAULT 0;
```

**renderer/ai/assetAnalyzer.ts**:
```ts
analyzeImage(cfg: BYOKConfig, imageDataUrl: string) → { tags: string[]; description: string }
// LLM vision call, prompt 要求严格 JSON 返回, fallback 解析失败时退化 description=raw
```

**IPC**:
- `assets:pick` / `assets:importUrl(url)` / `assets:list` / `assets:delete(id)` / `assets:getPath(id)` / `assets:touchUsed(ids[])` / `assets:setTags(id, tags, description)` / `assets:search(query, limit)`

### 12.3 新 MCP 工具 (本地处理, `http: null`)

**`search_local_assets(query, limit)`**:
- ChatPanel.callTool special-case → `window.api.assets.search()`
- 返 `[{ id, filename, tags, description, path, analyzed }]`,AI 拿 path 塞 publish_content.images

**`web_search(query, n)`** (v0.3.0):
- ChatPanel.callTool special-case → `window.api.web.search()`
- main/web-search.ts 用 hidden BrowserWindow + executeJavaScript 抓搜狗 div.vrwrap
- 串行化 mutex 防并发开多窗,15s timeout,失败结构化兜底
- 真 Chrome UA 覆盖 Electron 默认 UA

### 12.4 自定义协议 `xhs-asset://`

**main/index.ts**:
```ts
protocol.registerSchemesAsPrivileged([
  { scheme: 'xhs-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

protocol.handle('xhs-asset', async (req) => {
  const id = new URL(req.url).hostname;
  const path = getAssetPath(id);
  if (!path) return new Response('not found', { status: 404 });
  return net.fetch(pathToFileURL(path).toString());
});
```

renderer 用 `<img src="xhs-asset://{id}">` 加载本地图片,绕过 `file://` 在 http://localhost 上的 mixed-content / CORS 限制。

### 12.5 license.ts 简化 (去 safeStorage)

**之前** (v0.2.6 及前): `safeStorage.encryptString(json)` → macOS Keychain 加密。首启弹「访问钥匙串机密内容」密码框,体验差。

**v0.2.7+**:
```ts
function saveStored(data) {
  writeFileSync(licensePath(), Buffer.from(JSON.stringify(data)).toString('base64'), 'utf8');
}
function loadStored() {
  return JSON.parse(Buffer.from(readFileSync(licensePath()), 'base64').toString('utf8'));
}
```

老 Keychain 数据无法解 (decoding fails) → 当未激活处理,用户重新输激活码即可。**安全保障由服务端 verify machine_id 提供** (拷文件到别机器也激活不了)。

### 12.6 macOS 打包流水线 (无证书 + 首启零命令)

**ad-hoc codesign** (`app/scripts/ad-hoc-sign.cjs`):
```js
// electron-builder afterPack hook
execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath]);
```
解决 macOS Tahoe 对 unsigned binary 报「已损坏」(主 binary 签上,但 quarantine 仍要解)。

**dmg 内嵌 `首次安装.command`** (`app/dmg-resources/install-mac.command`):
- shell 脚本: `xattr -cr /Applications/小红书自运营.app` 移除 quarantine
- 弹原生 dialog 确认 + 自动启动应用

**package.json dmg.contents**:
```json
"dmg": {
  "contents": [
    { "x": 130, "y": 200, "type": "file" },
    { "x": 410, "y": 200, "type": "link", "path": "/Applications" },
    { "x": 270, "y": 360, "type": "file", "path": "dmg-resources/install-mac.command", "name": "首次安装.command" }
  ]
}
```

> ⚠️ 注意: 脚本必须放在**非 `build/`** 目录, `.gitignore` 排除 `build/` 整目录, 否则脚本不进 git, build 找不到文件挂掉。

### 12.7 构建 workflow 仅手动触发 (v0.3.0+)

私仓 GH Actions macOS runner 倍率 10x, free tier 容易耗。yml 改:
```yaml
on:
  workflow_dispatch:    # 删 push: tags: 'v*'
```

发版流程:
```bash
git tag v0.x.y -a -m "..."
git push origin v0.x.y         # 仅留 tag 标记, 不 trigger build
gh workflow run "Build macOS" --ref main --repo iyuenan3/xiaohongshu-tool
gh workflow run "Build Windows" --ref main --repo iyuenan3/xiaohongshu-tool
```

### 12.8 网页管理后台 (Worker /admin)

**worker/src/admin-ui.ts**: 一个 HTML 文件 export 字符串, GET /admin 返回。

- 同源调 admin API (POST /admin/codes / POST /admin/revoke / POST /admin/rebind / **GET /admin/codes** v0.2.2 新增)
- ADMIN_TOKEN 通过 localStorage 缓存, 首次 prompt 输入
- 两个 tab: 发码 (数量/过期/备注) / 列表 (status filter + machine_id 子串 + 行内 [吊销] [换绑])

**`handleAdminList(req, env)`** (worker/src/handlers/admin.ts):
```ts
const list = await env.LICENSES.list({ prefix: 'code:', limit });
for (k of list.keys) {
  const rec = JSON.parse(await env.LICENSES.get(k.name));
  if (statusFilter && rec.status !== statusFilter) continue;
  if (search && !rec.bound_machine_id?.includes(search)) continue;
  codes.push({ ...rec, code: k.name.slice(5) });
}
```

### 12.9 工具集变化

14 个 MCP 工具 (12 个走 Go + 2 个 renderer 本地):
1. check_login_status / list_feeds / search_feeds / get_feed_detail
2. user_profile / my_profile
3. post_comment_to_feed / reply_comment_in_feed / like_feed / favorite_feed
4. publish_content / publish_with_video
5. **search_local_assets** (renderer 本地) ← v0.2.2
6. **web_search** (renderer 本地) ← v0.3.0

**system prompt** 加工具选择提示:
- 查近期事件/创作素材 → 优先 web_search
- 发图文笔记没明确图 → search_local_assets
- 浏览/操作小红书 → list_feeds / search_feeds / ...

### 12.10 D6 LLM Gateway 中转架构（v0.6 / 2026-05-19）

> ⚠️ **2026-05-22 D9 拍板：本节「方案 X · 一码一 user + 绑 XHS Plan」已被 [§12.11 B' token-only](#1211-d9--b-token-only-架构v08--2026-05-22取代-1210-方案-x) 取代。** 下方 §12.10.1~.13 保留作方案 X 历史 / 翻盘参考；**当前实现以 §12.11 为准**。

#### 12.10.1 总览

跟 PRD §6.7 配套。自营 newapi 网关 + Worker 中转激活码 ↔ newapi 资源映射, 客户端零配置 + dev 模式 BYOK 逃生口。

```
[Maxwell admin] ──POST /admin/codes──► [Worker]
                                          │
                                          ├─► newapi POST /api/user/ (username=xhs-<激活码末两段小写>, e.g. xhs-wx2a-bcdf, 13 字符)
                                          ├─► newapi POST /api/subscription/admin/users/:id/subscriptions (bind XHS Plan)
                                          ├─► newapi POST /api/token/ (model_limits=auto-llm)
                                          └─► KV 存 code:CODE → { user_id, sub_id, token_id, api_key }
                                                  │  (任一步失败 → 反向回滚)
                                                  ▼
[客户] ──输激活码──► [Worker /activate] ──返回 { license, llm: {base_url, api_key, model} }──► [客户端 license.json]
                                                                                                    │
                                                                                                    ▼
                                                                                          [Renderer agent.ts]
                                                                                                    │
                                  cert 放行: main certificate-error 对 139.196.157.57 (动态)        │
                                                                                                    │
                                                       https://139.196.157.57/v1 (Caddy 自签 sni-fallback)
                                                                  │
                                                                  ▼
                                                  [newapi alicloud-sh] (Caddy 反代)
                                                  - 域名 llm.maxwellii.com 走 LE 合法证书 (Worker 跨境用)
                                                  - subscription 配额扣减, 月初自动 reset (newapi 原生)
                                                                  │
                                                                  ▼
                                       火山方舟 Auto 调度 → doubao / Kimi / GLM / DeepSeek / MiniMax
```

#### 12.10.2 newapi 资源 schema

**一次性 setup (Maxwell 在 newapi UI 操作)**:

```yaml
# 新建 group "xhs"
group:
  name: xhs
  description: 小红书自运营系统客户专用组
  ratio: 1.0    # 跟 default group 同 ratio, 后续按需调整
  channels: [auto-llm 关联渠道]   # 火山方舟 Pro Coding Plan

# 新建 Plan "XHS Plan"
plan:
  title: "XHS Plan"
  subtitle: "小红书自运营 月费套餐"
  total_amount: <Maxwell 运营时配>   # 算法 ¥N / 7.3 × 500000 (USD raw, newapi 内部单位), 具体值不写文档
  quota_reset_period: monthly
  upgrade_group: xhs           # 绑后自动升 xhs 组
  duration_unit: month
  duration_value: 1
  price_amount: 0              # 不卖, Worker 后台 admin 绑
  max_purchase_per_user: 1
  enabled: true
```

**每激活码三件套 (Worker 发码时同步创建)**:

⚠️ newapi User 字段约束 (model/user.go validator): `username max=20`, `password 8-20`, `display_name max=20`。激活码 23 字符不能直接用作 username。

⚠️ **安全 trade-off**: username 用激活码末两段 (含中间 dash, 小写, 9 字符 + `xhs-` 前缀 = 13 字符), Maxwell UI 搜索方便但**暴露后 8 位明文**。攻击者拿到 user list 知道后 8 位, 破解前 8 字符 `32^8 = 1.1T` 次 (单机 ~18 min)。当前阶段 (年 100-300 客户) 抗暴力够用, 主要靠 Maxwell `/admin/rebind` 验证支付凭证兜底防社工。**未来用户量起来可升级为 sha256 hash 方案**。

```yaml
# 1. user
POST /api/user/
body: {
  username: `xhs-${code.slice(-9).toLowerCase()}`,
                              # 激活码末 9 字符 (末两段含中间 dash) 转小写
                              # e.g. 激活码 "XHS-3KH8-7QM4-WX2A-BCDF" → 末 9 = "WX2A-BCDF" → "xhs-wx2a-bcdf" (13 字符 ≤ 20)
  password: crypto.randomUUID().replace(/-/g,'').slice(0, 20),   # hex 前 20 字符占位, 客户不登录 newapi UI
  display_name: `XHS-${code.slice(-4)}`,    # e.g. "XHS-BCDF" (8 字符 ≤ 20, UI 一眼对应 username 末 4 位)
}
→ returns { id: <userId>, ... }
# 注: newapi POST /api/user/ 字段只接受 username/password/display_name/role, 不接受 email/phone
# 注: 不能传 group (用 DB default "default", 绑 Plan 后 newapi 自动升 xhs)
# 注: collision 处理 — username 有 DB UNIQUE 索引, 末 9 字符空间 32^8 = 1.1T, 撞概率极低,
#     但 Worker createUser catch UNIQUE 错误 → 重新 generateCode + 重试 (反正激活码也要 KV 唯一)
# 注: **`xhs-` 前缀是多租户隔离边界 — 该 newapi 实例还服务其他应用, 详见 §12.10.13 多租户隔离原则**

# 2. subscription (bind plan)
POST /api/subscription/admin/users/<userId>/subscriptions
body: { plan_id: XHS_PLAN_ID }
→ returns { id: <subId>, next_reset_time, amount_total, amount_used, ... }

# 3. token (在 user_id=<userId> 下创建)
POST /api/token/
headers: { New-Api-User: <userId> }   # 关键: 切 user_id
body: {
  name: <同 username>,            # `xhs-${code 末 8 字符小写}` (newapi token.name 无 max 限制, 但跟 username 一致便于 UI 双向搜)
  remain_quota: 0,                # 无所谓, 用 subscription 配额
  unlimited_quota: true,          # token 自身不限, 走 subscription 扣减
  model_limits_enabled: true,
  model_limits: "auto-llm",       # 锁死, 客户拿 key 也只能调 auto-llm
  expired_time: -1,               # 永久
  group: xhs
}
→ returns { id: <tokenId>, key: "sk-xxx" }
```

#### 12.10.3 Worker 端点改动

**`POST /admin/codes`**: 同步建 newapi 资源, 强一致回滚

```typescript
async function generateCode(env: Env, count: number, notes: string) {
  const results = [];
  for (let i = 0; i < count; i++) {
    const code = generateCodeString();   // XHS-XXXX-XXXX-XXXX-XXXX
    const sig = signCode(code, env.SIGNING_PRIVATE_KEY);
    
    let userId = null, subId = null, tokenId = null, apiKey = null;
    try {
      // 1. create newapi user (字段约束 max 20; username 用激活码末两段含中间 dash 小写, 见 §12.10.2 trade-off)
      const username = `xhs-${code.slice(-9).toLowerCase()}`;             // "xhs-wx2a-bcdf" 13 字符
      const userResp = await newapi.createUser(env, {
        username,
        password: crypto.randomUUID().replace(/-/g, '').slice(0, 20),    // 占位 (客户不登录 UI)
        display_name: `XHS-${code.slice(-4)}`,                            // "XHS-BCDF" 8 字符
      });
      // collision 处理 (DB UNIQUE 撞 username): catch newapi 错误, throw 给上层 retry generateCode
      userId = userResp.data.id;
      
      // 2. bind XHS Plan
      const subResp = await newapi.bindSubscription(env, userId, env.XHS_PLAN_ID);
      subId = subResp.data.id;
      
      // 3. create token (name 跟 username 同名, 便于 UI 搜)
      const tokenResp = await newapi.createToken(env, userId, {
        name: username,
        unlimited_quota: true,
        model_limits_enabled: true,
        model_limits: "auto-llm",
        expired_time: -1,
        group: "xhs",
      });
      tokenId = tokenResp.data.id;
      apiKey = tokenResp.data.key;
      
      // 4. KV
      await env.KV.put(`code:${code}`, JSON.stringify({
        sig,
        status: "unused",
        bound_machine_id: null,
        notes,
        created_at: new Date().toISOString(),
        newapi_user_id: userId,
        newapi_sub_id: subId,
        newapi_token_id: tokenId,
        api_key_encrypted: await encryptKey(apiKey, env.SIGNING_PRIVATE_KEY),
      }));
      results.push({ code });
    } catch (err) {
      // 反向回滚已建资源
      if (tokenId) await newapi.deleteToken(env, tokenId).catch(() => {});
      if (subId) await newapi.invalidateSubscription(env, userId, subId).catch(() => {});
      if (userId) await newapi.deleteUser(env, userId).catch(() => {});
      throw err;
    }
  }
  return { codes: results };
}
```

**`POST /activate`**: 响应加 `llm` + `status` 字段, 入口加 status 过滤

```typescript
async function handleActivate(req: Request, env: Env) {
  const { code, machine_id } = await req.json();
  const data = JSON.parse(await env.KV.get(`code:${code}`) || "null");
  if (!data) return error('CODE_NOT_FOUND');
  
  // 关键: 状态过滤防止清重装绕过 suspend
  if (data.status === 'revoked') return error('CODE_REVOKED');
  if (data.status === 'suspended') return error('CODE_SUSPENDED');     // v0.6 D6 新增, 不允许 suspend 状态码再激活
  if (data.status === 'active') {
    if (data.bound_machine_id !== machine_id) return error('CODE_BOUND_OTHER');
    // 已绑同机, 走重激活路径 (覆盖 token, 不动 newapi)
  }
  
  // unused: 首次激活, 绑机
  if (data.status === 'unused') {
    data.bound_machine_id = machine_id;
    data.bound_at = new Date().toISOString();
    data.status = 'active';
    await env.KV.put(`code:${code}`, JSON.stringify(data));
  }
  
  return Response.json({
    ok: true,
    token: signToken(...),
    valid_until: ...,
    status: 'active',
    llm: {
      base_url: env.XHS_LLM_BASE_URL,
      api_key: await decryptKey(data.api_key_encrypted, env.SIGNING_PRIVATE_KEY),
      model: 'auto-llm',
    },
  });
}
```

base_url 来自 `env.XHS_LLM_BASE_URL` (Worker secret, 默认 `https://139.196.157.57/v1` 带 `/v1` 后缀以匹配 OpenAI SDK 习惯)。

⚠️ **Maxwell 改 IP 后必须 redeploy worker**: `wrangler secret put XHS_LLM_BASE_URL` 改值后调 `wrangler deploy` 让新 secret 生效 (Worker secret **不 hot-reload**, isolate 启动时绑定一次)。redeploy 完成后, 客户端下次 heartbeat (**24h 周期**, `HEARTBEAT_INTERVAL_MS` 常量) 拿到新 base_url + license.ts diff 触发 push + renderer 更新 + main certificate-error allowedHosts 同步更新。

**`POST /heartbeat`**: 响应带 `status` + `suspend_reason` + `llm` 字段, 允许 base_url + status 动态更新

```typescript
return Response.json({
  ok: true,
  status: data.status,                    // 'active' | 'suspended' | 'revoked'
  suspend_reason: data.suspend_reason,    // 仅运营内部, 客户端不展示给用户
  revoked: data.status === 'revoked',     // 兼容 v0.3 字段
  llm: data.status === 'active' ? {       // suspended/revoked 时 token 已 disable, llm 字段可仍下发 (客户端拿到也调不通)
    base_url: env.XHS_LLM_BASE_URL,
    api_key: await decryptKey(...),
    model: 'auto-llm',
  } : null,
  latest_version: ...,
  min_version: ...,
});
```

客户端 license.ts 处理逻辑:
1. 拿 `status` 跟本地 license.status diff, 不一致 → 更新 license.json + push renderer (status 变化 → ChatPanel 状态机重算)
2. 拿 `llm.base_url / api_key` 跟本地 diff, 不一致 → 更新 license.json + push renderer + main allowedHosts 重算
3. **suspend 实际感知靠两条路径取早**:
   - 主路径 (即时): agent.ts 调 LLM 时 newapi token 已 disable → 401/403 → catch → refreshLicense → 锁 chat
   - 兜底路径 (最多 24h): 下次 heartbeat 同步 status → 锁 chat
4. **离线 + 不调 LLM**: license.status 不变, 但用户也无法使用 AI 功能, 业务无损

**`POST /admin/suspend`** (新增, v0.6 D6): 软停 — 客户未续 LLM 月费时 Maxwell 手动调用, **token 仍存在但 disabled**, license 进 `suspended` 状态。客户续费后调 `/admin/resume` 即可即时恢复。

**15 天硬停 enforce** (人工 + UI 辅助, 不自动 cron):
- KV 存 `suspended_at`, admin UI (`worker/src/admin-ui.ts`) 在列表中显示**距离 15 天的剩余天数** (`suspended_at + 15d - now`), ≤ 3 天用红色高亮提醒
- admin UI 加"超期清单" tab (`GET /admin/overdue` 端点, 返回所有 `suspended_at + 15d < now` 的码), Maxwell 周末检查时一目了然
- **不加 Worker scheduled cron 自动 revoke**: revoke 是终态不可逆, 应该由人决策 (避免月末客户已转账但 cron 已 revoke 的尴尬)


```typescript
async function handleSuspend(req: Request, env: Env) {
  // Bearer ADMIN_TOKEN 鉴权
  const { code, reason } = await req.json();
  const data = JSON.parse(await env.KV.get(`code:${code}`));
  // 多租户隔离护栏 (§12.10.13)
  await assertXhsTenant(env, data.newapi_user_id);
  if (data.status !== "active") {
    const hint = {
      unused: "激活码尚未被激活, 不能 suspend",
      suspended: "激活码已是 suspended 状态",
      revoked: "激活码已 revoked, 不可再 suspend (revoke 不可逆)",
    }[data.status] ?? "未知状态";
    return Response.json({
      ok: false,
      code: "INVALID_STATE",
      current: data.status,
      hint,
    }, { status: 400 });
  }
  await newapi.updateTokenStatus(env, data.newapi_token_id, 2);  // 2=disabled
  await env.KV.put(`code:${code}`, JSON.stringify({
    ...data,
    status: "suspended",
    suspended_at: new Date().toISOString(),
    suspend_reason: reason || "未续 LLM 月费",  // 注: 仅运营内部用, 客户端 banner 不透传, 避免敏感词泄露
  }));
  return Response.json({ ok: true });
}
```

**`POST /admin/resume`** (新增, v0.6 D6): 恢复 — Maxwell 收到客户续费后调用, token 重新 enable, license 回 `active`。**resume 不补 quota** (suspend 期用了一半的不返还), 如需补加 Maxwell 在 newapi UI 手动操作。

```typescript
async function handleResume(req: Request, env: Env) {
  const { code } = await req.json();
  const data = JSON.parse(await env.KV.get(`code:${code}`));
  await assertXhsTenant(env, data.newapi_user_id);   // 多租户隔离 (§12.10.13)
  if (data.status !== "suspended") {
    const hint = {
      unused: "激活码尚未激活, 不能 resume",
      active: "激活码已是 active 状态, 无需 resume",
      revoked: "激活码已 revoked, 不可 resume (revoke 不可逆, 需重发新码)",
    }[data.status] ?? "未知状态";
    return Response.json({
      ok: false,
      code: "INVALID_STATE",
      current: data.status,
      hint,
    }, { status: 400 });
  }
  await newapi.updateTokenStatus(env, data.newapi_token_id, 1);  // 1=enabled
  await env.KV.put(`code:${code}`, JSON.stringify({
    ...data,
    status: "active",
    suspended_at: null,
    suspend_reason: null,
    resumed_at: new Date().toISOString(),
  }));
  return Response.json({ ok: true });
}
```

**`POST /admin/revoke`**: 硬停 — 永久注销, **不可恢复**。短期未续走 suspend 软停, ≤ 15 天客户仍未续费 → Maxwell 手动 revoke。

```typescript
const data = JSON.parse(await env.KV.get(`code:${code}`));
await assertXhsTenant(env, data.newapi_user_id);   // 多租户隔离 (§12.10.13)
const { newapi_token_id } = data;
await newapi.updateTokenStatus(env, newapi_token_id, 2);  // 2=disabled (跟 suspend 一样, 但 status=revoked 客户端识别为不可恢复)
await env.KV.put(`code:${code}`, JSON.stringify({
  ...data,
  status: "revoked",
  revoked_at: new Date().toISOString(),
}));
// 注: 真删 newapi user/token 可选 (彻底清理), 这里只 disable token 保留审计痕迹
```

**`POST /admin/rebind`**: 不动 newapi 资源 (LLM key 跟 machine 解耦, 换机不影响; suspended/revoked 状态下不允许 rebind)

**`GET /quota?code=<code>&sig=<sig>`**: 新端点, 中转查 subscription quota

`sig` 算法: 客户端把激活时拿到的 SignedToken (`§6.3` 定义) 的 sig 部分 (base64) 截前 32 字符作为 `sig` 参数, Worker 用 PUBLIC_KEY 验 token 完整签名 (跟 /heartbeat 一样的 verify 路径), 不接受任何不在 KV 里的 code。这样防恶意第三方查别人 quota: 没拿到 SignedToken 拼不出合法 sig。

```typescript
async function handleQuota(req: Request, env: Env) {
  const { code, sig } = parseQuery(req);
  // verifyCodeSig: 比对 KV 里存的 sig 前 32 字符跟传入 sig
  await verifyCodeSig(code, sig, env);
  const data = JSON.parse(await env.KV.get(`code:${code}`));
  await assertXhsTenant(env, data.newapi_user_id);   // 多租户隔离 (§12.10.13)
  
  const data = await env.KV.get(`code:${code}`);
  const { newapi_user_id, newapi_sub_id } = JSON.parse(data);
  
  const subResp = await newapi.getUserSubscriptions(env, newapi_user_id);
  const xhsSub = subResp.data.find(s => s.id === newapi_sub_id);
  
  // 每次拉 newapi 当前汇率/单位 (不硬编码, fetch 自带 60s edge cache, 性能 OK)
  const status = await fetch(`${env.NEW_API_BASE_URL}/api/status`).then(r => r.json());
  const QUOTA_PER_UNIT = status.data.quota_per_unit;        // 通常 500000
  const USD_EXCHANGE_RATE = status.data.usd_exchange_rate;  // 通常 7.3

  return Response.json({
    remain_cny: (xhsSub.amount_total - xhsSub.amount_used) / QUOTA_PER_UNIT * USD_EXCHANGE_RATE,
    total_cny: xhsSub.amount_total / QUOTA_PER_UNIT * USD_EXCHANGE_RATE,
    used_cny: xhsSub.amount_used / QUOTA_PER_UNIT * USD_EXCHANGE_RATE,
    next_reset_at: xhsSub.next_reset_time,   // unix ts
  });
}
```

`quota_per_unit` 和 `usd_exchange_rate` 不要硬编码 (防 Maxwell 调汇率漂移)。每次 `/quota` 请求时调 `GET /api/status` 拉取实际值, Cloudflare Workers fetch 自带 `cache: 'default'` (subrequest 默认 60s 内 dedupe + edge cache), 不需要手动缓存。Worker module-level state 跨 isolate 不可靠 (CF Workers 是 isolate 模型, 不同请求可能进不同 isolate), 不要靠 module 全局 cache。

**月度 reset**: ❌ Worker 不做 (newapi `quota_reset_period: monthly` 原生 cron 内部处理, 每月 1 日扫 `NextResetTime ≤ now` 的 subscription 重置 `AmountUsed=0`)

#### 12.10.4 客户端 license.json schema 扩展

```jsonc
{
  "code": "XHS-XXXX-XXXX-XXXX-XXXX",
  "machine_id": "...",
  "token": "base64(payload).base64(sig)",         // §6.3 SignedToken, 内部 valid_until 是 unix ts
  "valid_until": "2027-05-17T14:44:43.000Z",      // 客户端 license.json 本地缓存用 ISO 易读, 跟 token 内 unix ts 等价
  "status": "active",                              // active | suspended | revoked (v0.6 D6 加, heartbeat 同步)
  "suspend_reason": null,                          // 仅运营内部用, 客户端 banner **不展示** (banner 用固定文案), 详见 §12.10.9
  "llm": {
    "base_url": "https://139.196.157.57/v1",
    "api_key": "sk-xxx",
    "model": "auto-llm"
  },
  "byok": {
    "base_url": "",
    "api_key": "",
    "model": ""
  },
  "dev_mode": false
}
```

存储路径: `userData/license.json` (跟现有 license 文件同路径, 复用 v0.2.7 文件 base64 编码逻辑)。

push 通道: 现有 `license:changed` IPC 事件 (B-001 push 通道) 扩展 payload, 加 `llm` / `byok` / `dev_mode` 字段, renderer store 监听更新。

#### 12.10.5 主进程 cert 放行

`src/main/index.ts` 加 (allowedHosts 必须动态读 license.llm.base_url, 否则 Maxwell 改 IP 后客户端 cert 验证失败 — 跟 N8 base_url 动态下发配套):

```typescript
import { app } from 'electron';
import { getLicense } from './license';

function getAllowedNewapiHosts(): Set<string> {
  // 始终包含 fallback IP (兜底, license 还未激活时也能连)
  const hosts = new Set<string>(['139.196.157.57']);
  // 动态: license.llm.base_url 解析出 hostname 加入 (N8 动态下发后保持一致)
  try {
    const lic = getLicense();
    if (lic?.llm?.base_url) {
      hosts.add(new URL(lic.llm.base_url).hostname);
    }
  } catch (_) { /* ignore, fall back to default */ }
  return hosts;
}

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  try {
    const host = new URL(url).hostname;
    if (getAllowedNewapiHosts().has(host)) {
      event.preventDefault();
      callback(true);    // trust this Caddy self-signed cert (IP 直连 fallback)
      return;
    }
  } catch (_) { /* fall through */ }
  
  callback(false);    // reject all other invalid certs (preserve security for unknown hosts)
});
```

#### 12.10.6 Renderer agent 选择 LLM

`src/renderer/src/ai/agent.ts`:

```typescript
function getActiveLLMConfig(license: License): LLMConfig {
  if (license.dev_mode === true && license.byok?.api_key) {
    return license.byok;
  }
  return license.llm;
}

async function runAgent(messages, ...) {
  const llm = getActiveLLMConfig(useLicenseStore.getState().license);
  if (!llm?.api_key) {
    throw new Error('LLM_NOT_CONFIGURED');
  }
  const client = new OpenAI({
    baseURL: llm.base_url,
    apiKey: llm.api_key,
    dangerouslyAllowBrowser: true,
  });
  // ...
}
```

#### 12.10.7 Settings 反馈框 + 暗号解锁

`src/renderer/src/components/Settings.tsx` 加常驻 "故障排查 / 反馈" 区块:

```tsx
const [feedbackText, setFeedbackText] = useState('');
// DEV_UNLOCK_CODE 真值见 ~/.secrets/xhs-secrets.txt (避免 spec md 泄露; 客户端代码里也建议用 build-time env 注入而非源码硬编码)
const DEV_UNLOCK_CODE = process.env.XHS_DEV_UNLOCK_CODE || '<see ~/.secrets/xhs-secrets.txt>';

useEffect(() => {
  if (feedbackText === DEV_UNLOCK_CODE) {
    showDialog({
      title: '开发者模式',
      message: '已解锁开发者模式, BYOK 配置区已可见. 是否切换到 BYOK 模式?',
      buttons: ['仅解锁不切换', '切换到 BYOK'],
    }).then(choice => {
      window.api.license.setDevMode(true);
      if (choice === 1) window.api.license.setActiveLLM('byok');
    });
    setFeedbackText('');   // 清空避免重复触发
  }
}, [feedbackText]);
```

Settings 解锁后显示:
- BYOK 配置区 (baseURL / API Key / model 输入框, save 到 `license.byok`)
- "当前 LLM 模式" 切换: 中转 / BYOK (写 `license.dev_mode + byok` 字段)
- "退出开发者模式" 按钮 (重置 `dev_mode: false`)

#### 12.10.8 配额展示

`src/renderer/src/components/Settings.tsx` 加 "AI 调用额度" 区块:

```tsx
const { quota } = useQuotaStore();   // 启动时 + chat 完成后 dispatch fetchQuota()

<div>
  <h3>AI 调用额度</h3>
  <progress value={quota.remain_cny} max={quota.total_cny} />
  <p>本月剩余 ¥{quota.remain_cny.toFixed(2)} / ¥{quota.total_cny.toFixed(2)}</p>
  <p>下月 1 日 00:00 自动重置</p>
  <button onClick={() => fetchQuota()}>刷新</button>
</div>
```

fetchQuota: 调 `window.api.llm.getQuota()` (主进程 IPC, 主进程 fetch Worker `/quota?code=...&sig=...`)

刷新时机:
- App 启动 mount
- 每次 chat 完成 (agent.ts done event) 异步触发 (不阻塞 UI)

#### 12.10.9 chat 锁死 UX (3 个触发场景)

三种状态都会让 chat 输入框 disable + Send 置灰 + 顶部 banner, 但**文案固定不可注入**(避免运营 suspend_reason 含敏感词泄露给客户):

| 触发 | 检测 | Banner 文案 (固定模板, 不拼 suspend_reason) |
|---|---|---|
| 配额耗尽 | `quota.remain_cny ≤ 0` (本月配额用完) | "本月 AI 调用额度已用完, 下月 1 日 00:00 自动重置, 联系客服微信 xxx 临时加额" |
| **License suspended** (v0.6) | `license.status === 'suspended'` (未续 LLM 月费) | "AI 服务已暂停, 请联系客服续费 LLM 服务, 续费后立即恢复" |
| **License revoked** (v0.6) | `license.status === 'revoked'` (硬停, 长期未续 / 违规) | "软件已停用, 如有疑问请联系客服微信 xxx" |

⚠️ **suspend_reason 仅运营内部用**: KV / license.json 里存 (Maxwell 在 admin UI 看到), 但**客户端 banner 绝不展示** — 防止 Maxwell 写"客户跑路 6 月未付钱"等内部备注被客户看到。

**dev 模式 + 各 status 的交互**:

| status | dev 模式 入口 | 解锁后 BYOK 切换能用吗 | 设计意图 |
|---|---|---|---|
| active | ✅ 可解锁 | ✅ 可切 BYOK | 客户特殊需求 / 客服 debug |
| quota=0 | ✅ 可解锁 | ✅ 可切 BYOK | 配额耗尽急救 |
| **suspended** | ✅ 可解锁 | ✅ 可切 BYOK | **关键逃生场景** — 未续费时仍能用自己的 key |
| **revoked** | ✅ 可解锁 | ❌ **拒切 BYOK** (硬停后必须找客服恢复 license, 不能绕过) | revoke 是终态, 软件应硬停 |

实现: agent.ts 调用前检查 `license.status !== 'revoked'`, revoked 时即使 dev_mode=true + byok 配置完整也不调 LLM, 强制走 revoked banner。

agent.ts 调 LLM 失败时 catch:

```typescript
try {
  await client.chat.completions.create({...});
} catch (e) {
  if (e?.error?.code === 'insufficient_quota' || e?.status === 429) {
    await fetchQuota();    // refresh
    showDialog({
      title: '本月额度已用完',
      message: '本月 AI 调用额度已用完, 下月 1 日 00:00 自动重置. 急需使用请联系客服微信 xxx 临时加额.',
      buttons: ['知道了'],
    });
    return;
  }
  // 401/403: 不一刀切归 suspend, 先 refresh license 看真实 status
  if (e?.status === 401 || e?.status === 403) {
    const updated = await refreshLicense();    // 主进程 heartbeat 一次拿最新 status
    if (updated.status === 'suspended') {
      showDialog({
        title: 'AI 服务已暂停',
        message: 'AI 服务已暂停, 请联系客服续费 LLM 服务, 续费后立即恢复.',
        buttons: ['联系客服', '知道了'],
      });
      return;
    }
    if (updated.status === 'revoked') {
      showDialog({
        title: '软件已停用',
        message: '软件已停用, 如有疑问请联系客服微信 xxx',
        buttons: ['联系客服', '知道了'],
      });
      return;
    }
    // status 还是 active 但 LLM 401 → 真正的认证问题 (api_key 失效 / 配置错 / 网络异常等)
    showDialog({
      title: '网络异常',
      message: 'AI 服务连接失败, 请稍后重试或联系客服反馈.',
      buttons: ['联系客服', '知道了'],
    });
    return;
  }
  throw e;
}
```

ChatPanel.tsx 锁死逻辑:

```tsx
const isChatLocked = useMemo(() => {
  if (license.status === 'revoked') return { reason: 'revoked', banner: '软件已停用...' };
  if (license.status === 'suspended') return { reason: 'suspended', banner: `AI 服务已暂停... (${license.suspend_reason})` };
  if (quota.remain_cny <= 0) return { reason: 'quota_exhausted', banner: '本月额度已用完...' };
  return null;
}, [license.status, license.suspend_reason, quota.remain_cny]);

// chat 输入框 / Send 按钮: disabled={!!isChatLocked}
// 顶部 banner: isChatLocked && <Banner>{isChatLocked.banner}</Banner>
```

License status 同步: 主进程 license.ts `heartbeat` 响应里检查 `status` 字段变化 → push 给 renderer 更新 store。

#### 12.10.10 Worker secrets

```bash
wrangler secret put NEW_API_BASE_URL       # https://llm.maxwellii.com (Worker → newapi 用域名, Caddy LE 合法证书)
wrangler secret put NEW_API_ACCESS_TOKEN   # maxwell user access_token (system token)
wrangler secret put NEW_API_USER_ID        # 1 (maxwell root user id)
wrangler secret put XHS_PLAN_ID            # 待 Maxwell 建 XHS Plan 后填
wrangler secret put XHS_NEWAPI_GROUP       # xhs
wrangler secret put XHS_LLM_BASE_URL       # https://139.196.157.57/v1 (客户端下发用 IP)
```

#### 12.10.11 失败兜底

| 失败 | Worker 行为 | 客户端行为 |
|---|---|---|
| Worker → newapi 网络/超时 | 重试 3 次指数退避 | - |
| Worker → newapi 持续失败 | /admin/codes 返回 500 → admin retry | - |
| /activate 时 newapi 资源缺失 | `llm: null` | dialog "中转暂不可用, 请稍后再激活, 或暗号切 BYOK" |
| 客户端 SSL handshake 失败 | - | main 捕获 certificate-error 失败 → toast "网络异常, 检查 IP" |
| 配额耗尽 (insufficient_quota) | - | agent.ts catch → 锁 chat 输入 + banner (本月额度文案) |
| **License suspended (未续 LLM 月费, v0.6)** | Maxwell 手动 /admin/suspend → token disable + status=suspended | heartbeat 同步 → license.status=suspended → ChatPanel 锁 + banner (续费文案); 续费后 Maxwell /admin/resume → status=active → 即时解锁 |
| **License revoked (硬停, v0.6)** | suspended > 15 天客户仍未续费 → Maxwell 手动 /admin/revoke → status=revoked | heartbeat 同步 → 全应用停用 banner |
| 本地 license 写失败 (磁盘满) | - | error toast, agent 拒服务 |

#### 12.10.12 一次性 setup checklist

→ **single source 见 [ROADMAP §13 M6 实施计划](./ROADMAP.md)** (含 Maxwell 操作清单 + Worker / 客户端改动列表 + 联调测试 + Exit Criteria)。

本节不再重复, 避免多处维护漂移。

#### 12.10.13 多租户隔离原则（重要安全护栏）

**背景**: 该 newapi 实例 (`https://llm.maxwellii.com`) 由 Maxwell 维护, 同时服务**多个应用**:
- xhs (小红书自运营系统, 本项目)
- 其他个人 / 客户应用 (e.g. lijunfeng 已绑 VIP Plan)
- 其他付费用户

**护栏原则**: Worker 只管理 `xhs-*` 前缀的资源, **不允许影响其他租户**。

##### 命名约定 (强制规范)

| newapi 资源 | xhs 租户命名 | 其他租户 |
|---|---|---|
| user.username | `xhs-*` 前缀 (Worker 建) | 任何不以 `xhs-` 开头 |
| token.name | `xhs-*` (跟 user.username 同) | 同上 |
| Plan | `XHS Plan` (id=2, upgrade_group=xhs) | `VIP Plan` (id=1) 等其他 |
| group | `xhs` | `default` / `vip` / `svip` 等 |
| subscription | 仅 plan_id=2 (XHS Plan) | plan_id ≠ 2 |

##### Worker 操作前的护栏检查

任何 newapi 写操作 (PUT/POST/DELETE) 前, **必须先 GET 验证目标资源 username 以 `xhs-` 开头**:

```typescript
async function assertXhsTenant(env: Env, userId: number): Promise<void> {
  const userResp = await fetch(`${env.NEW_API_BASE_URL}/api/user/${userId}`, {
    headers: newapiAdminHeaders(env),
  }).then(r => r.json());
  const username = userResp.data?.username;
  if (!username || !username.startsWith('xhs-')) {
    throw new Error(
      `TENANT_VIOLATION: refuse operation on user_id=${userId} (username='${username}'), not xhs tenant`
    );
  }
}

// /admin/suspend, /admin/resume, /admin/revoke 等所有写操作进入前调用:
async function handleSuspend(req, env) {
  const { code } = await req.json();
  const data = JSON.parse(await env.KV.get(`code:${code}`));
  await assertXhsTenant(env, data.newapi_user_id);   // ← 关键护栏
  await newapi.updateTokenStatus(env, data.newapi_token_id, 2);
  // ...
}
```

##### 为什么需要这个

- **防 KV 被篡改**: 如果 admin token 泄露, 攻击者可能伪造 KV 数据 `{ newapi_user_id: 2 }` (指向 lijunfeng 等其他人), Worker 不 verify 就会误操作
- **防开发 bug**: Worker 代码 bug 可能写错 user_id, 拿了个非 xhs 用户去 disable token
- **多租户共享 newapi 的现实保护**: 这个 newapi 实例不是 xhs 独占, 必须 defensive

##### 列表 / 查询场景的隔离

- `GET /admin/codes` (Worker admin list): 只列 KV 里 `code:*`, 不调 newapi list, **不会泄露其他租户**
- `GET /quota` (Worker 中转): KV 拿到 user_id 后 assertXhsTenant 验证, 再调 newapi `/api/subscription/admin/users/:id/subscriptions`, 再 filter `plan_id === XHS_PLAN_ID` (= 2), 只返回 XHS Plan 配额

##### 不要做的事 (避免影响其他租户)

- ❌ 不要调 `GET /api/user/?p=0&page_size=1000` 然后批量操作 (会扫到 lijunfeng / maxwell root user)
- ❌ 不要调 `GET /api/subscription/admin/plans` 然后修改其他 plan
- ❌ 不要 PUT `/api/option/` 改 group config (GroupRatio 等), setup 时 Maxwell 手动改一次后 Worker 不再动
- ❌ 不要 DELETE 任何 newapi 资源**不经过 xhs- 前缀验证**
- ✅ 只能 CRUD `xhs-*` user / 同 user 下的 token / plan_id=XHS_PLAN_ID 的 subscription

##### Worker test 必跑场景 (验证隔离)

- [ ] 构造 KV `{newapi_user_id: 1}` (指向 maxwell root user), 调 /admin/suspend → 应被 assertXhsTenant 拒绝, 不影响 maxwell user
- [ ] 构造 KV `{newapi_user_id: 2}` (指向 lijunfeng VIP), 调 /admin/revoke → 同上, 不影响 lijunfeng VIP Plan
- [ ] 正常 xhs- 前缀 user → 操作正常通过

---

### 12.11 D9 · B' token-only 架构（v0.8 / 2026-05-22，取代 §12.10 方案 X）

> **承重事实**（2026-05-22 官方文档复核）：newapi Token schema 无任何周期重置字段（仅 id/user_id/name/key/status/expired_time/remain_quota/unlimited_quota + used_quota/group/model_limits）；周期重置是 `SubscriptionPlan.quota_reset_period:monthly` 属性，作用于 **user 级 subscription**，绑不到 token。方案 X 因此走"一码一 user + 绑 Plan"借 newapi 原生 reset。B' 反向选择：弃 subscription，把额度上限挪到 `token.remain_quota`，**月度重置自建 服务端 Cron**，换取 ① 孤儿结构性消失 ② provisioning/suspend 大幅简化 ③ KV 单一真相源。本质 = 复活 2026-05-18 被否的方案 B（同一事实，因孤儿痛 + 零存量客户导向相反结论）。详见 memory `project_pending_decisions.md` D9 节。

#### 12.11.0 部署形态 (hosting — 2026-05-23 大改)

> **license 服务从 Cloudflare Worker 迁到 alicloud-bj**（跟 newapi v2 同机）。原因：newapi v1（alicloud-sh + maxwellii.com）已退役，v2 重部署到 bj（公网 39.96.12.136 / 域名 doublel.top / Docker + `edge` 网）；license 搬同机 → **溶解 Worker→newapi 跨境 / CF Tunnel / 自签 cert 整套噩梦**。
>
> **本节下文凡 'Worker' 一律读作「部署在 bj 的 Node 服务」**，以下覆盖项为准：

| 原 Worker 写法 | B' 实际 (bj Node) |
|---|---|
| Cloudflare Worker runtime | **Node 服务**（移植 `worker/` TS），Docker 容器 `/home/admin/xhs-license/` 接 `edge` 网 |
| Cloudflare KV | **SQLite**（容器内 `./data`） |
| Workers Cron / `wrangler.toml [triggers]` | **node-cron**（容器内） |
| `wrangler secret` | 容器 **`.env`**（见 §12.11.6） |
| `NEW_API_BASE_URL=https://llm...` (跨境+cert) | **`http://new-api:3000`**（edge 网内，明文内网，无 cert/tunnel） |
| 客户端→Worker (CF 边缘) | 客户端→**IP:port 自签**（同 edge Caddy）；⚠️ `*.doublel.top` 域名 2026-05-24 被阿里云备案拦截 → 退**预案 B**；LLM 现 `https://39.96.12.136:8888/v1` |
| — | ~~保留 Cloudflare /version 兜底~~ → **2026-05-24 取消，CF 全退役**（见下「收尾修订」）|

> 代码归**新建 sibling monorepo `doubleL-license`** 的 `apps/xhs-license`（移植 `worker/` 逻辑，非留本 repo；见 ADR-011）；newapi-proxy 是独立项目，同机共享 box/edge/Caddy/newapi 实例（交汇点，改其文件走转达流程）。

> **2026-05-24 收尾修订**（方案讨论定稿 + subagent 审核；见 memory `project_pending_decisions.md` 收尾节 + AIREADME ADR-011/012）：
> - **栈**：Hono + @hono/node-server + better-sqlite3 + node-cron（下文凡 'CF Cron' 一律读 node-cron）。
> - **代码落点**：不在本 repo `worker/`，而是新建 sibling monorepo `doubleL-license` 的 `apps/xhs-license`（先做完单 app、`license-core` 等 tool2 再抽）。
> - **砍 CF 全落 bj**：上表「保留 Cloudflare /version」一项**取消** — 客户端无 failover + 只兜最不关键端点 + 已激活客户端本地缓存 license 365 天足抗短宕 → 单源 bj。
> - **轮换签名密钥**：旧 `SIGNING_PRIVATE_KEY` 明文进 git（`worker/DEPLOY.md:65`）→ 换全新 Ed25519，**公钥值变 → 客户端须重 bake**（验签格式不变）。
> - **provisioning 鉴权（2026-05-25 实测定稿）**：服务持**专用非 admin 账号（实际 `xiaohongshu-tool` id=4）的访问令牌**（`Authorization: Bearer <NEWAPI_ACCESS_TOKEN>` + `New-Api-User: <id>`）管自己名下 token——**非 root admin、非 password→cookie impersonation**。已实测：该非 admin 账号能自建带 `remain_quota`+`expired_time` 上限、锁 `auto-llm` 的子 token，并 PUT 改额 / DELETE，全 PASS（还实调 LLM 出结果）。**下文凡「impersonate xhs-pool/pool」一律读作「用该账号访问令牌（Bearer + New-Api-User）调」**。详见 AIREADME ADR-013。
> - **客户端 cert（动手必做）**：主进程 `net.fetch` 调 license 不被 `certificate-error` 覆盖 → 需 `setCertificateVerifyProc` + 硬编码新 IP `39.96.12.136`（现写死退役 `139.196.157.57`）。

#### 12.11.1 核心模型

```
所有客户 token 挂【一个】专用 user: xhs-pool (username=xhs-pool, group=xhs, unlimited_quota=true 当"伞")
                                            │
                          ┌─────────────────┼─────────────────┐
                       token A           token B           token C   ... (一码一 token)
                  remain_quota=月额度   remain_quota=月额度    ...
                  name=xhs-<code后缀>   expired_time=下次重置
                  group=xhs / model_limits=auto-llm

[Maxwell] ─POST /admin/codes─► [Worker] ─(impersonate xhs-pool)─► newapi POST /api/token/ (remain_quota + expired_time)
                                          └► KV code:CODE → { token_id, api_key, next_reset_at, status }
[node-cron 每日] ─► 遍历 KV code:* status=active → 过重置日则 token.remain_quota 复位 + expired_time +1月 (impersonate xhs-pool PUT)
```

**为什么是"一个专用 pool user"而非 admin(id=1)**：admin 账户混着 maxwell 自用资源，隔离失效 + 爆炸半径大。专用 `xhs-pool`（`xhs-` 前缀）保持硬隔离，且 pool 拥有所有 token → impersonate pool 可干净 `DELETE token`（根治孤儿，见 [memory feedback_newapi_user_id_orphan]）。

#### 12.11.2 newapi 资源（一次性 setup，取代 §12.10.2）

```yaml
# group xhs: 沿用; 但【模型请求速率限制】设宽 — pool 下多 token 共享 group 限速,
#            设成 vip 那种 [0, N] (总数不限) 避免客户互挤 (RPM 隐患的缓解, 已验证可控)
# XHS Plan: 整套 subscription 弃用 (现存 id=2 已 disabled; newapi 无 API 硬删 plan, 留着无害)

# 专用 pool user (一次性建):
POST /api/user/  { username: "xhs-pool", password: <强随机>, display_name: "XHS Pool" }
# 再 admin PUT 设 group=xhs + unlimited_quota=true ("伞": pool 自身不限额, per-客户 cap 全靠 token.remain_quota)
# → user_id 存 XHS_POOL_USER_ID; 该账号生成「访问令牌」存 NEWAPI_ACCESS_TOKEN (服务 Bearer 鉴权用, 非密码)
```

每激活码一个 token（在 xhs-pool 下创建）:

```yaml
POST /api/token/   # 用账号访问令牌: Authorization: Bearer <NEWAPI_ACCESS_TOKEN> + New-Api-User: <pool id>
body: {
  name: `xhs-${code.slice(-9).toLowerCase()}`,   # 沿用命名 e.g. xhs-wx2a-bcdf, UI 便搜
  unlimited_quota: false,                          # ← 关键: 用 token 自身额度做 per-客户 cap
  remain_quota: <月额度 raw>,                       # = ¥N/7.3×500000 (同原 XHS Plan total_amount 算法)
  expired_time: <下次月初 00:00 unix>,              # belt+suspenders: 没被 cron 续也会硬过期
  model_limits_enabled: true,
  model_limits: "auto-llm",
  group: "xhs",
}
→ returns { id, key: "sk-xxx" }
```

#### 12.11.3 月度重置（B' 自建，取代 newapi 原生）

- **触发**：容器内 **node-cron**（北京每日 00:05，cron 表达式 `0 5 0 * * *`）；或宿主 crontab 调容器内部端点 `/internal/reset`。
- **对齐**：日历月对齐（每月 1 日重置），跟原 UX "下月 1 日重置" 一致。
- **逻辑（幂等）**：
  ```
  for each KV code:* where status === 'active':
    if now >= rec.next_reset_at:
      impersonate xhs-pool → PUT /api/token/ { ...token, remain_quota: 月额度, status: 1, expired_time: 下次月初 }
      rec.next_reset_at = 下次月初; putKV(rec)
  ```
  只在"过了重置日"才动 + 原子推进 `next_reset_at` → 漏跑一天下次补，不重复充。
- **非续费**：Maxwell `/admin/suspend` 把 KV status→suspended → cron 跳过 → token 不再 refill，用尽/过期自然停。**续费 gate 与额度刷新同一套 KV status 逻辑**（比方案 X 的"原生 reset + 手动 invalidate 两套机制"更不易飘）。

#### 12.11.4 Worker 端点改动（取代 §12.10.3）

- **`POST /admin/codes`（大幅简化）**：不再 createUser + bindSubscription。改为 login xhs-pool（cookie 跨 code 复用）→ `createToken(poolId, { remain_quota, expired_time, ... })` → KV 存 `{ token_id, api_key_encrypted, next_reset_at, status:'unused' }`。回滚只需 `deleteToken`（pool 拥有，干净）。
- **`POST /admin/suspend`（简化）**：`updateTokenStatus(token_id, 2)`（impersonate pool PUT status=2）+ KV status=suspended。**不再 invalidate-sub**。
- **`POST /admin/resume`（简化）**：`updateTokenStatus(token_id, 1)` + KV status=active（已过重置日则顺带 refill）。**不再 rebind 新 sub**（方案 X 每次 resume 堆一条 sub 的问题消失）。
- **`POST /admin/revoke`（干净）**：impersonate pool `DELETE /api/token/{id}` + KV status=revoked。**无孤儿**。
- **`GET /quota`（改读 token）**：读 token 的 remain_quota/used_quota（admin `GET /api/token/:id`）+ KV next_reset_at。返回字段 `{ remain_cny, total_cny, used_cny, next_reset_at }` 不变（**客户端零改动**）。
- **`/activate` `/heartbeat`**：不变（仍下发 `llm` + `status`，status 来自 KV）。

#### 12.11.5 多租户隔离（取代 §12.10.13）

B' 下所有 xhs token 归 `xhs-pool` 一个 user。护栏改为双重校验：

```typescript
// 任何 token 写操作 (suspend/resume/revoke/cron-refill) 前:
async function assertXhsToken(env: Env, tokenId: number): Promise<void> {
  const t = await newapi.getToken(env, tokenId);                 // admin GET /api/token/:id
  if (t.user_id !== Number(env.XHS_POOL_USER_ID) || !t.name?.startsWith('xhs-')) {
    throw new Error(`TENANT_VIOLATION: token ${tokenId} 不属于 xhs-pool 或非 xhs- 命名`);
  }
}
```

- ❌ 绝不调全量 user/token list 批量操作；❌ 绝不碰 `XHS_POOL_USER_ID` 以外的 user。
- `GET /admin/codes` 只列 KV，不调 newapi list，不泄露其他租户（不变）。

#### 12.11.6 服务端 `.env`（容器，取代 §12.10.10；`wrangler secret put X` → `.env` 的 `X=`，注意 `NEW_API_BASE_URL=http://new-api:3000` 内网明文、`XHS_LLM_BASE_URL`=新 bj 入口、`SIGNING_PRIVATE_KEY` 从旧 Worker 迁来）

```bash
# 删除:  XHS_PLAN_ID                           (subscription 弃用)
# 新增:
wrangler secret put XHS_POOL_USER_ID    # xhs-pool 的 newapi user id
# (迁 bj 后用 .env 非 wrangler) NEWAPI_ACCESS_TOKEN = 专用账号访问令牌 (Bearer 鉴权, 建/改/删 token; 非密码)
# 保留:  NEW_API_BASE_URL / NEW_API_ACCESS_TOKEN / NEW_API_USER_ID(=1, admin 仍用于 getToken 读) /
#        XHS_NEWAPI_GROUP=xhs / XHS_LLM_BASE_URL=https://39.96.12.136:8888/v1 (旧 139.196.157.57=退役 v1; doublel.top 域名备案被拦走 IP)
```

#### 12.11.7 一次性 setup checklist（取代 §12.10.12 newapi 部分）

- [ ] 建 `xhs-pool` user（unlimited_quota=true, group=xhs）→ id/password 进 secret
- [ ] `xhs` group 模型请求速率限制设宽（`[0, N]` 不限总数，避 pool 共享限速互挤）
- [ ] 写 `Dockerfile` + `docker-compose`（接 `edge` 网）部署 `/home/admin/xhs-license/`；容器内 node-cron（北京每日 00:05）
- [ ] Node 服务（移植 `worker/`）provision/suspend/resume/revoke/quota + node-cron + edge Caddy 加 license 路由（**IP:port 自签**；`*.doublel.top` 备案被拦→不用域名）
- [ ] 删 `XHS_PLAN_ID`，加 `XHS_POOL_USER_ID` / `NEWAPI_ACCESS_TOKEN`（账号访问令牌, 服务鉴权主凭证）
- [ ] （XHS Plan id=2 已 disabled；旧测试 user/token 已于 2026-05-22 清空，见 memory）

#### 12.11.8 沿用 §12.10 不变的部分

client `license.json` schema (§12.10.4) / cert 放行 (§12.10.5) / agent 选 LLM (§12.10.6) / 暗号解锁 (§12.10.7) / 配额展示 UX (§12.10.8，仅数据源 sub→token) / chat 锁 UX (§12.10.9) / 失败兜底 (§12.10.11) 均不变。

## 13. 工作流引擎（M7 / v0.7，待启动）

### 13.1 总览

工作流 = 用户预定义的"模板 + 参数 + 调度"组合, 由主进程 `WorkflowScheduler` 在到点时自动触发, 执行**固定骨架代码**, 其中"创意步骤"(如生成评论文案)调用 LLM 完成。

跟 ChatPanel 即时对话的区别:
- ChatPanel = user 触发 → agent.ts → LLM tool calling loop (多轮)
- Workflow = scheduler 触发 → 固定骨架 → 调 tool + 调 LLM (单次 completion, 不 loop)

共享: license.llm 凭证 / RateLimiter / SQLite app.db / 工具实现 (Go MCP + renderer local)

### 13.2 SQLite Schema

新增 3 张表 (**复用现有 `db/index.ts` better-sqlite3 singleton** — 主进程已为 M2 sessions/messages/material/snapshot 等表注册, 工作流复用同一 db 实例, 写操作同步阻塞天然串行, 无并发风险):

```sql
CREATE TABLE workflows (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id  TEXT NOT NULL,        -- 'daily_like_comment' / 'scheduled_publish' / ...
  name         TEXT NOT NULL,        -- 用户起的名字
  params       TEXT NOT NULL,        -- JSON: 模板专属参数 {top_n:3, comment_style:'praise', ...}
  schedule     TEXT NOT NULL,        -- JSON: {type:'daily'|'weekly'|'interval'|'manual', hour?, minute?, weekday?, interval_hours?, jitter_min?, tz}
                                     -- tz 必填: 'local' (= 创建时 Intl.DateTimeFormat().resolvedOptions().timeZone)
                                     -- 跨时区出差时按"创建时锁定的 tz"算 base, 不跟系统漂移
  enabled      INTEGER NOT NULL DEFAULT 1,
  deleted_at   INTEGER,               -- soft-delete: NULL=未删, 时间戳=已删 (UI 默认 filter 掉, 历史保留)
  fail_count   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,     -- unix ts
  updated_at   INTEGER NOT NULL,
  last_fire_at INTEGER,              -- 最近触发时间 (含 missed)
  next_fire_at INTEGER                -- 算出的下次时间 (含抖动)
);
CREATE INDEX idx_workflows_enabled ON workflows(enabled, deleted_at, next_fire_at);

CREATE TABLE workflow_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id  INTEGER NOT NULL REFERENCES workflows(id),  -- 注意: 不级联删, workflow soft-delete 时历史保留
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  status       TEXT NOT NULL,         -- running / success / partial / failed / missed / aborted / disabled_by_failure
  fail_reason  TEXT,                  -- 标准化失败类型: llm_timeout / llm_5xx / quota_exhausted / rate_limited / xhs_reject / network / user_abort / unknown (见 §13.9)
  summary      TEXT,                  -- 用户视角中文一句话: "✅ 点赞 3 条 + 评论 3 条" / "⚠️ 评论 quota 已达上限, 仅点赞 5 条" (见 §13.9 失败原因表)
  steps_log    TEXT,                  -- JSON array [{step, at, result?, error?}], **每步完成立刻 update** (用户实时看到 history 进度), P1 简单, P2 加详细 trace
  error        TEXT                   -- 技术细节 (stack/原始 message), 供 dev 模式查看
);
CREATE INDEX idx_workflow_runs_workflow_id ON workflow_runs(workflow_id, started_at DESC);

CREATE TABLE IF NOT EXISTS appConfig (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 含 workflow_risk_accepted=1 (首次启用工作流时勾选后写入)
-- 含 schema_version=7 (v0.7 加入工作流表)
```

#### 13.2.1 Schema Migration 流程 (老用户升级到 v0.7)

老用户 (M5/M6 已激活, 本地 `app.db` 已存在 sessions/messages 等表) 升级到 v0.7 时, **必须跑 migration 创建工作流相关表**, 否则启动时 `WorkflowScheduler.init()` query workflows 表会 throw "no such table"。

实现细节:

```typescript
// app/src/main/db/migrations.ts
const MIGRATIONS = [
  { v: 1, sql: '...' },   // M2 sessions/messages
  { v: 2, sql: '...' },   // M5 智能素材库 vision tag
  // ...
  { v: 7, sql: `
    CREATE TABLE IF NOT EXISTS workflows (...);
    CREATE INDEX IF NOT EXISTS idx_workflows_enabled ON workflows(enabled, deleted_at, next_fire_at);
    CREATE TABLE IF NOT EXISTS workflow_runs (...);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id, started_at DESC);
    CREATE TABLE IF NOT EXISTS appConfig (...);
    INSERT OR REPLACE INTO appConfig(key,value) VALUES('schema_version','7');
  ` },
];

export function runMigrations(db: BetterSqlite3.Database) {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const m of MIGRATIONS) {
    if (m.v > current) {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.v}`);
    }
  }
}
```

调用点: `app/src/main/index.ts` `app.whenReady()` 内, `licenseManager.init()` 之后 + `WorkflowScheduler.init()` 之前。

回滚: 不需要 (新表不影响老功能). 老 v0.6 客户端启动 v0.7 schema 的 db 也兼容 (老代码不 query 新表)。

### 13.3 主进程 WorkflowScheduler

文件: `app/src/main/workflow-scheduler.ts`

```typescript
class WorkflowScheduler {
  private timers = new Map<number, NodeJS.Timeout>();  // workflow_id → setTimeout handle
  private running = new Set<number>();                  // 正在执行的 workflow ids (queue 串行)
  private queue: number[] = [];                         // 同时刻到点的排队
  private fireMutex = false;                            // tryFire 入口互斥锁 (防 IPC race)

  // app ready 后调
  async init() {
    const enabled = db.workflows.listEnabled();         // WHERE enabled=1 AND deleted_at IS NULL
    for (const wf of enabled) {
      this.scheduleNext(wf);
    }
    // 系统休眠唤醒后, setTimeout 在睡眠期间不推进, 唤醒时已过期或延迟 → 全量重算
    require('electron').powerMonitor.on('resume', () => this.recomputeAll());
  }

  recomputeAll() {
    log.info('[scheduler] powerMonitor resume → 全量重算 next_fire_at');
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    const enabled = db.workflows.listEnabled();
    for (const wf of enabled) {
      wf.next_fire_at = this.computeNextFireTime(wf);   // 用 tz 锁定的 base + 新 jitter
      db.workflows.update(wf);
      this.scheduleNext(wf);
    }
  }

  // 调度某个 workflow 的下一次
  scheduleNext(wf: Workflow) {
    const now = Date.now();
    if (!wf.next_fire_at) wf.next_fire_at = this.computeNextFireTime(wf);
    const delay = wf.next_fire_at - now;
    if (delay <= 0) {
      // 错过, 写 missed_run 不补跑 (用户视角友好 summary)
      db.workflow_runs.insert({
        workflow_id: wf.id, started_at: now, finished_at: now,
        status: 'missed', fail_reason: null,
        summary: '⏭️ 错过调度 (软件未启动)',
      });
      wf.last_fire_at = wf.next_fire_at;
      wf.next_fire_at = this.computeNextFireTime(wf);
      db.workflows.update(wf);
      this.scheduleNext(wf);
      return;
    }
    // 注意: Node.js setTimeout 最大值 2^31-1 ≈ 24.8 天, 单次调度足够 (最长 "每周" = 7 天 OK)
    // 长 delay 期间系统 sleep 不推进 → powerMonitor.on('resume') 已注册 recomputeAll 兜底
    const handle = setTimeout(() => this.tryFire(wf.id), delay);
    this.timers.set(wf.id, handle);
  }

  async tryFire(workflowId: number) {
    // mutex: 防 IPC race (renderer 同时 enable 多个 → init 并行 → 两个 setTimeout 都进 running)
    while (this.fireMutex) await new Promise(r => setTimeout(r, 10));
    this.fireMutex = true;
    try {
      if (this.running.size > 0) {
        if (!this.queue.includes(workflowId)) this.queue.push(workflowId);
        return;
      }
      this.running.add(workflowId);
    } finally {
      this.fireMutex = false;
    }
    try {
      await this.execute(workflowId);
    } finally {
      this.running.delete(workflowId);
      const next = this.queue.shift();
      if (next) this.tryFire(next);
    }
  }

  async execute(workflowId: number) {
    const wf = db.workflows.get(workflowId);
    if (!wf || wf.deleted_at || !wf.enabled) return;   // 跳过 soft-deleted / 已禁用
    const runId = db.workflow_runs.insert({ workflow_id: workflowId, started_at: Date.now(), status: 'running' });
    pushToRenderer('workflow:run-started', { runId, workflowId });
    try {
      const template = TEMPLATES[wf.template_id];
      const result = await template.execute(JSON.parse(wf.params), {
        callTool,         // 包 RateLimiter check + xsec_token 提取
        callLLM,           // 包 timeout 30s + retry 1 次 (指数退避), 详 §13.6
        sleep,             // helper 随机 30-90s
        log,               // 实时 update steps_log (每步完成立刻 SQLite update)
      });
      db.workflow_runs.update(runId, {
        status: result.status,                          // success / partial
        fail_reason: result.fail_reason ?? null,
        summary: result.summary,
        finished_at: Date.now(),
      });
      // partial 不算 fail (步骤上限/RateLimiter 命中 = 正常护栏)
      if (result.status === 'success') wf.fail_count = 0;
    } catch (e) {
      const reason = classifyError(e);                  // llm_timeout / network / xhs_reject / ...
      db.workflow_runs.update(runId, {
        status: 'failed', fail_reason: reason,
        summary: SUMMARY_BY_REASON[reason],             // 见 §13.9 失败原因表
        error: e.message, finished_at: Date.now(),
      });
      wf.fail_count += 1;
      if (wf.fail_count >= 3) {
        wf.enabled = 0;
        pushToRenderer('workflow:auto-disabled', { workflowId, lastReason: reason });
      }
    }
    wf.last_fire_at = Date.now();
    wf.next_fire_at = this.computeNextFireTime(wf);
    db.workflows.update(wf);
    if (wf.enabled) this.scheduleNext(wf);
    pushToRenderer('workflow:run-finished', { runId, workflowId });
  }

  computeNextFireTime(wf: Workflow): number {
    const s = JSON.parse(wf.schedule);
    // base 按 wf.schedule.tz (创建时锁定) 算, 不跟系统漂移. 例:
    //   tz='Asia/Shanghai' + hour=9 → 上海时间 9:00 对应的 UTC ms
    let base = computeBaseFireTime(s);
    const jitterMs = (s.jitter_min ?? 10) * 60 * 1000;
    const jitter = (Math.random() * 2 - 1) * jitterMs;  // ±10min
    return base + jitter;
  }
}
```

### 13.4 IPC Contract

主进程 (`workflow:*` channel, 沿用现有 ipcMain.handle 模式):

```typescript
workflow:list                 → Workflow[]                  // 默认 WHERE deleted_at IS NULL
workflow:create(input)        → Workflow
workflow:update(id, patch)    → void
workflow:delete(id)           → void                        // soft-delete: UPDATE workflows SET deleted_at=now, enabled=0 WHERE id=?
                                                            //   清 timer + 历史保留. UI 默认不显示, dev 模式可恢复.
workflow:enable(id, on)       → void
workflow:run-now(id)          → { runId }                   // 手动触发, queue 入队
workflow:runs(id, limit)      → WorkflowRun[]               // 实时反映 steps_log 进度 (每步完成立刻 update)
workflow:get-templates()      → TemplateMeta[]              // P1 阶段只返已实现模板 (UI 直接藏未实现, 不 disabled), 减少用户困惑
workflow:dev-fire-soon(id)    → void                        // dev 模式 only: 把 next_fire_at 设为 now+30s, 跳 schedule 等待

// push events (webContents.send)
license:changed              (沿用)
workflow:run-started         { runId, workflowId }
workflow:run-step-update     { runId, workflowId, step }    // 实时进度 (每步完成 push)
workflow:run-finished        { runId, workflowId, status, fail_reason? }
workflow:auto-disabled       { workflowId, lastReason }     // 连续 3 fail 触发, lastReason 见 §13.9
```

### 13.5 模板规格 (P1 详, P2 框架)

文件: `app/src/main/workflow-templates/*.ts`, 每个 export 一个 `Template` 对象:

```typescript
interface Template {
  id: string;
  name: string;          // UI 显示
  emoji: string;
  description: string;
  paramsSchema: ParamSchema;
  execute(params: object, helpers: ExecHelpers): Promise<{status, summary}>;
}
```

#### 13.5.1 P1: `daily_like_comment` 每日首页点赞评论

```typescript
{
  id: 'daily_like_comment',
  emoji: '👍',
  paramsSchema: {
    top_n: { type: 'int', min: 1, max: 5, default: 3 },        // 硬上限 5
    comment_style: { type: 'enum', options: ['short','long','question','praise'], default: 'praise' },
  },
  async execute({ top_n, comment_style }, { callTool, callLLM, sleep, log }) {
    top_n = Math.min(top_n, 5);  // 二次硬截 (UI input 限了, 这里 belt-and-suspenders)
    // 注意: 小红书 API 字段是 camelCase (xsecToken), 不是 snake_case. like/comment/favorite 都必须传 xsec_token,
    //   否则被 reject (xiaohongshu-mcp jsonschema required, CLAUDE.md 坑 7).
    const feeds = (await callTool('list_feeds', {})).feeds.slice(0, top_n);
    let liked = 0, commented = 0;
    const skips: string[] = [];
    for (const feed of feeds) {
      try {
        await callTool('like_feed', { feed_id: feed.id, xsec_token: feed.xsecToken });
        liked++;
        await sleep(rand(30000, 90000));

        if (commented < 3) {  // comment 硬上限 3
          let comment: string;
          try {
            comment = await callLLM({
              system: COMMENT_PROMPTS[comment_style],
              user: `笔记标题: ${feed.title}\n笔记内容: ${feed.content?.slice(0, 500)}`,
              max_tokens: 80,
            });
          } catch (e) {
            // callLLM 内部已 retry 1 次, 仍 fail → 跳过当前 feed 评论步骤, 不 abort 整 run
            log({ step: 'gen_comment', feed_id: feed.id, error: e.message });
            skips.push(`第 ${feeds.indexOf(feed) + 1} 条评论生成失败 (${e.message})`);
            continue;
          }
          await callTool('post_comment_to_feed', { feed_id: feed.id, xsec_token: feed.xsecToken, content: comment });
          commented++;
          await sleep(rand(30000, 90000));
        }
      } catch (e) {
        // RateLimiter abort / 小红书 reject 单 feed fail 不 abort 整 run, 改记到 partial
        log({ step: 'feed', feed_id: feed.id, error: e.message });
        skips.push(`第 ${feeds.indexOf(feed) + 1} 条: ${e.message}`);
      }
    }
    // 用户视角中文 summary, 区分 success vs partial
    const isPartial = skips.length > 0 || (liked < top_n) || (commented < Math.min(top_n, 3));
    const summary = isPartial
      ? `⚠️ 点赞 ${liked} 条 + 评论 ${commented} 条 (跳过: ${skips.join('; ')})`
      : `✅ 点赞 ${liked} 条 + 评论 ${commented} 条`;
    return { status: isPartial ? 'partial' : 'success', summary };
  },
}

const COMMENT_PROMPTS = {
  short: '你是小红书评论助手. 生成 1 条 5-15 字的短评论, 贴合笔记内容, 自然口语. 直接返回评论文字不要引号.',
  long:  '你是小红书评论助手. 生成 1 条 20-40 字的长评论, 有共鸣感, 不要复读 hashtag. 直接返回.',
  question: '你是小红书评论助手. 生成 1 条 10-30 字的提问式评论, 引起作者回复. 直接返回.',
  praise: '你是小红书评论助手. 生成 1 条 10-25 字的真诚赞美评论, 不要假大空. 直接返回.',
};
```

#### 13.5.2 P2: 其他 4 个模板 (框架定义, P2 实现)

| id | emoji | params | 骨架 |
|---|---|---|---|
| `scheduled_publish` | ⏰ | `{title, content, images[], video?, cover?}` | `publish_content` 或 `publish_with_video` |
| `daily_signin_interact` | ✍️ | `{follow_top_n: 1-10}` | 取关注列表 → 每人最新一篇 `like_feed` |
| `daily_data_snapshot` | 📊 | `{}` (无参) | `my_profile()` → 写新表 `data_snapshots` |
| `keyword_like_comment` | 🔍 | `{keyword, sort:'hot'|'time'|'liked', top_n:1-5, comment_style}` | `search_feeds` → top N `like_feed` + `post_comment` |

### 13.6 风控加固 (实现细节)

| 加固项 | 实现位置 | 细节 |
|---|---|---|
| 调度抖动 ±10min | `WorkflowScheduler.computeNextFireTime` | `(Math.random() * 2 - 1) * 10 * 60 * 1000` |
| 步骤间随机延迟 30-90s | helper `sleep(rand(30000, 90000))` | 每步骤间穿插 |
| 步骤硬上限 | template `execute` 内 | `top_n = Math.min(top_n, 5)`, comment 计数 < 3 |
| 全局 RateLimiter 沿用 | `helpers.callTool` 内自动调 | publish 3/天 / comment 10/h / like 30/h |
| 首次启用对话框 | renderer `RiskWarningDialog` | 写 `appConfig.workflow_risk_accepted=1` 后不再弹 |
| 连续 3 fail auto disable | `WorkflowScheduler.execute` catch 分支 | `wf.fail_count >= 3 → enabled=0`, partial 不计 fail |
| LLM call timeout + retry | `helpers.callLLM` 内 | 单次 timeout 30s, 5xx/network/超时 retry 1 次 (指数退避 2s), 仍 fail 抛 LlmError (上层捕获跳过该步骤记 partial 而非整 run failed) |
| LLM 429 (quota 耗尽) | `helpers.callLLM` 抛 InsufficientQuotaError | 整 run 标 `failed` + `fail_reason=quota_exhausted` (跟普通 5xx 区分, 用户视角看 summary 知道需要续费而非"系统问题") |
| 跨工作流 quota 冲突 | `helpers.callTool` 检 RateLimiter | 多个 enabled 工作流同抖动窗口跑时, queue 串行 + 首个吃光 quota 后续工作流 callTool 抛 RateLimitError → 模板 catch 跳过单步骤 → run 标 `partial` (不算 fail). WorkflowEditor UI 创建时**预估当日 quota 消耗**警示用户 (例: "此模板每天消耗 5 like + 3 comment, 你已有 N 个 like-类工作流, 当日总计 X 可能超 30/h") |

#### 13.6.1 跨工作流 quota 冲突处理 (P0)

3 个 like-类 enabled 工作流, 都设抖动窗口含 9:00, 会同时落到 9:00 ±10min 内. queue 串行后:
- 第 1 个吃 5 like → RateLimiter 当小时累 5/30
- 第 2 个吃 5 like → 累 10/30
- 第 3 个吃 5 like → 累 15/30

依然不超 30/h 上限, 不会 fail. **但**若用户有 publish-类工作流同窗口跑, publish 上限 3/天可能击中.

UI 措施 (P1 实施):
- WorkflowEditor 创建时, 根据已有 enabled 工作流统计预估当日消耗, 警示但不阻止
- WorkflowList row 显示"今日已用: like X/30, comment Y/10, publish Z/3"
- 仅 dev 模式可看, 默认用户不暴露此细节

### 13.7 UI 组件

```
app/src/renderer/src/components/
├── WorkflowList.tsx           # 控制台左中段, 列表 + ▶/⋮
├── WorkflowEditor.tsx          # 模态弹框, 选模板 + 填参 + 调度
├── WorkflowRunHistory.tsx     # 模态弹框, 列运行历史
└── RiskWarningDialog.tsx      # 首次启用弹一次

app/src/renderer/src/lib/
└── workflow.ts                 # IPC wrapper + types
```

### 13.8 控制台左侧 25% 三段布局 (CSS)

```css
.console-left {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.console-left__commands { flex: 0 0 auto; }          /* 固定高 ≈ 140px */
.console-left__workflows { flex: 1; min-height: 0; overflow-y: auto; }
.console-left__sessions { flex: 1.5; min-height: 0; overflow-y: auto; }
```

### 13.9 错误处理矩阵 + 用户视角失败原因表

#### 13.9.1 错误类型矩阵 (内部)

| 失败类型 | run status | fail_reason | fail_count++ | summary 文案 (中文) |
|---|---|---|---|---|
| LLM timeout (>30s) | `failed` | `llm_timeout` | ✅ | ❌ AI 响应超时, 已重试 1 次仍失败 |
| LLM 5xx (retry 后仍 fail) | `failed` | `llm_5xx` | ✅ | ❌ AI 服务暂时不可用, 稍后会自动重试 |
| LLM 429 quota | `failed` | `quota_exhausted` | ✅ | ❌ 本月 AI 额度已用尽, 请联系客服续费 |
| LLM 401/403 | `failed` | `llm_auth` | ✅ | ❌ AI 服务未授权 (激活码状态异常?) |
| LLM 单步骤失败但单 run 内其他步骤 OK | `partial` | - | ❌ | ⚠️ 部分步骤完成 (某些评论生成失败已跳过) |
| RateLimiter abort (本工作流执行中达上限) | `partial` | `rate_limited` | ❌ | ⚠️ 已达频率上限 (本小时), 仅完成 N 步 |
| 小红书 API reject (cookies 过期 / xsec_token 错 / 风控) | `failed` | `xhs_reject` | ✅ | ❌ 小红书拒绝操作, 请检查登录状态 |
| 网络断 (fetch error) | `failed` | `network` | ✅ | ❌ 网络异常 |
| 用户手动 abort | `aborted` | `user_abort` | ❌ | ⏹ 已手动停止 |
| app 关闭期间错过 | `missed` | - | ❌ | ⏭️ 错过调度 (软件未启动) |
| 未分类异常 | `failed` | `unknown` | ✅ | ❌ 未知错误 (详见日志) |

#### 13.9.2 helpers.classifyError 实现

```typescript
function classifyError(e: Error): FailReason {
  const msg = e.message?.toLowerCase() || '';
  if (e instanceof LlmTimeoutError) return 'llm_timeout';
  if (e instanceof InsufficientQuotaError) return 'quota_exhausted';
  if (msg.includes('401') || msg.includes('403')) return 'llm_auth';
  if (msg.startsWith('llm') && /5\d\d/.test(msg)) return 'llm_5xx';
  if (e instanceof RateLimitError) return 'rate_limited';
  if (msg.includes('cookies') || msg.includes('xsec') || msg.includes('-100')) return 'xhs_reject';
  if (msg.includes('fetch') || msg.includes('econnref')) return 'network';
  return 'unknown';
}
```

### 13.10 跟 D6 LLM Gateway 关系 + 护栏继承

- 工作流的 AI 填补步骤复用 `license.llm` 凭证 (D6 中转下发)
- **不绕过 D6 任何护栏**: callLLM helper 复用 agent.ts 的 `licenseLLMCall()` 等价路径, D6 quota check / overdue 软停 / 多租户隔离 / cert-error 放行都生效
- 每次 LLM 调用计入 newapi user 的 XHS Plan 月度 quota
- 用户超 quota 时工作流标 `failed` + `fail_reason=quota_exhausted` (跟普通 5xx 区分, summary 提示"续费", 见 §13.9.1)
- license `status='suspended'` 期间 callLLM 立即抛 InsufficientQuotaError, 工作流 fail; `status='revoked'` 期间 WorkflowScheduler 启动时跳过注册 timer (`init()` filter `license.status === 'active'`)
- dev 模式 BYOK 配置生效时, 工作流走 BYOK 而非中转 (走 `license.byok.*`, quota 不计 XHS Plan)

#### 13.10.1 商业模型澄清 (跟 D6 月费的关系)

- 工作流 24×7 后台跑可能远超个人聊天 quota. 当前决策 (v0.7 启动时):
  - **不另收费**: 工作流 LLM 消耗计入同一月度 quota (XHS Plan ¥X/月)
  - **超额自动停**: 用户当月 quota 耗尽 → 工作流标 `failed/quota_exhausted` 而非整体 disable, 下月 quota reset 后 schedule 时自动恢复
  - **若运营数据显示高度运营户耗光 quota 影响付费用户体验**, M8 公测前评估是否升级为"工作流单独配额桶"或"分级月费" (待 D9 决策, 见 PRD §10)
- 文档明示这一点, 避免用户期望落差

### 13.11 不在 M7 P1 范围 (推迟 P2/P3)

- 其他 4 个模板 (P2)
- dev 模式 cron 表达式 (P3)
- 运行历史详细 step log trace + 筛选 / 导出 (P3)
- 跨设备同步 (永不做, 单设备绑定)
- 事件触发 (新评论 → 自动回复) (永不做, 客户端关闭就废)
- 可视化编排 (拖拽 + 分支) (永不做, 模板足够)

---

**文档结束 · SPEC v0.4**
