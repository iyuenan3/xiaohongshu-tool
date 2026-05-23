# CHANGELOG — 小红书自运营系统
<!-- 版本史，倒序，append-only。为何→DECISIONS；未来→ROADMAP；commit 流水→git；踩坑→MEMORY。 -->

## unreleased · 2026-05-22~23
- Changed: D9 — LLM 中转 newapi 实现 方案 X → **B' token-only** (ADR-008)；license server hosting **CF Worker → alicloud-bj Node** (ADR-009)。文档 (PRD/SPEC/ROADMAP/CLAUDE/INFRA) 已同步；代码重写待 newapi-proxy M1。

## v0.7.1 · 2026-05-20
- Changed: license heartbeat 24h→1h + ±5min jitter。
- Fixed: CODE_NOT_FOUND / REVOKED 触发 emitChange 锁 UI (修 admin revoke 后客户端不感知的安全漏洞)；check_login_status 返真实昵称；admin UI 拆 3 列时间。

## v0.7.0 · 2026-05-20
- Added: **M7 工作流模块** — 引擎 WorkflowScheduler + 4 模板 (👍 daily_like_comment / ⏰ scheduled_publish / 📊 daily_data_snapshot / 🔍 keyword_like_comment) + 控制台 3 段 (常用命令/工作流/会话) + WorkflowEditor + RiskWarningDialog + 风控加固。
- Changed: 联网搜索切 DuckDuckGo (sogou `div.vrwrap` 失效)。

## v0.6.0 · 2026-05-20
- Added: **M6 D6 LLM Gateway 中转** (方案 X：一码一 newapi user + 绑 XHS Plan) + 软停/硬停分级 + 多租户隔离护栏 + `GET /quota` + Cloudflare Tunnel `llm-cf.maxwellii.com`。
- Changed: 客户端中转默认 + dev 暗号 BYOK 逃生口；帮助页重写；Settings 弹框可滚。
- Fixed: publish_content TipTap。

## v0.3.2 · 2026-05-17
- Added: Worker `GET /version` + 联系客服 dialog (方案 C 更新策略，ADR-006)；内测日志体系 (main banner + renderer rlog + agent 10 处埋点 + 导出)。
- Fixed: search_feeds 卡死 (go-rod `.Context` 擦 timeout)。

## v0.3.1 · 2026-05-17
- Fixed: 6 个 E2E bug，含 Critical B-001 license 状态 push 通道 (LicenseManager.onChanged → webContents.send)。
- Changed: 工具计数文档同步 (11→14)。
- Removed: xhs_generate_cover (从未实现，文档同步删)。

## v0.3.0 · 2026-05-17
- Added: 联网搜索 `web_search` (隐藏 BrowserWindow + 搜狗 DOM 抓取，零外部依赖)。

## v0.2.0 ~ v0.2.7 · 2026-05-16~17
- Added: 4-tab UI 重构 (ConsolePane + ChatPanel + ConversationList + AssetLibrary + CommandPalette) + 智能素材库 (vision 打 tag) + 📎 附件 + `search_local_assets` + 会话 CRUD (SQLite)。
- Changed: license 改文件 base64 存储 (去 macOS Keychain 弹窗，老 license 失效需重激活)。
- Fixed: mac 打包系列 — ad-hoc codesign 解"已损坏" / 单 arm64 native rebuild (electron-builder install-app-deps) / 补 electron-vite build step / dmg 内嵌首装引导 / nsis exe ASCII 命名。
