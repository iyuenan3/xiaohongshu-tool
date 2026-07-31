# 发版与版本提醒流程

> 当前方案：GitHub Release 分发安装包，客户端启动后调用版本服务 `/version`。发现新版时提示用户联系客服获取安装包，不自动下载或安装。

## 架构边界

| 组件 | 职责 |
|---|---|
| GitHub Actions | 构建 macOS、Windows 安装包并上传到 GitHub Release |
| GitHub Release | 保存可下载的 DMG、ZIP 和 EXE |
| License 服务 `/version` | 返回 `latest_version`、`min_version`、`support_contact` 和 `release_notes` |
| 客户端 | 启动 8 秒后检查版本，有新版时显示更新说明与客服联系信息 |

客户端当前不使用 `electron-updater`，`app/package.json` 的 `build.publish` 应保持为空数组。electron-builder 可能在本地生成 blockmap，但发布流程不依赖或上传自动更新元数据。

GitHub Release 与版本服务是两个独立状态。发布安装包不会自动修改生产环境的 `latest_version`。生产版本配置属于单独的外部写操作，必须获得明确授权后执行。

## GitHub Actions 发版

仓库包含两个手动工作流：

- `.github/workflows/build-macos.yml`：构建 Apple Silicon 的 DMG 与 ZIP。
- `.github/workflows/build-windows.yml`：构建 x64 NSIS 安装包，并执行 8 秒启动冒烟测试。

两个工作流使用相同的 `release_tag` 时，会把各自安装包合并到同一个 GitHub Release。留空 `release_tag` 时只构建 CI artifact，不创建 Release。

### 1. 更新版本号并验证

```bash
cd app
npm version patch --no-git-tag-version
npm run typecheck
npm run build:go
cd ..
node tests/e2e/run-all.mjs
```

E2E 需要已激活的本地环境。涉及真实发布、生产 license 写入或其他外部状态的用例，不得在未授权时运行。

### 2. 提交并推送

只暂存本次发版涉及的路径，确认 diff 后提交并推送目标分支。不要用 `git add -A` 混入本地配置、日志或维护者私有文档。

### 3. 触发两个构建

以下示例假设版本为 `v0.9.11`，分支为 `main`：

```bash
gh workflow run build-macos.yml --ref main -f release_tag=v0.9.11
gh workflow run build-windows.yml --ref main -f release_tag=v0.9.11 -f upload_artifact=true
```

等待两个工作流成功：

```bash
gh run list --workflow build-macos.yml --limit 1
gh run list --workflow build-windows.yml --limit 1
```

### 4. 核验 Release

```bash
gh release view v0.9.11
```

至少确认：

- Release 不是 draft，也不是 pre-release。
- tag 和构建使用的 commit 一致。
- macOS 有 DMG 与 ZIP，Windows 有 `xhspilot-Setup-<version>.exe`。
- Windows 的 8 秒启动冒烟测试通过。

macOS 无签名版本仍会触发 Gatekeeper，用户首次安装按 [FIRST_RUN_MAC.md](FIRST_RUN_MAC.md) 操作。Windows 可能触发 SmartScreen，按 [FIRST_RUN_WIN.md](FIRST_RUN_WIN.md) 操作。

### 5. 更新版本服务

只有在安装包和 Release 均核验通过后，才考虑把生产 `/version` 的 `latest_version` 更新为新版本，并同步 `release_notes`。这一步会影响所有已安装客户端，必须单独确认授权和目标租户。

`min_version` 只用于严重安全问题下的强制升级，不随普通发版调整。

## 用户看到的更新流程

1. 用户启动已激活客户端。
2. 客户端启动 8 秒后请求版本服务 `/version`。
3. `latest_version` 高于本地版本时，客户端显示版本号、更新说明和客服联系信息。
4. 用户复制联系方式，从客服处获取对应平台安装包。
5. 覆盖安装保留 `userData` 中的激活信息、数据库、素材和 cookies。

## 紧急回滚

如果新版安装包有严重问题：

1. 先停止向用户分发该版本。
2. 经明确授权后，把版本服务的 `latest_version` 恢复到最近可用版本，并更新说明。
3. 在 GitHub 将问题版本标为 pre-release，保留资产和历史用于调查，不直接删除。
4. 修复后发布新的补丁版本，不复用已经发布的 tag。

GitHub Release 状态与版本服务状态必须分别核验，不能只完成其中一侧就宣称发版完成。
