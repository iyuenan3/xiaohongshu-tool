# ROADMAP — 小红书自运营系统
<!-- 节奏。不放可执行 TODO 颗粒(→项目 TODO / worklog)，只放方向。 -->

## Now（当前焦点）
- **license server 迁 alicloud-bj — 服务已建成、入部署阶段** (D9 **B'** token-only + Hono Node 服务，代码落 monorepo `doubleL-license`/`apps/xhs-license`，ADR-011/012/013)：服务端全实现 (provision / suspend / quota + node-cron 月度重置 + admin-ui) + 全生命周期 e2e 对真 newapi 通过 (3 commits 已 push private repo)。**剩部署** = 轮换签名密钥 + 上 bj Docker + 转达 newapi-proxy (Caddy path 路由 / tools 限速 / auto-llm 成本) + 客户端 (cert 信任 IP + 端点 + 发新版) + **砍 CF**(全落 bj)。前置 newapi-proxy M1 已部分就绪 (专用账号 `xiaohongshu-tool`(id=4) + 访问令牌已拿 + B' 全链路实测通过)。

## Next
- **M8 公测发售** — 卡 D3 (产品名 / 域名) + D5 (客服渠道)。
- **M7 P3 polish** — 第 5 个签到模板 (需 Go MCP `list_following`) + 详细 step log trace + failed notification + callTool timeout / 取消按钮。

## Later
- 联网搜索多 source fallback (DuckDuckGo + Bing 国内版)。
- newapi username 升 sha256 hash (用户量起来后，替代当前末 8 位明文 trade-off)。
- 更新策略升级方案 B (自建 `/download` 重定向，若客服压力大)。

## 已搁置（+原因）
- **卖 token / 服务端反代** — 认清"本质是 SaaS 而非软件"，剥离为独立项目 (工程量 −60% / 运维归零 / 风险隔离)。
- **auto-update** — 本地化 + 私仓边界 (公仓被拒 / R2 要绑卡 / Worker 中转超时)，走方案 C「提醒 + 客服私发」。
- **mac Intel (x64) build** — D7，私仓 macOS runner quota 10x 卡 queue，暂只 arm64。
- **仓库改 public** — D8，用户拒 (不愿公开主仓源码)。
- **主控窗口 popup 解锁 retina lock** — 调试一晚真因未明，接受 1280×800 锁 + 独立 xhs 窗口 helper-popup 方案。
