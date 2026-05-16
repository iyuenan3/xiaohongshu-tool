# 发版与自动更新流程

> 适用 M5 公测起步阶段。基于 GitHub Release + electron-updater，**完全无证书**也能工作。

---

## 一次性准备（M5 启动前）

### 1. 决定 GitHub 仓库

在 GitHub 创建一个 public 或 private 仓库（例：`maxwellii/xhs-app`）。

> 公开发布建议 **public** + 简短 README 即可（用户不会真去看源码，但 electron-updater 需要能匿名访问 release/）。私有仓库需要在客户端嵌入 GitHub token，反而更不安全。

### 2. 替换 `app/package.json` 的占位

```jsonc
"publish": [
  {
    "provider": "github",
    "owner": "PLACEHOLDER_OWNER",   // ← 改成实际 GitHub 用户名
    "repo": "PLACEHOLDER_REPO",     // ← 改成实际仓库名
    "releaseType": "release"
  }
]
```

替换后重新 `npm run build:mac` 出 dmg。从 v0.1.0 开始正式版本号。

### 3. 准备 GitHub Personal Access Token（仅本地发版用）

```bash
# 在 https://github.com/settings/tokens 生成 classic PAT
# 勾 repo 全部权限即可
export GH_TOKEN=ghp_xxxxxxxxxxxx
```

把 token 写入 `INFRA.md`（gitignored），后续发版前 `source` 一下。

---

## 日常发版流程（每次小更新）

### 1. 更新版本号

```bash
cd app
npm version patch   # 0.1.0 → 0.1.1
# 或者 minor / major
```

### 2. 构建 + 自动上传到 GitHub Release

```bash
export GH_TOKEN=ghp_xxxxxxxxxxxx
npm run build:mac  # 出 dmg + zip + latest-mac.yml + blockmap
npm run build:win  # 出 nsis + latest.yml (需要 wine 或 Win 机器)

# 上传 (electron-builder 会自动 draft release 并 attach 产物)
npx electron-builder --mac --win --publish always
```

### 3. 在 GitHub 上 publish draft release

电子-builder 上传后是 draft 状态。打开 GitHub Releases → 找到对应版本 → "Publish release"。

publish 后，所有已安装的客户端在下次启动后 8 秒内会自动检查更新 + 弹"新版本可用"对话框。

---

## electron-updater 工作流（用户视角）

1. 用户启动 app（任何已激活版本）
2. 启动 8 秒后, autoUpdater 静默检查 GitHub Release
3. 发现新版本 → 弹"立即下载 / 稍后" 对话框
4. 用户点"立即下载" → 后台下载 dmg（不影响使用）
5. 下载完成 → 弹"立即重启 / 稍后" 对话框
6. 用户重启 → 自动安装新版

每 4 小时再次检查一次。

---

## 无证书更新的限制

| 限制 | 影响 | 缓解 |
|---|---|---|
| **首次安装仍触发 Gatekeeper** | 用户第一次装 .app 需要按 [FIRST_RUN_MAC.md](FIRST_RUN_MAC.md) 走 bypass | 一次性，首启指引清晰 |
| **更新过程无证书签名** | macOS 不会因为更新而再次拦截（已信任的 app 更新放行），但 Windows SmartScreen 偶尔会重新拦 | Windows 用户 < 5% 概率需要重做 SmartScreen bypass |
| **electron-updater blockmap 校验** | 用 sha512 + blockmap 增量校验，不依赖证书 | 完整性保证 OK |

---

## 紧急回滚

如果新版有严重 bug：

1. **GitHub Releases → 把出问题的版本标记 "Pre-release"** 或直接删 release
2. electron-updater 只看最新 release，会忽略 Pre-release（默认配置）
3. 客户端下次检查时不会再提示这个版本
4. 已下载未重启的客户端 → 在 quit 时安装 → 这部分用户需要手动重装老版（可接受范围内）

---

## 与 License Worker 的协作

Worker `/heartbeat` 响应包含 `latest_version` 和 `min_version`：
- `latest_version`：用于在 UI 显示"有新版"角标（备用通道，不强制下载）
- `min_version`：低于此版本拦截使用（强制更新）

设置：

```bash
# 在 wrangler 后端
wrangler kv key put --binding=LICENSES "config:latest_version" "0.1.1" --remote
wrangler kv key put --binding=LICENSES "config:min_version" "0.1.0" --remote
```

发新版时 latest_version 跟 GitHub Release 同步即可。强制更新（min_version 调高）极少用，仅用于"老版本有严重安全 bug 不能继续运行"的场景。
