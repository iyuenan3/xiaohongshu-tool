# DECISIONS — 小红书自运营系统
<!-- ADR，append-only，只追加不改历史。运行时事故→MEMORY。 -->

## ADR-001 · 路线 A 完全本地化 (剥离卖 token) · 2026-05-16
- Problem: 卖 token 的核心矛盾 (API key 不能下发 / 防破解 / 卖软件) 纠缠不清。
- Constraint: 个人维护，运维成本要低。
- Decision: 砍服务端反代，完全本地化 (除一个 license 激活服务)；卖 token 剥离为独立项目。
- Alternatives (否决): 服务端反代卖 token (本质是 SaaS 而非软件)。
- Tradeoff: 工程量 −60% / 运维归零 / 风险隔离；放弃 token 利润。

## ADR-002 · CDP attach 架构 · 2026-05-16
- Problem: Electron UI 与小红书浏览器要共享 Chromium 实例 + cookies，Go (go-rod) 要能操作小红书 page。
- Decision: Electron `--remote-debugging-port` 暴露 CDP，go-rod attach 同实例。
- Alternatives (否决): go-rod launcher 模式开独立 Chromium (cookies 不共享 / 双进程)。
- Tradeoff: attach 不能 `Target.createTarget` (Electron 限制) → 必走 selectAttachedPage 复用 page，且诸多 occlusion 节流坑 (见 ARCHITECTURE 禁改 + MEMORY)。

## ADR-003 · 单小红书账号绑定 · 2026-05-16
- Problem: 多账号 = 风控关联风险 + 工程复杂。
- Decision: 1 激活码绑 1 小红书 user_id；换绑找客服；不限设备数。
- Alternatives (否决): 设备数绑定 (改用账号绑定替代)。
- Tradeoff: 多账号需多激活码；简化工程 + 降风控。

## ADR-004 · 所有交互走 AI 聊天 · 2026-05 (M4 polish)
- Problem: 工具面板 (12 个 MCP 工具按钮 + form) UX 复杂 (参数表单 / 结果格式 / 布局)。
- Decision: 控制台只留 hero + 提示，所有工具调用走 ChatSidebar → AI → tool_calls。
- Alternatives (否决): ToolPanel 直接调用 UI (用户明确否决)。
- Tradeoff: 依赖 LLM 选对工具 (靠 system prompt + 内测日志兜底)。

## ADR-005 · 无证书发布 · 2026-05
- Problem: 无 Apple/Win 代码签名，用户装时被 Gatekeeper / SmartScreen 拦。
- Decision: ad-hoc codesign + dmg 内附文本教程教用户 `xattr -cr` 解 quarantine。
- Alternatives (否决): 买证书 (成本 / 流程)。
- Tradeoff: 用户首装手动一步；macOS Tahoe 堵了多条绕过法 (见 MEMORY)。

## ADR-006 · 更新策略方案 C (提醒+客服，非 auto-update) · 2026-05-17
- Problem: 完全本地化 + 私仓下，auto-update 分发渠道受限。
- Decision: 启动 8s 查 `/version`，有新版弹"联系客服"dialog (非自动下载)。
- Alternatives (否决): 公仓 release (拒公开) / R2 (要绑卡) / Worker 中转 (free tier 超时)。
- Tradeoff: 升级靠客服私发；零基础设施成本。v0.3.1 老用户拿不到提醒 (见 MEMORY)。

## ADR-007 · D6 LLM Gateway = 方案 X (一码一 newapi user + 绑 Subscription) · 2026-05-19
- Problem: BYOK 门槛高 → 走"代付 LLM"；newapi token 无原生月度 reset。
- Decision: 一激活码 = 一 newapi user + 绑 XHS Plan (Subscription 原生月度 reset, user 级)，Worker 零 cron。
- Alternatives (否决): 方案 B (一码一 token + Worker cron reset，复杂)。
- Tradeoff: 利用 newapi 原生能力；但 per-user provisioning 脆 + 删 user 留孤儿 → 后被 ADR-008 取代。

## ADR-008 · D9 → B' token-only (取代方案 X) · 2026-05-22
- Problem: 方案 X 的 per-user provisioning 脆弱 + 删 user 不级联留孤儿 + suspend/resume 堆 sub。
- Constraint: 承重事实 = newapi token 无原生周期重置，reset 是 user-subscription 级 (官方 schema 复核)；零存量客户 (5 首批码未分发)。
- Decision: 弃 subscription；所有客户 token 挂**一个专用 `xhs-pool` user** + per-token `remain_quota` + 自建 node-cron 月度重置。本质 = 复活当年被否的方案 B。
- Alternatives (否决): 继续方案 X (孤儿痛) / 挂 admin id=1 (隔离失效 → 改专用 pool user)。
- Tradeoff: 孤儿结构性消失 + provisioning/suspend 大简 + KV 单一真相源；代价 = 自维护 cron + pool user 须 unlimited 当"伞" + 跟 friends 方案 X 靠 group 隔离并存。

## ADR-009 · license server hosting 迁 alicloud-bj (CF Worker → Node 同机 newapi) · 2026-05-23
- Problem: Worker→newapi 跨境 (CF Tunnel + 自签 cert) 是 D6 最痛运维；newapi v1 退役、v2 重部署到 bj。
- Decision: license 服务从 CF Worker 迁 alicloud-bj 的 Node 服务 (移植 worker/：KV→SQLite / Workers Cron→node-cron)，跟 newapi 同机，出站调 `new-api:3000` 本机。
- Alternatives (否决): 留 Worker (路径② 跨境痛) / 只搬发码 (没解② 痛) / CF 前置代理回源 bj (又跨境)。
- Tradeoff: 路径② 变本机 (溶解 tunnel/cert)；代价 = 路径① 客户端走国内 IP/域名 (DPI/备案，跟 LLM 同预案) + 需发新客户端 (零存量无痛) + 单点可用性 (留 CF `/version` 兜底)。

