# DEPLOYMENT — 小红书自运营系统
<!-- 跑哪/怎么跑/共享什么。共享底座自身配置→其独立节点；key→哪都不写。 -->

> 脱敏：本文件不含 key / secret / Account-ID / PII；真值见本地 gitignored `INFRA.md` + `~/.secrets/xhs-secrets.txt`。

## 主机 + 环境
- **客户端**：用户本机 (macOS / Windows)。Electron app，内嵌 Go MCP 二进制 + Chromium。
- **license server**：**当前** Cloudflare Worker (`xhs-license`) v0.6.0 LIVE；**迁移中 → alicloud-bj** (公网 39.96.12.136 / Ubuntu 24.04 / Docker)，作 **Hono Node 服务**跟 newapi v2 同机，溶解 Worker→newapi 跨境 / tunnel / cert。代码迁新 sibling repo **`doubleL-license`** (多工具 monorepo，非本 repo `worker/`；见 DECISIONS ADR-011)；**CF 全退役** (不留 /version，ADR-012)。
- **LLM 网关 (newapi)**：newapi-proxy 项目 (alicloud-bj)，本项目消费，配置归其节点。

## 怎么起
- **客户端开发**：`cd app && npm run dev` (自动 build Go 二进制 → vite + electron + spawn Go 子进程)。
- **客户端打包**：`npm run build` → mac arm64 dmg (ad-hoc 签) / win nsis exe。
- **license server (当前)**：`cd worker && wrangler deploy` (旧 CF，迁后退役)。
- **license server (迁后)**：`doubleL-license` repo build `apps/xhs-license` 镜像 → `/home/admin/xhs-license/` docker-compose 接 `edge` 网，自带 better-sqlite3 + node-cron 月度重置 (`TZ=Asia/Shanghai`)。

## 域名 / 入口
- license：旧 `https://xhslicense.maxwellii.com` (CF，迁后退役) → 迁后走 **IP:port 直连 + 自签**，共享 edge Caddy 在 `39.96.12.136:8888` 按 **path 前缀**路由 (跟 LLM `/v1` 同端口不同 path)；`*.doublel.top` 域名 2026-05-24 被阿里云备案拦截 → 退**预案 B**。客户端须 `setCertificateVerifyProc` 信任该 IP (`certificate-error` 不覆盖主进程 `net.fetch`) + 硬编码新 IP。
- 客户端 → newapi LLM：**`https://39.96.12.136:8888/v1`**（OpenAI 兼容，**IP 直连 + Caddy 自签 root CA，port 8888**；旧 `139.196.157.57` 是已退役 v1）。客户端 `certificate-error` allowlist 放行该 IP 或装 root CA「Caddy Local Authority 2026 ECC Root」。契约详见 `../newapi-proxy/AIREADME/SPEC`。

## 共享底座引用
- alicloud-bj `edge` Caddy + `edge` docker 网 → `../newapi-proxy/AIREADME/` (DEPLOYMENT)。license 迁后加一条 Caddy 路由 + 接 edge 网调 `new-api:3000` (内网明文无 cert)。

## 备份 / 升级 / 回滚
- **客户端**：无证书发布 → 用户装时须 `xattr -cr <app>` 解 quarantine (dmg 内附纯文本教程；macOS Tahoe 堵了「右键打开」+ 内嵌 .command 两条路)。更新 = 启动提醒 + 客服私发包 (方案 C，非 auto-update)。用户数据在 `userData/` (license / app.db / assets / cookies)，覆盖安装保留。
- **license server (迁后)**：**单机单点** (bj box)，SQLite 是付费授权唯一真相源 → 每日 rsync 异地 (**备份目标 + 恢复演练迁前必落**，newapi-proxy 侧同款 backup cron 也待跑通)；升级 `docker compose pull && up -d`。已激活客户端本地缓存 license 365 天 → bj 短宕只挡新激活/续期。

## 运维约束
- newapi 多租户：只动 `xhs-` 前缀资源，写操作前护栏校验。
- secret 改值后服务需重启 / 重部署生效 (CF Worker 非 hot-reload；Node 容器同理)。
- GH Actions 私仓 macOS runner quota 倍率 10x → workflow 仅 `workflow_dispatch` 手动触发，mac 暂只 build arm64。
