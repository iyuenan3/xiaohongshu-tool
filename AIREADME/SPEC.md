# SPEC — 小红书自运营系统
<!-- 对外契约：别人集成你需要的精确接口。不写实现(→ARCHITECTURE)/为何(→DECISIONS)。 -->

> 本项目"对外契约" = ① license 服务端点 (客户端激活 / 心跳 / 配额 + admin 发码) ② 中转下发给客户端的 LLM 配置 ③ AI 可调的 14 工具。
> **字段级 schema / 错误码矩阵 / 客户端 `license.json` schema / 工作流 SQLite schema 等实现级细节见根目录 [`../SPEC.md`](../SPEC.md)** (104KB 详细附录)；本文件只放集成契约摘要。

## 端点 (license server)
> 当前 Cloudflare Worker；**迁移中 → alicloud-bj Hono Node 服务**，代码落新 repo `doubleL-license/apps/xhs-license` (见 DEPLOYMENT / DECISIONS ADR-011/012)。base 现 `https://xhslicense.maxwellii.com` → 迁后走 **IP:port 直连自签** (edge Caddy 在 `39.96.12.136:8888` 按 path 路由；`*.doublel.top` 域名 2026-05-24 被阿里云备案拦截，退**预案 B**)。**CF 全退役** (不留 /version)。token 验签格式不变，但**签名密钥迁移轮换** → 公钥值变、客户端须重 bake。

- `POST /activate` {code, machine_id} → {token (Ed25519 签), valid_until, status, llm:{base_url, api_key, model}}
- `POST /heartbeat` {token} → {ok, status, llm, latest_version, revoked?}
- `GET /version` (公共无 auth, 60/min) → {latest_version, min_version, support_contact, release_notes}
- `GET /quota?code&sig` → {remain_cny, total_cny, used_cny, next_reset_at}
- **admin** (Bearer ADMIN_TOKEN): `POST/GET /admin/codes` (发码/列码) · `POST /admin/revoke|rebind|suspend|resume` · `GET /admin/overdue` (15 天超期清单) · `GET /admin` (HTML 后台)

## 鉴权
- 客户端 token = **Ed25519 签名** (私钥服务端持，公钥客户端内置验签，源码 `worker/PUBLIC_KEY.txt`)。
- admin 端点 = `Bearer ADMIN_TOKEN`。
- `/quota` 用 activate 拿的 SignedToken 当 `sig` 防越权查他人配额。

## 能力 / 工具清单 (14)
- **Go MCP (12)**: check_login_status · list_feeds · search_feeds · get_feed_detail · user_profile · my_profile · post_comment_to_feed · reply_comment_in_feed · like_feed · favorite_feed · publish_content · publish_with_video
- **Renderer 本地 (2)**: search_local_assets (素材库 LIKE 检索) · web_search (隐藏 BrowserWindow + DuckDuckGo)
- **LLM**: 客户端 model 写死 `auto-llm` (newapi token model_limits 锁死，火山方舟在 doubao/Kimi/DeepSeek/GLM/MiniMax 间智能调度)

## 配额 / 分组
- newapi `xhs` group；**B' (D9)** = 每激活码一个 token (挂专用 `xhs-pool` user) + per-token `remain_quota` + 服务端 node-cron 月度重置。
- ¥ 换算: `raw / quota_per_unit(500000) × usd_exchange_rate(7.3)`，动态拉 newapi `/api/status` 取值，**不硬编码**。

## 版本 / 兼容
- 客户端启动 8s 后比对本地 package.json version vs `/version` 的 latest_version → 弹"联系客服"dialog (非 auto-update)。
- `license.json` schema 重大变更需重激活 (仅 v0.2.6→v0.2.7 发生过，release notes 须警示)。
