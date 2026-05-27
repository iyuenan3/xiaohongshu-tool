# xhsPilot — 桌面小红书 AI 运营工具

基于 **Electron + Chromium** 的桌面小红书浏览器，内嵌 **Go MCP 服务**提供 14 个自动化工具，AI 侧边栏通过 LLM 驱动操作小红书（发布 / 评论 / 点赞 / 收藏 / 搜索 / 数据采集 / 定时工作流）。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron + TypeScript |
| 前端 | React 18 + Vite + Zustand |
| 后端 | Go (go-rod CDP 浏览器自动化) |
| 数据 | better-sqlite3（会话/素材库/工作流） |
| LLM | OpenAI 兼容接口（agent tool-calling loop） |
| 打包 | electron-builder（macOS DMG / Windows NSIS） |

## 架构

```
用户 → ChatPanel (React)
         │
         ▼
      agent.ts ── LLM (tool-calling loop)
         │
    ┌────┴────┐
    ▼         ▼
 Go MCP    Renderer 本地工具
(12 工具)  (素材库搜索 / 联网搜索)
    │
    ▼
 go-rod CDP attach ── Electron Chromium ── 小红书页面
```

- **Go MCP** 作为子进程运行，主进程通过 HTTP `127.0.0.1` 调用
- CDP attach 模式：Go 端 go-rod 复用 Electron 的 Chromium 实例，共享 cookies / 登录态
- AI 对话走 OpenAI 兼容的 tool-calling：LLM 决定调用哪个工具 → agent 执行 → 结果回灌 → 直到完成

## 快速开始

```bash
# 前置: Node 22+, Go 1.24+, macOS / Windows

# 安装依赖
cd app && npm install

# 开发模式（自动 build Go → Vite + Electron → 启动）
npm run dev

# 仅重 build Go（改 Go 代码后）
npm run build:go

# 类型检查
npm run typecheck
```

## 构建安装包

```bash
# macOS (arm64)
npm run build:mac

# Windows (x64)
npm run build:win

# Windows (Docker 交叉编译，无需 Windows 机器)
npm run build:win:docker
```

产物在 `app/release/`。

## 运行测试

```bash
# 前置：dev 在跑
node tests/e2e/run-all.mjs

# 单模块
node tests/e2e/license.mjs
node tests/e2e/assets.mjs
```

## 项目结构

```
xiaohongshu-tool/
├── app/                     # Electron 客户端
│   ├── src/main/            # 主进程（Go 子进程管理 / IPC / 工作流 / 素材库）
│   ├── src/renderer/        # 渲染进程（React UI / AI agent / LLM provider）
│   ├── src/preload/         # contextBridge IPC 契约
│   └── resources/           # Go 二进制 + DMG 资源
├── xiaohongshu-mcp/         # Go MCP 服务（vendored fork）
├── tests/e2e/               # E2E 测试（CDP 黑盒）
└── .github/workflows/       # CI（macOS + Windows 构建）
```

## xiaohongshu-mcp

`xiaohongshu-mcp/` 基于 [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)，改造包括：

- CDP attach 模式（复用 Electron Chromium 而非自启浏览器）
- feed 序号寻址（LLM 传短序号，Go registry 查真实 ID，防抄错）
- 发布/互动工具的快速失败超时策略
- HTTP server（`gin` + MCP SDK）供 Electron 主进程调用

## 许可证

MIT — 见 [LICENSE](./LICENSE)
