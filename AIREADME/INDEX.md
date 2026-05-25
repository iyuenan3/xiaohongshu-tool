# 小红书自运营系统 · AIREADME
> Electron+Chromium 桌面小红书浏览器 · AI 侧边栏走自营 newapi 中转操作 14 工具 · 软件买断 + LLM 月费 ｜ 生命周期: active (pre-launch, 卡 M8 公测)
> last-synced: e18d0d4 · 2026-05-25

<!-- 路由器：只指路，不放实质内容。INDEX 不列自己。符号：✅已填 / ⚑占位 / —N/A -->

## 状态
| 文件 | 状态 | 摘要 |
|---|:--:|---|
| CORE | ✅ | 身份 / non-goals / 红线 |
| RELATIONS | ✅ | 消费 newapi-proxy (LLM) + doubleL-license (license 服务已建成、入部署) |
| SPEC | ✅ | license 端点+鉴权/SignedToken+状态机 + LLM 契约 + 14 工具 + 错误码 |
| ARCHITECTURE | ✅ | 组件+数据流 + 进程/CDP握手 + 客户端模块·数据模型 + 工作流引擎 + 禁改项 |
| DEPLOYMENT | ✅ | 客户端无证书发布 + license 迁 alicloud-bj (Hono，代码迁 doubleL-license，砍 CF) |
| PRD | ✅ | AI 代运营 + 代付 LLM + 买断商业模式 |
| ROADMAP | ✅ | Now=license 入部署 (服务已建成)；Next=M8 公测 |
| CONVENTIONS | ✅ | 文档驱动 / npm nuke / git 规约 |
| DECISIONS | ✅ | ADR-001~013 (路线A / CDP / D6 方案X / D9 B' / 迁 bj / doubleL-license monorepo / 砍CF+轮换密钥 / 鉴权=访问令牌) |
| MEMORY | ✅ | chromium 锁 / DPI / newapi 孤儿 等坑 |
| CHANGELOG | ✅ | v0.2.0 → v0.7.1 |

## 按任务读
- 跨项目了解 → CORE + RELATIONS (+ SPEC 若要集成 license/LLM)
- 改架构 → ARCHITECTURE + DECISIONS
- 部署 / 运维 → DEPLOYMENT
- 加功能 → PRD + ROADMAP + CONVENTIONS
