# 小红书自运营系统 · 项目内 Claude 指引

> 本文档是给 Claude Code 看的项目配置。详细产品/技术信息见 `PRD.md` / `SPEC.md` / `ROADMAP.md` / `INFRA.md`(后者已 .gitignore)。

## 一句话

基于 Electron + Chromium 内核的小红书桌面浏览器，内嵌 `xiaohongshu-mcp` Go 服务，AI 侧边栏走**自营 newapi 中转**操作 14 个小红书业务工具 (12 Go + 2 renderer 本地)。**软件一次性买断 + LLM 月续费**、激活码授权、无证书发布。

## 路线（不要再讨论）

**路线 A · v0.6 升级版** · 完全本地化客户端 + 自营 LLM 中转 + 无证书发布。
- 客户端: BYOK 入口默认 UI 隐藏 (dev 模式暗号解锁逃生口), 默认走自营 newapi 中转
- 服务端: Cloudflare Worker (激活, M3 启动) + 自营 newapi 中转站 (LLM 网关, M6 启动, 部署在 alicloud-sh)
- 不卖 token (已剥离独立项目); 不申请 Apple/Win 代码签名 (无证书)
- 商业模式: 软件一次性买断 + LLM 服务费月续 (维护者运营时定价, 具体不写文档); 未续费分级停用 (15 天软停 → revoke 硬停)
- newapi `XHS Plan` 原生 monthly reset 等同于 "自动续费"; 客户没付月费 → Maxwell 手动 `/admin/suspend` 停 token

## 目录结构

```
xiaohongshu-tool/
├── PRD.md                     v0.6 产品需求 (+§6.7 D6 中转架构)
├── SPEC.md                    v0.3 技术规格 (+§12.10 D6 中转技术 spec)
├── ROADMAP.md                 v0.5 路线图 (+§13 M6 D6 实施)
│                              注: HTML 已删 (v0.5 起 md 为唯一源)
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

# 跑 E2E 测试 (dev 在跑 + license 已激活 前置)
node tests/e2e/run-all.mjs

# 触发 GitHub Actions build (workflow_dispatch 模式)
gh workflow run "Build macOS" --ref main -f release_tag=v0.3.2 --repo iyuenan3/xiaohongshu-tool
gh workflow run "Build Windows" --ref main -f release_tag=v0.3.2 --repo iyuenan3/xiaohongshu-tool
# release_tag 留空 → 只 build artifacts 不发 Release (临时测试)

# 发激活码 (worker admin CLI)
cd worker && WORKER_URL="https://xhslicense.maxwellii.com" \
  ADMIN_TOKEN="<INFRA.md>" node scripts/xhs-license.mjs issue -c 1 -n "备注"

# 触发"发现新版本"提醒 (v0.3.2 起客户端启动 8s 后调 /version)
cd worker && ./node_modules/.bin/wrangler kv key put "config:latest_version" "0.x.y" \
  --namespace-id=a42560054b8241e89ddbe9317d35af21
# 顺手改 release_notes (改这俩不需要 deploy worker, 立即生效)
cd worker && ./node_modules/.bin/wrangler kv key put "config:release_notes" "..." \
  --namespace-id=a42560054b8241e89ddbe9317d35af21
```

## 🎯 里程碑 (M) — 工程阶段

> M = Milestone, 按时间推进的开发阶段. 跟 D (决策) 是不同维度.

| Mx | 状态 | 内容 |
|---|---|---|
| M1 | ✅ | PoC (CDP attach + publish_content E2E 真实发到小红书) |
| M2 | ✅ W3-W5 | AI 侧边栏 + Tool Calling + 11 工具 + SQLite + 频率护栏 |
| M3 | ✅ | 商业化 (Worker + KV + Custom Domain `xhslicense.maxwellii.com` + 客户端激活 E2E) |
| M4 | ✅ | macOS dmg 打包 (identity:null 无证书 + Windows nsis 跨平台 build) |
| M5 | ✅ v0.2.x~v0.3.x | polish — 4-tab UI + 智能素材库 + vision tag + 联网搜索 + 网页管理后台 + 7 次 mac 打包流水线 fix + E2E 黑盒测试 (subagent 176/176) |
| M6 | ✅ v0.6.0 (2026-05-20) | **D6** LLM Gateway ship — newapi 中转 + Cloudflare Tunnel `llm-cf.maxwellii.com` + 真实 E2E (火山方舟 doubao) + 5 个首批正式码已发 |
| M7 | ✅ P1+P2 v0.7.0 / 🟡 P3 待启动 | 工作流模块 — 引擎 + 4 模板 (👍/⏰/📊/🔍) + 控制台 3 段 + RiskWarningDialog. P3 polish (5th 签到模板 + step log + callTool timeout) 待启动 |
| M8 | 🟡 待启动 | 公测发售 — 卡 **D3** 产品名 + **D5** 客服渠道 |

## 📦 近期 Ship 时间线 (2026-05-17 ~ 今)

