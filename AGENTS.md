# AGENTS.md

本文件是 `xiaohongshu-tool` 的 Codex 启动入口。项目真相源位于 `AIREADME/`，自主运营专项设计见 `AIREADME/DESIGN-autonomous-operation.md`。

## 启动顺序

1. 读本文件和 `AIREADME/INDEX.md`。
2. 按任务加载对应文档。
3. 先查日志和当前代码，再判断问题根因。
4. 需要跨会话历史时，使用 `stash` Skill 解析仓库外的项目记忆。

## 任务路由

| 任务 | 必读 |
|---|---|
| 了解身份、边界与依赖 | `AIREADME/CORE.md` + `AIREADME/RELATIONS.md` |
| 修改 Electron、Go MCP 或运行时链路 | `AIREADME/ARCHITECTURE.md` + `AIREADME/DECISIONS.md` |
| 修改 license、LLM 或工具契约 | `AIREADME/SPEC.md` |
| 修改自主运营 | `AIREADME/DESIGN-autonomous-operation.md` + `AIREADME/ARCHITECTURE.md` + `AIREADME/DECISIONS.md` |
| 修改产品与路线 | `AIREADME/PRD.md` + `AIREADME/ROADMAP.md` + `AIREADME/CONVENTIONS.md` |
| 构建、发版与运维 | `AIREADME/DEPLOYMENT.md` + `AIREADME/CHANGELOG.md` + `AIREADME/MEMORY.md` |

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

## AIREADME 维护

- 接口、架构、部署、路线变化时更新对应文档。
- 决策、事故和版本文档保持追加式维护。
- 最后刷新 `INDEX.md` 的状态摘要和同步锚点，并运行 AIREADME 检查。
- `CLAUDE.md` 保留给旧 Claude 客户端兼容，Codex 以本文件为入口。
