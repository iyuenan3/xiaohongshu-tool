# CORE — 小红书自运营系统
<!-- 身份+不可违反边界。来访首读+防偏差总纲。不写产品细节(→PRD)/架构(→ARCHITECTURE)/接口(→SPEC)。 -->

## 身份
基于 Electron + Chromium 内核的桌面小红书浏览器，内嵌 `xiaohongshu-mcp`(Go) 作业务工具后端，AI 侧边栏通过**自营 newapi 中转**操作 14 个小红书业务工具 (12 Go MCP + 2 renderer 本地)。商业形态：**软件一次性买断 (¥399) + LLM 服务月费**，激活码授权，**无代码签名发布**。

## 使命 / 解决什么问题
小红书运营者手动运营累；自带 LLM key (BYOK) 门槛高 (找供应商 + 申请 key + 充值)。本项目用 AI 代操作日常运营 (发布 / 评论 / 点赞 / 数据 / 定时工作流) + **代付 LLM** (newapi 中转) 抹平门槛。

## Non-Goals（明确不做）
- **不卖 token / 不做服务端反代** — 卖 token 已认清"本质是 SaaS"而剥离为独立项目；除一个 license 服务外全跑用户本机。
- **不支持多小红书账号** — 仅 1 个 (防风控关联 + 简化工程)。
- **不申请 Apple / Win 代码签名** — 无证书，文档教用户绕 Gatekeeper / SmartScreen。
- **不公开注册 / 自助充值 / 兑换码** — 激活码 + 客服。
- **不做 auto-update** — 本地化 + 私仓边界下走"提醒 + 客服"中间路线 (见 DECISIONS)。

## 绝不 / Hard Constraints（红线）
- **1 激活码 = 1 小红书 user_id**，换绑找客服；不限设备数 (用账号绑定替代设备绑定)。
- **频率护栏是软提示不硬拦**：publish 3/天 + 30min gap、comment 10/h、like/favorite 30/h。
- **敏感操作 (发布 / 评论 / 点赞 / 收藏) 默认弹确认对话框**。
- **LLM key 不暴露终端用户** — 中转模式客户端拿 newapi token，dev 暗号才露 BYOK。
- **newapi 多租户：只管 `xhs-` 前缀资源** — 写操作前 assertXhsTenant / assertXhsToken 护栏，绝不动其他租户 (lijunfeng / maxwell 自用 / friends)。
- **key / secret / PII 不进代码、git、AIREADME** — 真值仅 `~/.secrets/xhs-secrets.txt` + 容器 `.env`。

## 生命周期
**active** — pre-launch。M6 LLM Gateway + M7 工作流模块已 ship；M8 公测发售卡 D3 (产品名 / 域名) + D5 (客服渠道)。
