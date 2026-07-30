# AGENTS.md

本文件是 `xiaohongshu-tool` 的 Codex 启动入口。仓库公开，提交内容必须适合公开阅读。维护者本机若存在被忽略的 `AIREADME/`，它是内部架构与运营真相源；公共贡献者以 `README.md`、`docs/`、代码和测试为准。

## 启动顺序

1. 读本文件和 `README.md`。
2. 若本机存在 `AIREADME/INDEX.md`，按任务加载对应内部文档。
3. 先查日志和当前代码，再判断问题根因。
4. 需要跨会话历史时，使用 `stash` Skill 解析仓库外的项目记忆。

## 任务路由

| 任务 | 公共资料 | 维护者本地资料 |
|---|---|---|
| 了解项目、构建与目录 | `README.md` | `AIREADME/CORE.md` + `AIREADME/RELATIONS.md` |
| 修改 Electron、Go MCP 或运行时链路 | 当前代码 + `tests/e2e/` | `AIREADME/ARCHITECTURE.md` + `AIREADME/DECISIONS.md` |
| 修改自主运营 | 当前代码 + `tests/e2e/operating.mjs` | `AIREADME/DESIGN-autonomous-operation.md` |
| 修改发布与安装体验 | `docs/RELEASE.md` + `docs/FIRST_RUN_*.md` | `AIREADME/DEPLOYMENT.md` + `AIREADME/CHANGELOG.md` |
| 修改产品、license 或 LLM 契约 | `README.md` + 当前代码 | 对应 AIREADME 文档 |

## 红线

- key、secret、PII 和真实凭证只存在受保护的本地或生产配置中，不进代码、Git 或文档。
- license 与 newapi 的写操作必须限制在本项目租户范围内，不得影响其他租户。
- Chromium 启动参数、窗口行为、请求约定和主控尺寸等禁改项以 `ARCHITECTURE.md` 为准。
- 自动发布必须保留审核窗口、原子状态转换、失败有界重试和人工接管防线。
- 保留用户现有改动，只暂存本任务明确修改的路径。

## 常用验证

```bash
cd app && npm run typecheck
cd app && npm run build:go
node tests/e2e/run-all.mjs
```

E2E 需要已激活的本地环境。发布、生产 license 变更和 GitHub Actions 发版均需用户明确授权。

## 文档维护

- 公共构建、安装、使用或贡献方式变化时更新 `README.md` 或 `docs/`。
- 维护者本机存在 AIREADME 时，同步接口、架构、部署、决策、事故和版本文档，再刷新同步锚点。
- 被 `.gitignore` 排除的 AIREADME、`CLAUDE.md`、测试报告和私人记忆不得强制加入公开仓库。