| 日期 / tag | 内容 |
|---|---|
| 2026-05-17 v0.3.2 | Worker `/version` + 联系客服 dialog / 内测日志体系 / search_feeds 卡死 fix |
| 2026-05-20 v0.6.0 | M6 D6 LLM Gateway + publish_content TipTap 修 + mac install.command 修 + Help 页重写 + Settings 弹框可滚 |
| 2026-05-20 v0.7.0 | M7 P1+P2 工作流 ship — 4 模板 + WorkflowEditor/List/RunHistory/RiskWarning + scheduler routes 修单数 user |
| 2026-05-20 v0.7.1 | license heartbeat 24h→1h + ±5min jitter + CODE_NOT_FOUND/REVOKED 锁 UI + admin UI 3 列时间 + check_login_status 真昵称 |
| **2026-05-21 工作分支** (3 commits 未 tag/push) | 🎛 独立 xhs 窗口 ship (helper-popup 路径绕 chromium retina lock) — 主控仍 1280×800 锁 (popup 化失败接受), 详见 [[project_m7_workflow]] / [[decisions_macos_tahoe_chromium]] |

## 🟡 待办

- 🗓 **2026-05-21 10:30 D9 会议**: 讨论"不创建 newapi user, 只创建令牌挂 admin 账号"方案 (动机见 [[feedback_newapi_user_id_orphan]])
- **M7 P3 polish**: 5th 签到模板 (需 Go MCP `list_following`) + dev cron + step log + failed notification + callTool timeout/取消按钮
- **朋友升级 v0.7.1** (win, revoke 链路 E2E 验证)
- **工作分支 commits**: 攒 v0.7.2 tag + push, 还是继续累积?

## 🎲 决策清单 (D) — 议题

> D = Decision, 待拍板或已拍板的方向议题. 跟 M (里程碑) 是不同维度.

| Dx | 议题 | 状态 |
|---|---|---|
| D1 | 售价 | ✅ ¥399 + 客服议价 |
| D2 | 试用版 | ✅ 无 |
| D3 | 产品名 / 域名 | ⏳ 影响品牌 (M8 公测前) |
| D4 | 法律主体 | ✅ 个人名义 |
| D5 | 客服渠道 | ⏳ 影响压力 (M8 公测前) |
| D6 | LLM Gateway 中转站 | ✅ 方案 X + M6 ship (2026-05-19), 卡 Cloudflare Tunnel (已 deploy) |
| **D7 mac Intel build** | macOS quota 倍率 10x 卡 queue | ⏳ |
| **D8 仓库公私** | private 现状 (用户已拒改 public) | ⏳ (临时维持 private) |
| **更新策略** | 不 auto-update, Worker /version + 联系客服 dialog (方案 C) | ✅ 已实施 (2026-05-17) |

## 部署事实（2026-05-19, v0.6.0 Worker deploy, 客户端未 ship）

- Worker URL（fallback）：`https://xhs-license.liyuenan93.workers.dev`
- Custom Domain（客户端默认）：`https://xhslicense.maxwellii.com`
- Worker 端点 (v0.6 D6 加): POST/GET /admin/codes · POST /admin/revoke · POST /admin/rebind · **POST /admin/suspend · POST /admin/resume · GET /admin/overdue** · POST /activate (加 status+llm) · POST /heartbeat (加 status+llm) · GET /version · **GET /quota?code&sig** · GET /admin
- KV namespace ID：`a42560054b8241e89ddbe9317d35af21`
- KV config keys (`config:*`): `latest_version`(0.3.2) / `min_version`(0.1.0) / `support_contact`(微信:maxwellii...) / `release_notes`(v0.3.2 改动列表)
- **Worker Secrets (8 项 M6 注入完毕)**：
  - M3: SIGNING_PRIVATE_KEY + ADMIN_TOKEN
  - M6: NEW_API_BASE_URL + NEW_API_ACCESS_TOKEN + NEW_API_USER_ID=1 + XHS_PLAN_ID=2 + XHS_NEWAPI_GROUP=xhs + XHS_LLM_BASE_URL=`https://139.196.157.57/v1`
  - 真值备份: `~/.secrets/xhs-secrets.txt` (chmod 600, gitignored)
- **newapi 资源 (M6 setup)**: xhs group ratio=1 + XHS Plan id=2 total_amount=68493151 (placeholder ¥1000/月)
- 首发码发码 CLI：`worker/scripts/xhs-license.mjs`，详见 `worker/DEPLOY.md`
- GH Release v0.3.2: https://github.com/iyuenan3/xiaohongshu-tool/releases/tag/v0.3.2 (含 mac arm64 dmg/zip + win Setup.exe, Intel x64 still in queue)
- **客户端 v0.6 working tree**: license.ts/byok.ts/Settings.tsx/ChatPanel.tsx/agent.ts/main/cert-error/preload 全改完, typecheck 通过, 未打 tag

## 多租户隔离 (newapi 共享租户, 2026-05-19 起)

newapi 实例 `https://llm.maxwellii.com` 同时服务 xhs / lijunfeng / maxwell 自用. **xhs 只管 `xhs-` 前缀资源**:
- 所有 Worker newapi 写操作前 `assertXhsTenant(env, userId)` 验证 user.username 以 `xhs-` 开头
- 不动: maxwell-homepage / 测试 / liyuenan / lijunfeng / VIP Plan(id=1) / default group / vip group
- 详见 SPEC §12.10.13 + memory [[feedback_pitfalls]] 坑 24

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
- 文档驱动：大改方向后 3 份 md (PRD/SPEC/ROADMAP) + INFRA.md 同步更新 (HTML 自 v0.5 已删, md 为唯一源)

更多细节见 `~/.claude/projects/-Users-maxwell-Desktop-Claude-Project-xiaohongshu-tool/memory/`。
