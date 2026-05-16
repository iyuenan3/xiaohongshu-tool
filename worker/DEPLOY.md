# Worker 部署清单

> ✅ 已于 2026-05-16 部署完成: https://xhs-license.liyuenan93.workers.dev
> 后续日常用 `npm run deploy` 推新版本。

## 当前状态

- KV namespace: `a42560054b8241e89ddbe9317d35af21` (binding `LICENSES`)
- Secrets: `SIGNING_PRIVATE_KEY` + `ADMIN_TOKEN` 已通过 wrangler secret put 注入
- 首码已发 (admin CLI `issue -c 1`), prod E2E 跑通 (通过 ClashX 代理因本机 DNS 劫持)

## DNS 劫持应对

国内部分运营商劫持 `*.workers.dev` 到假 IP (如 facebook IPv6 段)。两种应对:

**短期** - 客户端走代理 (Maxwell 自测专用):
- 环境变量 `HTTPS_PROXY=http://127.0.0.1:7897` 时 admin CLI + main 进程 fetch 自动走代理
- 见 `app/src/main/proxy.ts` + `worker/scripts/xhs-license.mjs`

**长期** - 绑自定义域名 (M5 公测前必做):
- 把 `maxwellii.com` 整体迁到 Cloudflare DNS
- Worker 加 Custom Domain `xhs.maxwellii.com`
- 客户端 license.ts default WORKER_URL 改 `https://xhs.maxwellii.com`
- 备案域名不受运营商 DNS 劫持



## 一次性步骤（在你的电脑上）

### 1. 安装 wrangler

```bash
npm install -g wrangler@3
wrangler --version   # 应输出 ⛅️ wrangler 3.x
```

### 2. Cloudflare 登录（OAuth）

```bash
wrangler login
```

浏览器弹出 → 授权 → 终端显示 ✓。

### 3. 创建 KV namespace

```bash
cd worker
wrangler kv namespace create LICENSES
```

输出会包含：
```
[[kv_namespaces]]
binding = "LICENSES"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

把 `id` 复制下来，修改 `worker/wrangler.toml` 把占位的 32 个 0 替换为真实 ID。

### 4. 注入 secrets

```bash
# 私钥（从 INFRA.md 复制）
echo "3Sz3CaQwHiglMhHwhU8LAU35asC69mk6fQILVJgKu9k=" | wrangler secret put SIGNING_PRIVATE_KEY

# 管理 token（随机 256-bit）
openssl rand -base64 32 | tee admin-token.txt | wrangler secret put ADMIN_TOKEN
```

把 `admin-token.txt` 的内容贴到 `INFRA.md` 的 `ADMIN_TOKEN` 段，然后 `rm admin-token.txt`。

### 5. 部署

```bash
npm run deploy   # 等价于 wrangler deploy
```

输出会包含：
```
Published xhs-license (X.XX sec)
  https://xhs-license.<your-account>.workers.dev
```

把这个 URL 也写入 `INFRA.md`。

### 6. 冒烟测试

```bash
WORKER_URL=https://xhs-license.<your-account>.workers.dev \
ADMIN_TOKEN=$(grep ADMIN_TOKEN /Users/maxwell/Desktop/Claude-Project/xiaohongshu-tool/INFRA.md | head -1 | cut -d= -f2-) \
  node scripts/xhs-license.mjs health

WORKER_URL=... ADMIN_TOKEN=... node scripts/xhs-license.mjs issue -c 1 -n "smoke test"
```

## 日常运营

### 发码（用户付款后）

```bash
node scripts/xhs-license.mjs issue -c 1 -n "买家张三 / 微信 ¥299 / 2026-05-20"
```

输出一行激活码，复制发给买家。

### 撤销破解码

```bash
node scripts/xhs-license.mjs revoke XHS-XXXX-XXXX-XXXX-XXXX -r "破解传播"
```

15 天后客户端心跳生效（参见 PRD §6.3）。

### 换绑（用户换电脑找客服）

```bash
node scripts/xhs-license.mjs rebind XHS-XXXX-XXXX-XXXX-XXXX <new_machine_id_from_user>
```

每年 3 次免费，超出 ¥99/次（PRD §6.4）。

## 紧急回滚

```bash
wrangler rollback   # 回退到上一个版本
wrangler tail       # 看实时日志
wrangler deployments list
```
