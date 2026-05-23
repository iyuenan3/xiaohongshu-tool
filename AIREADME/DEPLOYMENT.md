# DEPLOYMENT — 小红书自运营系统
<!-- 跑哪/怎么跑/共享什么。共享底座自身配置→其独立节点；key→哪都不写。 -->

> 脱敏：本文件不含 key / secret / Account-ID / PII；真值见本地 gitignored `INFRA.md` + `~/.secrets/xhs-secrets.txt`。

## 主机 + 环境
- **客户端**：用户本机 (macOS / Windows)。Electron app，内嵌 Go MCP 二进制 + Chromium。
- **license server**：**当前** Cloudflare Worker (`xhs-license`) v0.6.0 LIVE；**迁移中 → alicloud-bj** (公网 39.96.12.136 / Ubuntu 24.04 / Docker)，作 Node 服务跟 newapi v2 同机，溶解 Worker→newapi 跨境 / tunnel / cert。
- **LLM 网关 (newapi)**：newapi-proxy 项目 (alicloud-bj)，本项目消费，配置归其节点。

## 怎么起
- **客户端开发**：`cd app && npm run dev` (自动 build Go 二进制 → vite + electron + spawn Go 子进程)。
- **客户端打包**：`npm run build` → mac arm64 dmg (ad-hoc 签) / win nsis exe。
- **license server (当前)**：`cd worker && wrangler deploy`。
- **license server (迁后)**：`/home/admin/xhs-license/` docker-compose，接 `edge` 网，自带 SQLite + node-cron 月度重置。

## 域名 / 入口
- license：`https://xhslicense.maxwellii.com` (CF custom domain，绕 *.workers.dev DNS 劫持) → 迁后拟 `xhslicense.doublel.top` (跟 LLM 同 预案 A 域名+LE / 预案 B IP 直连+自签)。
- 客户端 → newapi LLM：经 newapi-proxy 入口 (现 IP `139.196.157.57` 直连 + 关 SSL verify，因 *.maxwellii.com 被国内 DPI 拦 SNI；迁后随 doublel.top 预案)。

## 共享底座引用
- alicloud-bj `edge` Caddy + `edge` docker 网 → `../newapi-proxy/AIREADME/` (DEPLOYMENT)。license 迁后加一条 Caddy 路由 + 接 edge 网调 `new-api:3000` (内网明文无 cert)。

## 备份 / 升级 / 回滚
- **客户端**：无证书发布 → 用户装时须 `xattr -cr <app>` 解 quarantine (dmg 内附纯文本教程；macOS Tahoe 堵了「右键打开」+ 内嵌 .command 两条路)。更新 = 启动提醒 + 客服私发包 (方案 C，非 auto-update)。用户数据在 `userData/` (license / app.db / assets / cookies)，覆盖安装保留。
- **license server (迁后)**：SQLite 每日 rsync 异地；升级 `docker compose pull && up -d`。

## 运维约束
- newapi 多租户：只动 `xhs-` 前缀资源，写操作前护栏校验。
- secret 改值后服务需重启 / 重部署生效 (CF Worker 非 hot-reload；Node 容器同理)。
- GH Actions 私仓 macOS runner quota 倍率 10x → workflow 仅 `workflow_dispatch` 手动触发，mac 暂只 build arm64。
