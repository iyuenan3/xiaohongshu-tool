# 小红书自运营系统 SPEC

> 技术规格说明书 v0.2 · 2026-05-17 · 配套 PRD v0.5
>
> **v0.2 变更**: v0.2.0~v0.3.0 系列 ship 完毕,在文末追加 §12 增量模块章节 (素材库 / 联网搜索 / 自定义协议 / 网页管理后台 / mac 打包流水线).
> v0.1 部分内容仍 valid, 但部分被取代:
> - §2.2 `license.ts` 改用文件 base64 (§12.5 详述)
> - §3.2 ChatSidebar.tsx → ChatPanel.tsx + ConsolePane / CommandPalette / ConversationList (§12.1 详述)
> - 11 工具变 13 工具 (新增 `search_local_assets` + `web_search` §12.3)

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
}
interface ActivateError {
  ok: false;
  code: 'CODE_NOT_FOUND' | 'CODE_REVOKED' | 'CODE_BOUND_OTHER' | 'CODE_EXPIRED' | 'INTERNAL';
  message: string;
}

// POST /heartbeat
interface HeartbeatRequest {
  token: string;
}
interface HeartbeatResponse {
  ok: true;
  latest_version: string;       // 最新软件版本
  min_version: string;          // 最低支持版本 (< min 拦截使用)
  revoked: boolean;             // 当前 code 是否被吊销
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
                             status: 'unused' | 'active' | 'revoked',
                             bound_machine_id: string | null,
                             bound_at: number | null,
                             expire_at: number | null,
                             rebind_count: number,
                             notes: string,
                             revoked_reason: string | null
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
| 手动验收 | 11 个 MCP 工具 + 激活流程 + 跨平台打包 | checklist |

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

---

**文档结束 · SPEC v0.2**
