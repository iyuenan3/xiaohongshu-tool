# CONVENTIONS — 小红书自运营系统
<!-- 本项目特有约定。共享/通用基线只链过去，不抄。 -->

## 命名
- newapi user/token：`xhs-<激活码末9字符小写>` (含中间 dash，e.g. `xhs-wx2a-bcdf`，13 字符 ≤ newapi max 20)；display_name `XHS-<末4字符大写>`。
- 错误码前缀约定见 `../SPEC.md` §9.1。
- git commit 必带 `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。

## 偏好模式
- **文档驱动**：大改方向后同步 PRD/SPEC/ROADMAP (+ INFRA gitignored)；自 v0.5 起 md 为唯一文档源 (HTML 已删)。本 `AIREADME/` 为跨项目 AI 真相源。
- **renderer 本地工具模式**：纯前端工具 (search_local_assets / web_search) schema 加 `http:null` + `ChatPanel.callTool` special-case，不走 Go MCP。
- **Edit 中文 / 非 ASCII 先 Read 精确 copy-paste**：避免全角 `（）：` 与半角混淆导致 String not found。
- **内测日志体系**：renderer `rlog` fire-and-forget + main 启动 banner + agent 10 处埋点 → 客服收一份导出 log 即可复盘 LLM 工具决策链。

## 禁用模式
- **不反复 npm install/uninstall** (实测 10+ 次破坏 node_modules transitive dep)；清依赖直接 `rm -rf node_modules package-lock.json && npm install` 一次装全。
- **dmg 内嵌资源不放 `app/build/`** (被 .gitignore 排除)；放 `app/dmg-resources/`。
- **不 `git add .claude/`** (运行时锁文件，已 gitignore)。
- **不批量扫 `GET /api/user/?page_size=1000`** (多租户会扫到别人)。

## 测试
- E2E 套件 `tests/e2e/*.mjs` (subagent 黑盒方法论)；报告见根 `TESTING.md` / `TEST_REPORT.md` (人面向文档，不迁入 AIREADME)。

## Git 规约
- **不主动 commit，绝不 push 远程** (用户全局 + 项目规则)；docs 直提 `main` 是既有模式。
- vendored `xiaohongshu-mcp/` 删原 `.git` 嵌入顶层跟踪 (仅 build 产物 gitignore)。
