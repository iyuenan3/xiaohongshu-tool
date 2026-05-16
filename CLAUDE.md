# 小红书自运营系统 · 项目内 Claude 指引

> 本文档是给 Claude Code 看的项目配置。详细产品/技术信息见 `PRD.md` / `SPEC.md` / `ROADMAP.md` / `INFRA.md`(后者已 .gitignore)。

## 一句话

基于 Electron + Chromium 内核的小红书桌面浏览器，内嵌 `xiaohongshu-mcp` Go 服务，AI 侧边栏通过用户自带的大模型 API（BYOK）操作 11 个小红书业务工具。**完全本地化、无证书发布**、一次性买断 + 激活码授权。

## 路线（不要再讨论）

**路线 A** · 完全本地化 + BYOK + 无证书发布。不卖 token（已剥离独立项目）、不做服务端反代、不申请 Apple/Win 代码签名。唯一服务端是 Cloudflare Worker 激活服务（M3 启动）。

## 目录结构

```
xiaohongshu-tool/
├── PRD.{md,html}              v0.3 产品需求
├── SPEC.{md,html}             v0.1 技术规格
├── ROADMAP.{md,html}          v0.2 10 周时间线
├── INFRA.md                   含 Cloudflare Account ID 等 (.gitignore)
├── app/                       Electron 客户端
│   ├── src/main/              主进程: index/ipc/cdp/go-subprocess/db/conv/rate
│   ├── src/preload/           contextBridge
│   ├── src/renderer/src/      React UI
│   │   ├── ai/                byok / tools / agent (核心)
│   │   └── components/        ChatSidebar / Settings / ConfirmDialog
│   ├── resources/bin/         Go 二进制 (构建产物, .gitignore)
│   ├── package.json           dev/build/build:go scripts
│   └── .npmrc                 淘宝镜像 (electron 二进制 + npm registry)
├── xiaohongshu-mcp/           Go MCP 服务 (复用 + 改造, 已删 .git)
└── x-mcp/                     参考代码 (.gitignore)
```

## 常用命令

```bash
# 启动开发
cd app && npm run dev
# (会自动 build Go 二进制 → vite + electron 启动 → spawn Go subprocess → 自动开 xhs 窗口)

# 仅重 build Go (改 Go 代码后)
cd app && npm run build:go

# TS 类型检查
cd app && npm run typecheck

# 检查 SQLite 数据
sqlite3 "$HOME/Library/Application Support/xhs-app/app.db" ".schema"

# 杀残留进程 (UI/Go 卡死时)
pkill -f electron-vite; pkill -f "Electron.app/Contents/MacOS/Electron"; pkill -f xiaohongshu-mcp
```

## 进度（截止 2026-05-16）

- [x] M1 PoC（CDP attach + publish_content E2E 已真实发到小红书）
- [x] M2 W3-W4（AI 侧边栏 + Tool Calling Loop + 11 工具）
- [x] M2 W5（SQLite 对话历史 + 页面上下文注入 + 频率护栏）
- [ ] **M3 商业化**（Cloudflare Worker 激活 + 客户端激活 + asar 加固）← 下一步
- [ ] M4 跨平台无证书打包
- [ ] M5 公测 + 发售

## M3 启动前阻塞决策

**必须先拍板的（D1/D2/D4）**：
- D1 售价区间（推荐 ¥299 一次性买断）
- D2 是否提供试用版（推荐 否）
- D4 法律主体（推荐 个体工商户）

详见 `PRD.md` §10。

## 关键技术约束（架构红线）

### CDP attach 架构（M1 已验证）

1. 主进程 bootstrap 顺序：`pickFreePort()` → `appendSwitch('remote-debugging-port')` → `app.whenReady()` → spawn Go → 解析 `BIND_PORT=<n>` → fetch `/json/version` 拿 wsUrl → POST `/internal/attach`
2. attach 模式下 go-rod **不能创建新 page**（Electron 不支持 CDP `Target.createTarget`），必走 `selectAttachedPage()` 复用已有
3. xhs 窗口**绝不能 hide**（page 会从 active targets 消失），只能 `minimize()`
4. 主进程必须设这 4 个 switch（不设则最小化后 `Execution context destroyed`）：
   - `disable-features=CalculateNativeWinOcclusion,BackForwardCache`
   - `disable-background-timer-throttling`
   - `disable-renderer-backgrounding`
   - `disable-backgrounding-occluded-windows`

### 业务约束

- **仅支持 1 个小红书账号**（防风控关联 + 简化工程）。1 个激活码绑 1 个小红书 user_id，换绑找客服。
- **不限同时在线设备数**（之前讨论过设备绑定，最终用小红书账号绑定替代）
- 频率护栏：publish 3/天 + 30min gap，comment 10/h，like/favorite 30/h
- 敏感操作（发布/评论/点赞/收藏）默认弹确认对话框

### dev 环境特殊配置

- `webPreferences.webSecurity: false`（renderer 直连 LLM API，M3 阶段会收回主进程）
- `index.html` CSP 放宽 `connect-src *`
- M3 商业化时收紧

## 工程踩坑速查

1. **npm install 偶尔破坏 node_modules** → 装新包后立即 `ls node_modules/.bin/electron-vite`，破坏就 `rm -rf node_modules && npm install`
2. **GET/HEAD 请求不能带 body** → `callApi` 必须检查 `Object.keys(body).length > 0`
3. **service.go 所有 `defer page.Close()`** 必须用 `closeIfNotAttached(b, page)` helper（attach 模式下关 page 等于关用户窗口）
4. **Electron 二进制 + Go 依赖国内被墙** → `.npmrc` 已配淘宝镜像，Go 端 `go env -w GOPROXY=https://goproxy.cn,direct`
5. **macOS Finder 偶尔留 `<name> 2.<ext>` 副本** → `find . -name "* 2.*" -not -path "*/node_modules/*"` 扫一遍

## BYOK 接入参考

用户实测的 BYOK 配置（火山方舟 Coding Plan）：

| 字段 | 值 |
|---|---|
| baseURL | `https://ark.cn-beijing.volces.com/api/coding/v3` |
| model | `doubao-seed-2.0-pro` (推荐) / `doubao-seed-2.0-lite` / `deepseek-v3.2` |

注意：火山方舟 Coding Plan 的 path 是 `/coding/v3` 而不是标准 ARK 的 `/v3`。

## Git 规约

- 每个 commit 必须含 `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
- **不要主动 commit**（用户全局规则 + 项目规则）
- **绝不 push** 远程（用户全局规则）
- xiaohongshu-mcp baseline 已 vendor 进顶层 git（删了原 .git）

## 协作风格（用户特定）

- 高执行力倾向，完成一个阶段立刻问"下一步推什么"
- 决策题选择题为主（2-4 个选项 + 标注"(推荐)"），不要纯开放式问题
- 不要"已经做了很多，要不要休息"主动停下，凌晨 3 点后再询问
- 错误处理先 grep dev log 找现场，不要凭直觉猜
- 文档驱动：大改方向后 6 份文档（3 md + 3 html）同步更新

更多细节见 `~/.claude/projects/-Users-maxwell-Desktop-Claude-Project-xiaohongshu-tool/memory/`。
