# 小红书自运营系统 · 项目内 Claude 指引 (router)

> 本文件是**路由器**：状态 + 去哪读 + 红线 + 常用命令 + 维护责任。
> **设计 / 架构 / 部署 / 历史 / 决策细节 → `AIREADME/`** (AI 真相源；根 `SPEC.md` 104KB 附录已蒸馏折叠进 AIREADME、git rm)；密钥/凭证真值 → `~/.secrets/xhs-secrets.txt` + 容器 `.env` (均 gitignored)。

## 一句话 + 当前状态

基于 Electron + Chromium 内核的桌面小红书浏览器，内嵌 `xiaohongshu-mcp`(Go)，AI 侧边栏走**自营 newapi 中转**操作 14 工具 (12 Go + 2 renderer)。软件买断 + LLM 月费、激活码授权、无证书发布。

- **生命周期**：active (pre-launch)。M6 LLM Gateway + M7 工作流已 ship (→ v0.7.1)。
- **当前焦点**：**v0.8.0 xhsPilot 首个正式版已发版** (2026-05-26)。license 上线 bj 后发版前置全清 → 发版：证书 pinning(双链路验证) + D3 命名 xhsPilot + D5 客服二维码 + admin config 端点 → push + GH Actions build → Release v0.8.0 = arm64 mac dmg/zip + Windows exe + auto-update yml，可分发 (github.com/iyuenan3/xiaohongshu-tool/releases/tag/v0.8.0)。license 服务 `https://39.96.12.136:8888/xhs-lic/` 生产可用 (D9 B' token-only + 访问令牌鉴权；ADR-011/012/013；`doubleL-license` private repo)。**剩** = mac x64(Intel) 后补 (GH Intel runner 排队卡 8h、workflow 保留 x64) + 设 bj `latest_version=0.8.0` + 测安装包 + CF 退役(仅当有 v0.7.1 老用户)；shell `NEWAPI_*` stale 交用户清。决策见 memory `project_pending_decisions`「2026-05-26 发版」节，部署/pinning 见 `reference_infra`。
- **M8 公测**：D3(xhsPilot) + D5(客服二维码) 已拍、v0.8.0 已发 → 公测前置基本就绪。

## 📂 加载路由 (任务 → 读哪个)

| 任务 | 读 |
|---|---|
| 了解身份 / 红线 | `AIREADME/CORE.md` |
| 改架构 / 防偏差 | `AIREADME/ARCHITECTURE.md` (禁改项) + `DECISIONS.md` |
| 部署 / 运维 | `AIREADME/DEPLOYMENT.md` |
| 对外契约 (license 端点 / LLM / 14 工具) | `AIREADME/SPEC.md` |
| 加功能 / 产品意图 | `AIREADME/PRD.md` + `ROADMAP.md` + `CONVENTIONS.md` |
| 历史 / 版本 | `AIREADME/CHANGELOG.md` |
| 决策为何 (ADR-001~013) | `AIREADME/DECISIONS.md` |
| 踩坑 / 事故 | `AIREADME/MEMORY.md` |
| 依赖 / 跨项目 | `AIREADME/RELATIONS.md` (消费 `../newapi-proxy/AIREADME/`) |
| 持久知识主源 | `~/.claude/projects/-Users-maxwell-Desktop-Claude-Project-xiaohongshu-tool/memory/` (16 文件，耐久) |

## 🚨 红线 (完整见 `AIREADME/CORE.md`「绝不」)

- 仅 **1 个小红书账号** (1 码绑 1 user_id)；频率护栏软提示不硬拦；敏感操作弹确认。
- **newapi 多租户**：只管 `xhs-` 前缀资源，写操作前 `assertXhsTenant`/`assertXhsToken` 护栏，绝不动其他租户。
- **key/secret/PII 不进代码 / git / AIREADME** (真值仅 `~/.secrets` + 容器 `.env`)。
- **架构禁改项** (4 个 chromium switch / `minimize` 不 `hide` / GET 不带 body / 主控 1280×800 锁 等) → `AIREADME/ARCHITECTURE.md`。

## 🔧 常用命令

```bash
# 启动开发 (自动 build Go → vite+electron → spawn Go → 开 xhs 窗口)
cd app && npm run dev
# 仅重 build Go (改 Go 代码后)
cd app && npm run build:go
# TS 类型检查
cd app && npm run typecheck
# 查 SQLite
sqlite3 "$HOME/Library/Application Support/xhs-app/app.db" ".schema"
# 杀残留进程 (UI/Go 卡死时)
pkill -f electron-vite; pkill -f "Electron.app/Contents/MacOS/Electron"; pkill -f xiaohongshu-mcp
# E2E (dev 在跑 + license 已激活 前置)
node tests/e2e/run-all.mjs
# 触发 GH Actions build (workflow_dispatch)
gh workflow run "Build macOS" --ref main -f release_tag=v0.x.y --repo iyuenan3/xiaohongshu-tool
```
> ⚠️ 发激活码 / `/version` 等 license 运维命令随 hosting 迁 alicloud-bj 变化中；旧 Cloudflare 命令见 git 历史，新落点见 `AIREADME/DEPLOYMENT.md`。

## 🔁 维护责任 (什么变 → 更新哪个)

部署/环境变 → `DEPLOYMENT` · 重大决策 → `DECISIONS` (ADR append) · 出事/踩坑 → `MEMORY` (append) · release/里程碑 → `CHANGELOG` (append) · 接口变 → `SPEC` · 结构/禁改变 → `ARCHITECTURE` · 优先级变 → `ROADMAP` · 文件增减/状态变 → `INDEX` (+ `last-synced` SHA)。大改方向后 AIREADME + 持久 memory 同步 (本项目 doc-driven)。

## Git 规约

- 每 commit 必含 `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。
- **不主动 commit；绝不 push 远程** (用户全局 + 项目规则)。docs 直提 `main` 是既有模式。
- vendored `xiaohongshu-mcp/` 已删原 `.git` 嵌入顶层跟踪。

## 协作风格 (用户特定)

- 高执行力，完成阶段立刻问"下一步推什么"；决策题选择题为主 (2-4 选项 + 标"(推荐)")。
- 不主动"要不要休息"停下，凌晨 3 点后再询问；任何不清楚先提问，完全理解再执行。
- 错误处理先 grep dev log 找现场，不凭直觉猜。

## 元信息

- repo `iyuenan3/xiaohongshu-tool` (private)，分支 `main`，git user `Maxwell`。
- 组件：`app/` (Electron 主体) · ~~`worker/`~~ (旧 CF license server **2026-05-25 P-E 删** — 已迁 `doubleL-license` + 生产上线，git 历史留) · `xiaohongshu-mcp/` (vendored 上游 Go MCP) · `x-mcp/` (参考代码，gitignored)。
- 导航：`AIREADME/INDEX.md` (路由) · memory `MEMORY.md` (索引)。
