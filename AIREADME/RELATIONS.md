# RELATIONS — 小红书自运营系统
<!-- 生态连接。出向用相对路径 ../<proj>/AIREADME/。被 ≥2 项目依赖的共享底座 → 抽独立节点，这里只指向。 -->

## 出向依赖（我用了谁）
| 依赖 | 用途 | 路径 |
|---|---|---|
| **newapi-proxy** | 自营 LLM Gateway 中转 (D6)。① license 服务调其 newapi admin API 创建 / 管理客户 token (B' token-only) ② 客户端经它调 LLM (model 写死 `auto-llm`，火山方舟智能调度) | `../newapi-proxy/AIREADME/` |

## 入向（谁用我）
- 暂无项目级消费方 (pre-launch)。终端 = 小红书运营者 (付费客户)，非项目。

## 共享底座 / 复用资产
- **alicloud-bj `edge` Caddy + `edge` docker 网** — newapi-proxy 维护的共享反代/网络。license 服务迁 bj 后与 LLM 共用此入口 (license 加一条 Caddy 路由 + 接 edge 网调 `new-api:3000`)。配置归该节点 → `../newapi-proxy/AIREADME/` (DEPLOYMENT)，本项目只引用不复述。
- **xiaohongshu-mcp** — vendored 上游开源 Go MCP，**非共享节点** (嵌在本 repo `xiaohongshu-mcp/`，单一消费方)，fork 维护策略见 ARCHITECTURE + DECISIONS。
