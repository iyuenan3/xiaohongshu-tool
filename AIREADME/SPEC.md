# SPEC — 小红书自运营系统
<!-- 对外契约：别人集成你需要的精确接口。不写实现(→ARCHITECTURE)/为何(→DECISIONS)。 -->

> 本项目"对外契约" = ① license 服务端点 (客户端激活 / 心跳 / 配额 + admin 发码) ② 中转下发给客户端的 LLM 配置 ③ AI 可调的 14 工具。
> 本文件 = 集成契约。实现级细节 (进程模型 / 客户端 SQLite·文件 schema / 工作流引擎 / CDP 握手 / Go 改造) → [ARCHITECTURE](./ARCHITECTURE.md)；约定 (日志 / 测试 / 安全) → [CONVENTIONS](./CONVENTIONS.md)；理由 → [DECISIONS](./DECISIONS.md)。〔2026-05-25：根 `SPEC.md`(104KB) 蒸馏折叠进 AIREADME 并 git rm；根 `INFRA.md` 去重删除（内容几乎全已在 AIREADME，半敏感退役标识 → ~/.secrets）〕

## 端点 (license server)
> 当前 Cloudflare Worker；**迁移中 → alicloud-bj Hono Node 服务**，代码落新 repo `doubleL-license/apps/xhs-license` (见 DEPLOYMENT / DECISIONS ADR-011/012)。base 现 `https://xhslicense.maxwellii.com` → 迁后走 **IP:port 直连自签** (edge Caddy 在 `39.96.12.136:8888` 按 path 路由；`*.doublel.top` 域名 2026-05-24 被阿里云备案拦截，退**预案 B**)。**CF 全退役** (不留 /version)。token 验签格式不变，但**签名密钥迁移轮换** → 公钥值变、客户端须重 bake。

- `POST /activate` {code, machine_id} → {token (Ed25519 签), valid_until, status, llm:{base_url, api_key, model}}
- `POST /heartbeat` {token} → {ok, status, llm, latest_version, revoked?}
- `GET /version` (公共无 auth, 60/min) → {latest_version, min_version, support_contact, release_notes}
- `GET /quota?code&sig` → {remain_cny, total_cny, used_cny, next_reset_at}
- **admin** (Bearer ADMIN_TOKEN): `POST/GET /admin/codes` (发码/列码) · `POST /admin/revoke|rebind|suspend|resume` · `GET /admin/overdue` (15 天超期清单) · `GET /admin` (HTML 后台)
- **激活码状态机** (`status`)：`unused` → 绑机激活 → `active`；同机重激活 OK，异机 → `CODE_BOUND_OTHER` (走 /admin/rebind)；`suspended` (未续费软停) 拒重激活防绕过；`revoked` 终态。suspended/revoked 拒 rebind (`INVALID_STATE`)。

## 鉴权
- 客户端 token = **Ed25519 签名 SignedToken**：`base64(JSON(payload)) + '.' + base64(ed25519_sign(payload))`，payload = `{code, machine_id, issued_at, valid_until}` (valid_until = issued_at + 365 天)。私钥服务端持、公钥客户端内置验签 (源码 `worker/PUBLIC_KEY.txt`；**迁 bj 轮换 → 公钥值变、客户端重 bake**)。
- admin 端点 = `Bearer ADMIN_TOKEN`。
- `/quota` 用 activate 拿的 SignedToken 当 `sig` 防越权查他人配额。

## 能力 / 工具清单 (14)
- **Go MCP (12)**: check_login_status · list_feeds · search_feeds · get_feed_detail · user_profile · my_profile · post_comment_to_feed · reply_comment_in_feed · like_feed · favorite_feed · publish_content · publish_with_video
- **Renderer 本地 (2)**: search_local_assets (素材库 LIKE 检索) · web_search (隐藏 BrowserWindow + DuckDuckGo)
- **LLM**: 客户端 model 写死 `auto-llm` (newapi token model_limits 锁死，火山方舟在 doubao/Kimi/DeepSeek/GLM/MiniMax 间智能调度)

## 配额 / 分组
- **B' (D9 / ADR-013)** = 全部客户 token 挂同一专用非 admin 账号 `xiaohongshu-tool`(id=4，现有 group、不新建 `xhs` group)；per-token `remain_quota` 设每客户上限 + 服务端 node-cron 月度重置；suspend=toggle `token.status`、revoke=删 token。model 靠 `token.model_limits` 锁 `auto-llm`。
- 服务持该账号「访问令牌」(`Authorization: Bearer` + `New-Api-User`) 自建/管自己的 token (非 admin 密码 impersonation；newapi UserAuth 原生约束在本账号内)。
- ¥ 换算: `raw / quota_per_unit(500000) × usd_exchange_rate(7.3)`，动态拉 newapi `/api/status` 取值，**不硬编码**。

## 错误码
格式 `<DOMAIN>_<SPECIFIC>` 全大写下划线。
- **License**：服务端 `code` 不带前缀 (`CODE_NOT_FOUND` / `CODE_REVOKED` / `CODE_SUSPENDED` / `CODE_BOUND_OTHER` / `CODE_EXPIRED` / `INTERNAL`)，客户端转 i18n 补 `LICENSE_`；客户端独有 `LICENSE_NOT_ACTIVATED` / `LICENSE_INVALID_CODE` / `LICENSE_MACHINE_MISMATCH` / `LICENSE_NETWORK_ERROR`；admin 状态冲突 = `INVALID_STATE` (带 `current` + `hint`)。
- **MCP**：`MCP_NOT_READY` / `MCP_NOT_LOGGED_IN` / `MCP_TOOL_NOT_FOUND` / `MCP_INVALID_PARAMS` / `MCP_EXECUTION_FAILED` / `MCP_RATE_LIMITED`。
- **LLM**：`LLM_NOT_CONFIGURED` / `LLM_AUTH_FAILED` (401) / `LLM_QUOTA_EXCEEDED` (402) / `LLM_RATE_LIMITED` (429) / `LLM_NETWORK_ERROR` / `LLM_INVALID_RESPONSE`。
- IPC 错误统一 `{code, message, detail?}`，renderer 统一捕获展示。

## 版本 / 兼容
- 客户端启动 8s 后比对本地 package.json version vs `/version` 的 latest_version → 弹"联系客服"dialog (非 auto-update)。
- `license.json` schema 重大变更需重激活 (仅 v0.2.6→v0.2.7 发生过，release notes 须警示)。