## ADR-010 · vendored xiaohongshu-mcp fork 策略 · 2026-05-16
- Problem: xiaohongshu-mcp 是外部上游，要改造 (加 `--cdp-endpoint` 等)；保留嵌套 .git commit 不顺、整目录 ignore 改造不跟踪。
- Decision: 删 `xiaohongshu-mcp/.git`，作顶层子目录跟踪；baseline 首个 commit，后续只显改造 diff，仅 ignore 其 build 产物。
- Tradeoff: 上游更新需手动 merge；改造历史干净可见。

## ADR-011 · license 代码迁专用 monorepo `doubleL-license` (取代 ADR-009「代码归 xhs repo」) · 2026-05-24
- Problem: 第 2 个发码工具 (同形：发激活码 + 中转 LLM key) 即将开做；license 逻辑要在多工具间复用，散在各产品 repo 会漂移 + 安全补丁易漏。
- Decision: 新建 **sibling git repo `doubleL-license`** (跟 xiaohongshu-tool / newapi-proxy 同级)：`packages/license-core`(Hono+SQLite+node-cron+newapi-client+Ed25519 共享引擎) + `apps/<tool>-license`(workspaces)。每工具独立容器 / SQLite / `.env` / keypair / newapi 租户(`<tool>` group + `<tool>-pool` user)，edge Caddy 按 path 前缀分发。
- **抽取时机**: 先把 `apps/xhs-license` 做成完整单 app 跑通，`license-core` 等 **tool2 真启动**(2 个真实案例)再抽 — 避免 1 案例上提前 bake 错抽象 (同 newapi-proxy edge「1 消费方暂不抽节点」先例)。
- Alternatives (否决): 留 xhs repo (ADR-009，多工具下漂移) / 共享 npm 包 + 各产品 repo (跨 repo 发布流水线开销大、版本漂移) / 复制模板 (必然漂移 + 安全补丁易漏)。
- Tradeoff: 单一 core 改一处生效 + 安全补丁全覆盖 + 契合多工具平台；代价 = license 代码与产品 repo 分家 (耦合面窄：仅端点 URL + 签名公钥) + 需 workspace tooling。⚠️ 每工具一 group 跟 newapi-proxy「单 default group」冲突 + 限速 group 维度 → 转达确认。

## ADR-012 · license hosting 收尾：砍 CF 全落 bj + 轮换签名密钥 + Hono 栈 (精化 ADR-009) · 2026-05-24
- Problem: ADR-009 拟「留 CF 极简 `/version` 兜底」+「移植 `worker/` 复用旧密钥」，定稿审核发现两点站不住。
- Decision (3 项):
  1. **砍 CF 全落 bj**: 客户端无 failover 代码 + CF 只兜最不关键的 `/version` + 已激活客户端本地缓存 license 365 天足抗 bj 短宕 → 单源 bj 更干净 (version 元数据也单源不漂移)。
  2. **轮换签名密钥**: 旧 `SIGNING_PRIVATE_KEY` 明文进 git (`worker/DEPLOY.md:65`) → 迁移时换全新 Ed25519，新公钥 bake 进迁后必发的新客户端 (验签格式不变、公钥值变 → 客户端须重 bake)。
  3. **栈**: Hono + @hono/node-server + better-sqlite3 + node-cron；provisioning 走 **password→cookie impersonation** (持 pool 密码非 root admin) + `assertXhsToken` 护栏 (撤回「pool 访问令牌原生隔离」伪命题)。
- Alternatives (否决): 留 CF /version 镜像 (双源漂移、兜错对象) / 复用旧密钥 (已泄露) / Express｜裸 http (离现有 Web 标准 handler 远、不能双 runtime)。
- Tradeoff: 单点 bj 可用性靠客户端本地缓存 + SQLite 异地备份兜 (备份目标迁前必落)；客户端 cert 信任改造 (主进程 `net.fetch` 需 `setCertificateVerifyProc` + 硬编码新 IP) 比「改 base url」工作量大。

## ADR-013 · license 鉴权实测定稿 = 账号访问令牌 (修正 ADR-012 的 impersonation) · 2026-05-25
- Problem: ADR-012 定 provisioning 走 password→cookie impersonation (并撤回「访问令牌」方案为伪命题)。
- Decision: 2026-05-25 用真 newapi 实测推翻——服务持**专用非 admin 账号 (`xiaohongshu-tool` id=4) 的访问令牌** (`Authorization: Bearer` + `New-Api-User: <id>`) 即可建带 `remain_quota`+`expired_time` 上限、锁 `auto-llm` 的子 token，并 PUT 改额 / DELETE，全 PASS (还实调 LLM 出真实回复)。**采用访问令牌**：比 impersonation 更简 (无 login/cookie/密码存储/过期)，且 newapi UserAuth 天然把令牌锁在该账号名下 (隔离不靠密码)。
- Alternatives (否决): password→cookie impersonation (ADR-012, 多一层 login + 存密码 + cookie 过期) / 共享 root admin token (爆炸半径大)。
- Tradeoff: 服务只持一个非 admin 账号令牌；root admin 仅一次性 setup 用 (建账号/设额度)，不进服务。`doubleL-license` 已按此实现 + 全生命周期 e2e 验证 (commit 5aeecd9 / 284b167)。

## 待拍板 (pending，非 ADR → 详见 ROADMAP)
- D3 产品名 / 域名 · D5 客服渠道 · D7 mac Intel build · D8 仓库公私 (均 M8 公测前)。
