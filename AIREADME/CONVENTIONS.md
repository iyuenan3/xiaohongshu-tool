# CONVENTIONS — 小红书自运营系统
<!-- 本项目特有约定。共享/通用基线只链过去，不抄。 -->

## 命名
- newapi user/token：`xhs-<激活码末9字符小写>` (含中间 dash，e.g. `xhs-wx2a-bcdf`，13 字符 ≤ newapi max 20)；display_name `XHS-<末4字符大写>`。
- 错误码前缀约定见 [SPEC](./SPEC.md) 错误码节 (服务端 `code` 不带前缀，客户端转 i18n 补 `LICENSE_`)。
- git commit 必带 `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。

## 偏好模式
- **文档驱动**：大改方向后同步 `AIREADME/` (跨项目 AI 真相源，doc-driven) + CLAUDE router；密钥/凭证真值 → `~/.secrets` + 容器 `.env` (gitignored)。自 2026-05-25 根 `PRD/ROADMAP/SPEC` 已蒸馏折叠进 AIREADME (HTML 更早删)。
- **renderer 本地工具模式**：纯前端工具 (search_local_assets / web_search) schema 加 `http:null` + `ChatPanel.callTool` special-case，不走 Go MCP。
- **Edit 中文 / 非 ASCII 先 Read 精确 copy-paste**：避免全角 `（）：` 与半角混淆导致 String not found。
- **内测日志体系**：renderer `rlog` fire-and-forget + main 启动 banner + agent 10 处埋点 → 客服收一份导出 log 即可复盘 LLM 工具决策链。

## 禁用模式
- **不反复 npm install/uninstall** (实测 10+ 次破坏 node_modules transitive dep)；清依赖直接 `rm -rf node_modules package-lock.json && npm install` 一次装全。
- **dmg 内嵌资源不放 `app/build/`** (被 .gitignore 排除)；放 `app/dmg-resources/`。
- **不 `git add .claude/`** (运行时锁文件，已 gitignore)。
- **不批量扫 `GET /api/user/?page_size=1000`** (多租户会扫到别人)。

## 测试
- 分层：单元 (Vitest — license 加解密 / 频率护栏 / token 验签) · 集成 (Playwright + Go 子进程) · 手动验收 (14 工具 + 激活流程 + 跨平台打包 checklist)。**不做覆盖率指标，关注关键路径不回归**。
- E2E 套件 `tests/e2e/*.mjs` (subagent 黑盒方法论)；报告见根 `TESTING.md` / `TEST_REPORT.md` (人面向文档，不迁入 AIREADME)。

## 日志
- 工具 `electron-log`；文件 `userData/logs/{main,renderer,go}.log`，单文件 ≤10MB 保留 5 份；dev=debug / prod=info。
- **redact 列表**：`api_key` / `apiKey` / `token` / `password` / `cookies` / `sk-***` / `Bearer ***` — 不入日志。

## 安全约定
- Renderer `contextIsolation:true` + `nodeIntegration:false`；Go 服务仅听 `127.0.0.1` 不对外。
- LLM provider baseURL 必须 `https://`。
- 公钥写源码可提交；私钥 / ADMIN_TOKEN / 访问令牌等真值仅 `~/.secrets` + 容器 `.env` (红线见 CORE)。
- 敏感操作弹确认 + 频率护栏 (红线见 CORE，实现见 ARCHITECTURE)。

## Git 规约
- **不主动 commit，绝不 push 远程** (用户全局 + 项目规则)；docs 直提 `main` 是既有模式。
- vendored `xiaohongshu-mcp/` 删原 `.git` 嵌入顶层跟踪 (仅 build 产物 gitignore)。
