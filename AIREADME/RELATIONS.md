# RELATIONS — 小红书自运营系统
<!-- 生态连接。出向用相对路径 ../<proj>/AIREADME/。被 ≥2 项目依赖的共享底座 → 抽独立节点，这里只指向。 -->

## 出向依赖（我用了谁）
| 依赖 | 用途 | 路径 |
|---|---|---|
| **newapi-proxy** | 自营 LLM Gateway 中转 (D6)。① license 服务调其 newapi admin API 创建 / 管理客户 token (B' token-only) ② 客户端经它调 LLM (model 写死 `auto-llm`，火山方舟智能调度) | `../newapi-proxy/AIREADME/` |

> **接入现状（2026-05-24 读 `../newapi-proxy/AIREADME/SPEC` 确认）**：
> - **LLM 端点** = `https://39.96.12.136:8888/v1`（OpenAI 兼容，**IP 直连 + Caddy 自签 `tls internal`，port 8888**），model 写死 `auto-llm`，`Authorization: Bearer sk-<token>`。new-api v1.0.0-rc.8。
> - ⚠️ **`*.doublel.top` 域名 2026-05-24 被阿里云备案拦截**（域名级 Host 拦，server:Beaver）→ **退回 IP 直连自签（预案 B）为当前基线**。**连带影响 xhs**：① 客户端 LLM 端点从旧 `139.196.157.57`(v1 退役) 改 `39.96.12.136:8888`；② xhs license 端点（原拟 `xhslicense.doublel.top`）同域同样被拦 → license 也须走 **IP:port 直连自签**。→ **xhs DEPLOYMENT/SPEC + B' hosting 已据此修正**（2026-05-24）。
> - **自签证书**：客户端 Electron 走 `certificate-error` allowlist 放行该 IP（已有机制），或装 root CA「Caddy Local Authority 2026 ECC Root」。
> - **provisioning**：license 服务（同机）调 `new-api:3000` / `127.0.0.1:3000` 内网建 token；newapi 默认单 `default` group → **xhs 需建专属 `xhs` group + `xhs-pool` user**（B'）。
> - 完整契约（端点/证书/鉴权/7 模型/配额）→ `../newapi-proxy/AIREADME/SPEC.md` + 其 repo 根《doubleL接入指南.html》。

## 入向（谁用我）
- 暂无项目级消费方 (pre-launch)。终端 = 小红书运营者 (付费客户)，非项目。

## 共享底座 / 复用资产
- **alicloud-bj `edge` Caddy + `edge` docker 网** — newapi-proxy 维护的共享反代/网络。license 服务迁 bj 后与 LLM 共用此入口 (license 加一条 Caddy 路由 + 接 edge 网调 `new-api:3000`)。配置归该节点 → `../newapi-proxy/AIREADME/` (DEPLOYMENT)，本项目只引用不复述。
- **xiaohongshu-mcp** — vendored 上游开源 Go MCP，**非共享节点** (嵌在本 repo `xiaohongshu-mcp/`，单一消费方)，fork 维护策略见 ARCHITECTURE + DECISIONS。
