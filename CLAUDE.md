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

## 进度（截止 2026-05-16 下午）

- [x] M1 PoC（CDP attach + publish_content E2E 已真实发到小红书）
- [x] M2 W3-W5（AI 侧边栏 + Tool Calling + 11 工具 + SQLite + 频率护栏）
- [x] **M3 商业化**（Worker + KV + Custom Domain xhslicense.maxwellii.com + 客户端激活 E2E ✅）
- [x] **M4 macOS dmg 打包**（identity:null 无证书 + auto-update + Windows nsis 跨平台 build）
- [ ] M5 公测 + 发售

## M3 已拍板决策（v0.4 2026-05-16）

- D1 ✅ 售价：挂牌 ¥399 + 客服 1V1 议价
- D2 ✅ 试用版：无（仅 demo 视频/截图）
- D4 ✅ 法律主体：个人名义（销量验证后升级个体户）
- D3 ⏳ 产品名/域名：待 M5 公测前定
- D5 ⏳ 客服渠道：待 M5 公测前定

## 部署事实（2026-05-16）

- Worker URL（fallback）：`https://xhs-license.liyuenan93.workers.dev`
- Custom Domain（客户端默认）：`https://xhslicense.maxwellii.com`
- KV namespace ID：`a42560054b8241e89ddbe9317d35af21`
- Secrets：SIGNING_PRIVATE_KEY + ADMIN_TOKEN 已注入（值见 INFRA.md gitignored）
- 首发码发码 CLI：`worker/scripts/xhs-license.mjs`，详见 `worker/DEPLOY.md`

## 关键技术约束（架构红线）

### CDP attach 架构（M1 已验证）

1. 主进程 bootstrap 顺序：`pickFreePort()` → `appendSwitch('remote-debugging-port')` → `app.whenReady()` → spawn Go → 解析 `BIND_PORT=<n>` → fetch `/json/version` 拿 wsUrl → POST `/internal/attach`
2. attach 模式下 go-rod **不能创建新 page**（Electron 不支持 CDP `Target.createTarget`），必走 `selectAttachedPage()` 复用已有
3. M4 后改 `<webview>` 嵌入：guest page target type=`"webview"`，`selectAttachedPage()` 必须 fallback 用 `proto.TargetGetTargets{}.Call()` + `PageFromTarget` 找
4. **必须**设这 4 个 commandLine switch（webview tab 切换隐藏时 occlusion 节流让 Go CDP 报 -32000）：
   - `disable-features=CalculateNativeWinOcclusion,BackForwardCache`
   - `disable-background-timer-throttling`
   - `disable-renderer-backgrounding`
   - `disable-backgrounding-occluded-windows`

### M4 单窗口 + tab 切换架构

- mainWindow webPreferences `webviewTag: true`
- 顶部 tabbar 40px：[控制台] [小红书]
- 控制台 tab：左 main-pane 60% (hero + 提示) + 右 ChatSidebar 40%
- 小红书 tab：`<webview src="..." partition="persist:xhs">` 全屏
- **所有 MCP 工具交互走 AI 聊天**（不要做 ToolPanel 直接调用按钮 — user 明确否决）
- tab 切换用 `left:-99999px + visibility:hidden`，**绝不能用 display:none**（webview guest 会被 destroy 丢 cookies）

### macOS Tahoe + Retina + Chromium fractional scaling 锁定

- 用户 Mac 14" "Looks Like 1800x1169" (1.68x 非整数 retina) 让 Chromium inner viewport 锁死 1280x800
- 当前 workaround：BrowserWindow 锁 1280x800 + `resizable: false`
- 详见 memory `decisions_macos_tahoe_chromium.md`

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

1. **npm install 极频繁破坏 node_modules** → 已发生 10+ 次，每次某个 transitive dep missing。标准修：`chmod -R u+w node_modules; rm -rf node_modules package-lock.json; npm install`。避免反复 install/uninstall
2. **macOS Finder 留 `<name> 2/` 目录副本** → `find node_modules -name "* 2" -type d 2>/dev/null | xargs rm -rf`
3. **GET/HEAD 请求不能带 body** → `callApi` 必须检查 `Object.keys(body).length > 0`
4. **service.go 所有 `defer page.Close()`** 必须用 `closeIfNotAttached(b, page)` helper（attach 模式下关 page 等于关用户窗口）
5. **Electron 32 → 38 升级**：需 `npx electron-builder install-app-deps` rebuild native modules (NODE_MODULE_VERSION 128 → 139)
6. **Electron 二进制 + Go 依赖国内被墙** → `.npmrc` 已配淘宝镜像，Go 端 `go env -w GOPROXY=https://goproxy.cn,direct`
7. **小红书 API 字段是 camelCase 不是 snake_case** → `noteCard.displayTitle` / `xsecToken` / `interactInfo.likedCount`。写 formatter 前先 `curl http://127.0.0.1:<port>/api/v1/feeds/list` 看真实 schema
8. **DNS 劫持 *.workers.dev (国内运营商)** → 已用 Custom Domain `xhslicense.maxwellii.com` 绕过
9. **Electron 32 WebContentsView setBounds 在 macOS 不生效** → 改用 `<webview>` 标签

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
