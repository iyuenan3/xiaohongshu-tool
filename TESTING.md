# 小红书自运营系统 · 测试策略与用例清单

> 版本 v0.3 · 2026-05-20 · 针对 PRD v0.7 / SPEC v0.4 / ROADMAP v0.6
>
> 测试范围: 已 ship 到 v0.6 + v0.7 M7 P1 工作流(working tree)
> 测试视角: **黑盒 E2E**, 通过 CDP attach + IPC + Worker admin API 三层调用, 不读 app/src/ 源码
>
> v0.3 增量:
> - 新增 §3.11 Workflow (M7 P1 工作流引擎)
> - 新增 §3.12 LLM Gateway (M6 D6, 主要服务端 admin curl 验证, 不在 client E2E 范围)
> - 维护原有 11 套件 + 加入 workflow.mjs 到 run-all.mjs

## 1. 测试策略

### 1.1 测试目标 (按优先级)

1. **P0 · 阻断发布的功能正确性**: 激活流程、AI 工具调用契约、4-tab 切换、xhs-asset:// 协议、IPC 表面完整、**工作流 CRUD + scheduler 调度契约**
2. **P1 · 用户体验保障**: 会话 CRUD、素材库 setTags/search、联网搜索可用、频率护栏、敏感操作确认、**工作流模板枚举 + 风险确认 state**
3. **P2 · 边界/异常处理**: 错的激活码、空 query、超长输入、不存在的 conv/asset/workflow id、网络错误兜底
4. **文档 vs 实现差异**: 找出 "SPEC/PRD 描述 X 但实现没/反之" 的 bug 候选

### 1.2 工具选型与失败哲学

| 维度 | 选择 | 理由 |
|---|---|---|
| 运行时 | Node 22 ESM, 无外部依赖 | 全局 fetch + WebSocket, 与 /tmp/e2e-*.mjs 同风格 |
| 注入方式 | CDP `Runtime.evaluate` → `window.api.*` | 测的是 preload 契约 + renderer DOM, 不是源码 |
| 副作用清理 | 每个 case 自治, 测完即删 | 不污染 dev DB / dev state |
| 失败处理 | 每个文件独立计数 + exit code | 单文件可跑, run-all.mjs 汇总 |
| 真发布 | **禁止** 真调 publish_content / publish_with_video Go 端 | 只验 IPC schema / agent 是否会拦截 |
| **工作流 runNow / devFireSoon** | **禁止** 调用 | 真实跑会消耗 newapi quota + 操作小红书账号 |
| 联网搜索 | 真调 (搜狗免登录免 key) | 验证 mutex + 兜底 |
| LLM 中转 | chat / tools-agent suite 真调 (消耗 quota, 不阻塞) | 验真链路 |
| LLM vision | **SKIP** (BYOK 未配 / 调真模型太慢) | 仅验 IPC + 工具注册 |

### 1.3 测试覆盖度目标

- **IPC 表面**: preload/index.ts 暴露的所有 `window.api.*` 路径 (统计 45+ 入口, 含 workflow 15 个) 至少各被调一次, 验证非空响应
- **黑盒功能模块**: 7 大模块 (license / assets / chat-conv / web-search / tabs / errors / **workflow**)
- **真实链路**: 至少 1 条端到端集成路径 (上传 → setTags → search → 找到)

### 1.4 不在范围内 (明确说明)

- 真发笔记到小红书 (有风控成本, 也不验证 Go 内部)
- **真跑工作流 (runNow / devFireSoon)** — 会真实点赞 + 评论 + 消耗 quota
- 跨平台打包 dmg/nsis (build pipeline 验证另开)
- 自动更新 electron-updater (依赖发版)
- SQLite 文件直接读写 (绕开 IPC 抽象层无意义)
- xiaohongshu-mcp Go 内部实现 (子进程 black-box)
- Worker 内部实现 (worker/* 整目录禁读)
- **D6 LLM Gateway 服务端**: newapi User CRUD / Plan bind / suspend/resume/revoke / 多租户隔离 / Cloudflare Tunnel — 这些靠 admin curl + Worker `/admin/*` 端点手动验证, 不在 client E2E 范围
- **真实小红书 API 调用**: cookies 过期 / xsec_token 错 / 风控 reject — 不在 client E2E 范围

## 2. 测试环境前置

| 项 | 期望值 |
|---|---|
| Dev server 跑着 | `cd app && npm run dev` 已 spawn 主进程 + Go + vite |
| Renderer URL | `http://localhost:5173/` (M7 dev port, 老版可能是 5174/5175, _helper.mjs 自动 fallback) |
| CDP port | `64818` (新 dev 启的, 改了 dev 后请同步 `_helper.mjs` CDP_PORT_CANDIDATES[0]) |
| Go API base | 动态端口 (Go `--port=127.0.0.1:0` + BIND_PORT stdout 解析), 客户端通过 `goStatus()` 拿 |
| License | active, code `XHS-7WXF-K9LR-3FLR-FQAG`, machine_id `b4fabf11aa748f11bcfe03f28b08e13d8ec67ce05b97ca39f8150baab98d4a9a` |
| **SQLite tables** | `app.db` 已含 v7 schema (workflows / workflow_runs / appConfig) — `runMigrations()` 启动时自动跑 |
| Worker URL | `https://xhslicense.maxwellii.com` |
| ADMIN_TOKEN | 见 INFRA.md (不入 git) |
| **newapi 多租户隔离** | xhs 资源以 `xhs-` 前缀, Worker 写操作前 assertXhsTenant() 护栏 (服务端验证, 不在 client 测试范围) |
| **Cloudflare Tunnel** | `llm-cf.maxwellii.com` Worker → newapi 入口 (服务端 D6, 不在 client 测试范围) |

## 3. 测试模块与用例清单

> 用例编号: `<模块>-<序号>`. 优先级: P0/P1/P2. 类型: 1正常/2异常输入/3状态机/4边界/5链路.

### 3.1 模块: License (`tests/e2e/license.mjs`)

| ID | 用例 | 优先级 | 类型 | 期望 |
|---|---|---|---|---|
| LIC-01 | `license.status()` 返回当前 active 状态 | P0 | 1 | status=active, code 与 machine_id 与文档一致 |
| LIC-02 | `license.getMachineId()` 返回 64 字符 hex SHA-256 | P0 | 1 | 长度 64, 全 hex, 与 status.machine_id 相等 |
| LIC-03 | `license.heartbeat()` 联通 Worker | P0 | 5 | ok=true, revoked=false |
| LIC-04 | 错的激活码格式 | P0 | 2 | 期望 status != active, message 含 "无效" 或类似 |
| LIC-05 | 不存在的激活码 (格式对) | P0 | 3 | status=error/unactivated, message 含 NOT_FOUND 或友好提示 |
| LIC-06 | Worker /admin/codes list 看到本机绑定码 | P1 | 5 | list 里有此 code 且 status=active, machine_id 匹配 |
| LIC-07 | `license.clear()` 不被测试调用 (会破坏 dev state) | - | SKIP | 记录但不调 |
| LIC-08 | push 通道 `license:changed` E2E (clear → activate → DOM 切换) | P0 | 5 | 主进程 push 触发 React 重渲染, activation-card / tabbar 切换 + onChanged 返 unsub fn |

### 3.2 模块: Assets 素材库 (`tests/e2e/assets.mjs`)

| ID | 用例 | 优先级 | 类型 | 期望 |
|---|---|---|---|---|
| AST-01 | importUrl 真下载 + 文件名 picture-YYYYMMDD-HHmmss-N.jpg | P0 | 1 | 返回 MediaAsset, filename 匹配正则 |
| AST-02 | importUrl mime=image/jpeg, 压缩后 size > 1KB | P0 | 1 | mime 正确, size 合理 |
| AST-03 | list 包含新导入 | P0 | 1 | find(id) 不为空 |
| AST-04 | 默认 tags='[]' / description=null / analyzed=0 | P0 | 1 | 三字段都符合 |
| AST-05 | setTags 写入 tags + description + analyzed=1 | P0 | 1 | list 重读字段一致 |
| AST-06 | search 按 tag 关键词命中 | P0 | 5 | 返回数组包含此 id |
| AST-07 | search 按 description 关键词命中 | P1 | 5 | 同上 |
| AST-08 | search 按 filename ("picture") 命中 | P1 | 5 | 同上 |
| AST-09 | search 不存在的关键词不返回 | P1 | 2 | 此 id 不在结果里 |
| AST-10 | search 空 query | P1 | 2 | 不崩, 返回数组 (可空可全) |
| AST-11 | search limit=2 边界 | P1 | 4 | 返回 ≤2 条 |
| AST-12 | getPath 返回存在的本地路径 | P0 | 1 | 字符串非空, 文件能 fetch |
| AST-13 | xhs-asset://{id} 协议返 200 + image/jpeg + 内容 | P0 | 5 | content-type / size 都合理 |
| AST-14 | xhs-asset://{not-exist-id} 返 404 | P1 | 2 | status=404 |
| AST-15 | touchUsed 更新 last_used_at | P1 | 1 | 调后 list 读 ts 已变化 |
| AST-16 | delete 后 list 不含此 id | P0 | 1 | find=undefined |
| AST-17 | delete 不存在的 id | P1 | 2 | 不抛异常 (idempotent) |
| AST-18 | importUrl 非法 URL | P1 | 2 | 抛错或返 null, 不崩 |

### 3.3 模块: Chat / Conversation (`tests/e2e/chat.mjs`)

| ID | 用例 | 优先级 | 类型 | 期望 |
|---|---|---|---|---|
| CONV-01 | conv.list 返回数组 | P0 | 1 | Array |
| CONV-02 | conv.create 返回新 id 字符串 | P0 | 1 | typeof === 'string' |
| CONV-03 | 新建后 list 包含此 id | P0 | 1 | find 不为空 |
| CONV-04 | conv.get(id) 返 meta + messages=[] | P0 | 1 | meta.id 一致, messages 空数组 |
| CONV-05 | conv.setTitle + 再 get 验证 | P0 | 1 | meta.title 等于新值 |
| CONV-06 | conv.saveMessages 写入消息 | P0 | 1 | 后续 get 拿到一致 messages |
| CONV-07 | conv.clearMessages 清空 | P0 | 1 | get 后 messages=[] |
| CONV-08 | conv.delete 删除 | P0 | 1 | list 中不存在 |
| CONV-09 | conv.get 不存在的 id | P1 | 2 | meta=null 或抛错, 不崩 |
| CONV-10 | conv.setTitle 超长 (1000 字符) | P1 | 4 | 不崩, get 拿回 (实现可能截断) |
| CONV-11 | conv.saveMessages 大量消息 (50 条) | P2 | 4 | 不崩, get 全部返回 |
| CONV-12 | conv.delete 不存在的 id | P1 | 2 | 不抛 (idempotent) |
| CONV-13 | conv.list 的 conv 顺序按 updated_at desc | P2 | 1 | 检查排序 |

### 3.4 模块: Web Search (`tests/e2e/web-search.mjs`)

| ID | 用例 | 优先级 | 类型 | 期望 |
|---|---|---|---|---|
| WEB-01 | window.api.web.search 存在 | P0 | 1 | typeof function |
| WEB-02 | 真实搜索返回 ≥3 条结果 | P0 | 1 | array.length >= 3 |
| WEB-03 | 结果结构 {title, url, snippet} 都是 string | P0 | 1 | 全部字段类型对 |
| WEB-04 | 连续 2 次调用 (验证 mutex + 销毁) | P1 | 5 | 第二次也返回 ≥1 |
| WEB-05 | n=1 边界 | P1 | 4 | 返回 ≤1 (或不严格) |
| WEB-06 | 空 query | P1 | 2 | 不崩, 返回数组 (可空) |
| WEB-07 | 超长 query (500 字) | P2 | 4 | 不崩, 返回数组 |

### 3.5 模块: Tabs / UI 切换 (`tests/e2e/tabs.mjs`)

| ID | 用例 | 优先级 | 类型 | 期望 |
|---|---|---|---|---|
| TAB-01 | tabbar 有 4 个 tab (控制台/小红书/素材库/帮助) | P0 | 1 | DOM 4 个 .tabbar__tab |
| TAB-02 | 默认是「控制台」激活 | P1 | 1 | .tabbar__tab--active 标签是控制台 |
| TAB-03 | 切到「小红书」, console 隐藏, xhs 显示, webview 节点存在 | P0 | 1 | --hidden 类切换正确 + webview DOM 存在 |
| TAB-04 | 切「素材库」, asset-library 容器可见 | P0 | 1 | asset-library 元素存在 |
| TAB-05 | 切「帮助」, help-panel 可见 + 步骤/callout 计数 | P1 | 1 | help-steps 数量, callout 数量 |
| TAB-06 | 切回控制台, .chat-panel 可见 | P0 | 1 | chat-panel 元素可见 |
| TAB-07 | 5 个常用命令按钮存在 | P0 | 1 | .command-btn 5 个 |
| TAB-08 | 点命令按钮预填 textarea + 聚焦 | P0 | 1 | textarea.value 非空, document.activeElement 是 textarea |

### 3.6 模块: IPC 表面完整性 (`tests/e2e/ipc-surface.mjs`)

> 用反射方式列举 `window.api` 所有路径, 验证每个 typeof === 'function' 不为 undefined.

| ID | 用例 | 优先级 | 类型 | 期望 |
|---|---|---|---|---|
| IPC-01 | window.api 暴露成功 | P0 | 1 | object 非空 |
| IPC-02 | 基础 (ping/getVersion) | P0 | 1 | 都是 function |
| IPC-03 | go (goStatus/goApi) | P0 | 1 | 都是 function |
| IPC-04 | browser (openXhsWindow/getPageContext) | P0 | 1 | 都是 function |
| IPC-05 | conv 7 个子函数 | P0 | 1 | 全是 function |
| IPC-06 | rate 2 个子函数 | P0 | 1 | 全是 function |
| IPC-07 | updater 1 个 | P0 | 1 | 是 function |
| IPC-08 | license 6 个 | P0 | 1 | 全是 function (含 onChanged push) |
| IPC-09 | assets 8 个 | P0 | 1 | 全是 function |
| IPC-10 | web.search | P0 | 1 | 是 function |
| IPC-11 | ping 调用返 pong 或字符串 | P1 | 1 | 非 undefined |
| IPC-12 | getVersion 返回字符串 | P1 | 1 | string |
| IPC-13 | goStatus 返 {ok, baseUrl} | P0 | 1 | ok=true 且 baseUrl 含端口 |
| IPC-14 | goApi GET /health 调通 | P0 | 5 | 返 success |
| IPC-15 | getPageContext 返 {url, title, text} 或 null | P1 | 1 | 类型正确 |

> **注**: ipc-surface 不覆盖 `window.api.workflow` 的 15 个子函数, 由专门套件 `workflow.mjs` (§3.11) 验证。

### 3.7 模块: 频率护栏 (`tests/e2e/rate-limit.mjs`)

| ID | 用例 | 优先级 | 类型 | 期望 |
|---|---|---|---|---|
| RATE-01 | rate.check('like') 不在限流时 allowed=true | P0 | 1 | allowed=true |
| RATE-02 | rate.check('publish') 返回 window 计数 | P1 | 1 | 字段齐全 (allowed/windowCount/windowMax) |
| RATE-03 | rate.check 非法 action | P2 | 2 | 不崩 (可能返 error 字符串) |
| RATE-04 | rate.log + check 的 windowCount 增加 | P1 | 5 | 调 log 前后 windowCount+1 |

> 注意: 别 log 太多 publish/comment 把真用户的额度打掉, 用 like (30/h) 测试更安全, 测完不必 reset (1h 自然 expire).

### 3.8 模块: 错误处理 / 异常输入 (`tests/e2e/errors.mjs`)

| ID | 用例 | 优先级 | 类型 | 期望 |
|---|---|---|---|---|
| ERR-01 | goApi 不存在的 path | P0 | 2 | 不抛, 返 404 信息或 error 包装 |
| ERR-02 | goApi POST 但 body=null | P1 | 2 | 不崩 |
| ERR-03 | goApi GET 端点带空 body | P1 | 2 | 按 CLAUDE.md 踩坑, 已修, 不该报 GET-with-body |
| ERR-04 | license.activate 非法 code 格式 ("abc") | P0 | 2 | 返 error/unactivated 状态 |
| ERR-05 | license.activate 空字符串 | P0 | 2 | 不崩, 返 error |
| ERR-06 | assets.delete 不存在的 id | P1 | 2 | 不抛, idempotent |
| ERR-07 | assets.getPath 不存在的 id | P1 | 2 | 返 null 或不抛 |
| ERR-08 | xhs-asset 协议非法 id | P1 | 2 | 返 404 |

### 3.10 模块: Tools/Agent 契约 (`tests/e2e/tools-agent.mjs`)

> v0.2 新增. 验证 13 工具注册 + 本地分发 + 敏感操作集合, 不真发布也不真调 LLM (但会真调中转测连通性).

| ID | 用例 | 优先级 | 类型 | 期望 |
|---|---|---|---|---|
| TOOL-01 | dynamic import `/src/ai/tools.ts`, ALL_TOOL_SCHEMAS 暴露 | P0 | 1 | hasAll=true, names 数组非空 |
| TOOL-02 | 14 个工具 (PRD §4.4 + SPEC §12.9) 名称都注册 | P0 | 1 | 全部命中, missing=[] |
| TOOL-03 | search_local_assets isLocal=true | P0 | 1 | isLocalTool 返 true |
| TOOL-04 | web_search isLocal=true | P0 | 1 | 同上 |
| TOOL-05 | publish_content schema 含 images 字段 | P0 | 1 | parameters.properties.images 存在 |
| TOOL-06 | search_local_assets schema 含 query 字段 | P0 | 1 | 同上 |
| TOOL-07 | web_search schema 含 query 字段 | P0 | 1 | 同上 |
| TOOL-08 | SENSITIVE_TOOLS 集合包含 publish_content / publish_with_video / post_comment_to_feed / reply_comment_in_feed / like_feed / favorite_feed | P0 | 1 | 6 个全在 |
| TOOL-09 | BYOK 配置 (localStorage 探测) | P1 | 1 | 类型 OK; 没配则 SKIP vision 测试 |
| TOOL-10 | window.api.web.search 仍是 function (与 ai/tools 一致) | P1 | 1 | typeof === 'function' |
| TOOL-11 | assets.search 行为 IPC 不变 | P1 | 1 | 不抛, 返数组 |
| TOOL-12 | rate.check('favorite') 也被支持 | P1 | 1 | allowed bool, 不抛 |

### 3.9 模块: 链路集成 (`tests/e2e/integration.mjs`)

| ID | 用例 | 优先级 | 类型 | 期望 |
|---|---|---|---|---|
| INT-01 | 上传图 → setTags → search_local_assets (模拟 AI 调) → 找到此图 | P0 | 5 | search 结果 path = getPath(id) |
| INT-02 | 上传 → list → 通过 xhs-asset:// 加载 → 删除 → list 不含 | P0 | 5 | 全流程顺利 |
| INT-03 | 激活码本机绑定 → Worker /admin/codes list → 看到此码 active 状态 | P0 | 5 | bound_machine_id 匹配 |
| INT-04 | 控制台 tab → 命令按钮预填 textarea → 切换 tab → 再切回 textarea 值保留 | P1 | 5 | 文本不丢 |

### 3.11 模块: Workflow 工作流 (`tests/e2e/workflow.mjs`) — M7 P1 新增

> v0.3 新增 (2026-05-20). 覆盖 M7 P1 工作流引擎 IPC 表面 / CRUD 闭环 / 4 种 schedule type / 风控 config state / push event listener / 错误 path.
>
> ⚠️ **绝不调用 `workflow.runNow` / `workflow.devFireSoon`** — 这俩会真实跑模板, 触发小红书 API (点赞/评论) 并消耗 newapi LLM quota. 仅验 IPC 契约 + DB 持久化。

#### 用例清单 (~69 cases)

| ID | 用例 | 优先级 | 类型 | 期望 |
|---|---|---|---|---|
| WF-01a | `window.api.workflow` 命名空间存在 | P0 | 1 | apiShape 非 null |
| WF-01b | 15 个方法 (list/get/create/update/enable/delete/runNow/runs/getTemplates/devFireSoon/getConfig/setConfig/onRunStarted/onRunStepUpdate/onRunFinished/onAutoDisabled) 全是 function | P0 | 1 | 全部 typeof === 'function' |
| WF-01c | `workflow.list()` 不 throw + 返数组 | P0 | 1 | Array.isArray |
| WF-01d | `workflow.getTemplates()` 不 throw + 返数组 | P0 | 1 | Array.isArray |
| WF-01e | `workflow.getConfig(任意 key)` 不 throw | P0 | 1 | 不抛 (返 null / string) |
| WF-02a~h | `getTemplates` 至少含 `daily_like_comment`, paramsSchema 含 `top_n:int` + `comment_style:enum` | P0 | 1 | SPEC §13.5.1 模板 schema 齐全 |
| WF-04a~y | CRUD 闭环: create → list 含 → get(id) → update name → enable(true/false) → runs(id)=[] → delete (soft) → list 不含 → 重复 delete idempotent | P0 | 5 | 全流程通过, params/schedule 字段 JSON 入库 |
| WF-05 | 4 种 schedule type (daily/weekly/interval/manual) create 不 throw, JSON 入库后 type 一致 | P0 | 1 | 4 种全建成 |
| WF-06a~e | 风险确认 config: getConfig(不存在 key) 返 null / setConfig 写 "1" + 重复 idempotent / getConfig 回读 "1" | P0 | 5 | appConfig schema 持久化 OK |
| WF-07a~c | 4 个 onXxx listener (onRunStarted/onRunStepUpdate/onRunFinished/onAutoDisabled) 注册不 throw, 返 unsubscribe fn, 调用 unsubscribe 不 throw | P0 | 1 | preload push channel OK |
| WF-08a~e | 错误 path: get(99999) 返 null / create 缺 template_id throw or ok:false / delete 已存在 id ok=true / delete 已删 id 幂等 ok=true | P1 | 2 | 主进程不 crash |
| WF-09 | 不存在 template_id create (enabled:false 不进 scheduler) + 后续 list 仍 alive | P1 | 5 | 进程存活 |

#### 不在 workflow.mjs 范围 (需手动验证 / 推迟到 ship 后)

- ⚠️ **真实跑模板**: runNow → 触发 list_feeds + like_feed + post_comment_to_feed + LLM completion. 手动 dev 模式 + 小红书 sandbox 账号验证, 不入 E2E
- ⚠️ **devFireSoon**: 把 next_fire_at 设为 now+30s, dev 模式调试用. 不在 E2E (会触发真实跑)
- ⚠️ **scheduler 时钟漂移**: powerMonitor.on('resume') recomputeAll 行为, 需 sleep/wake 物理动作, 不入 E2E
- ⚠️ **连续 3 fail auto-disable**: 需模拟 3 次 LLM timeout, 涉及真调 LLM, 不入 E2E
- ⚠️ **queue 串行**: 2 个 enabled workflow 同时刻到点, 需 runNow 触发, 不入 E2E
- ⚠️ **missed_run**: 需 kill app + 调系统时间, 不入 E2E
- ⚠️ **schema_version=7 migration**: 老用户升级到 v0.7 时跑 migration. 测试环境每次启动都跑, 无独立 case (`runMigrations()` 早早跑过)
- ⚠️ **跨工作流 quota 冲突预估** (SPEC §13.6.1): UI 警示文案, 不在 IPC 层

### 3.12 模块: D6 LLM Gateway (服务端, 不在 client E2E)

> 自营 newapi 中转 + Worker 一码一 newapi user + bind XHS Plan, M6 已 deploy (2026-05-19), 卡 Cloudflare Tunnel (2026-05-20 落地 `llm-cf.maxwellii.com`).
>
> **此模块基于服务端 Worker admin curl 验证, 不在 client E2E 范围**, 仅列出验证清单供 Maxwell 手动执行。

#### 服务端验证清单 (手动 curl + Maxwell 操作)

| 项 | 验证方式 | 期望 |
|---|---|---|
| Worker /admin/codes POST | `curl -X POST $WORKER/admin/codes -H "Authorization: Bearer $ADMIN" -d '{"count":1,"notes":"E2E test"}'` | 同步创建 newapi user (`xhs-` 前缀) + bind XHS Plan + token, KV 写入 `code:CODE` |
| Worker /activate | `curl -X POST $WORKER/activate -d '{"code":CODE,"machine_id":MID}'` | 返 `{ok:true, token, llm:{base_url, api_key, model}}` |
| Worker /admin/suspend | `curl -X POST $WORKER/admin/suspend -H "Authorization: Bearer $ADMIN" -d '{"code":CODE}'` | newapi token 失效, status → suspended, 下次 /heartbeat 返 status=suspended |
| Worker /admin/resume | `curl -X POST $WORKER/admin/resume -d '{"code":CODE}'` | newapi token 恢复, status → active |
| Worker /admin/revoke | `curl -X POST $WORKER/admin/revoke -d '{"code":CODE,"reason":"..."}'` | newapi user 删除 + KV status=revoked, 客户端 /heartbeat 触发 license 清除 |
| Worker /admin/overdue | `curl $WORKER/admin/overdue -H "Authorization: Bearer $ADMIN"` | 返 quota_used > total_amount 的码列表 (Maxwell 月底排查未续费) |
| Worker /quota?code&sig | 客户端 dev 模式调 | 返 {used, total, reset_at} |
| Worker /version | `curl $WORKER/version` | 返 `{latest_version, min_version, support_contact, release_notes}` (v0.3.2+ 起客户端启动 8s 后调) |
| **多租户隔离**: assertXhsTenant() | 用 maxwell user_id=1 (非 xhs- 前缀) 测 /admin/suspend | Worker 拒绝, 返 403 / "not xhs tenant" |
| **Cloudflare Tunnel**: `llm-cf.maxwellii.com` | Worker 内部 fetch, 不在 client | newapi 内网回源, 跨境无 525 SSL 错误 |
| **客户端 → newapi IP 直连**: `https://139.196.157.57/v1` | renderer agent.ts 调真实 LLM | 必须 main certificate-error 放行 + 关 SSL verify (国内 DPI 拦 SNI) |

> 详见 SPEC §12.10 + INFRA.md "newapi LLM 中转站" 区块 (admin token 真值在 `~/.secrets/xhs-secrets.txt`)。

## 4. 运行方式

```bash
# 单模块
node tests/e2e/license.mjs
node tests/e2e/assets.mjs
node tests/e2e/workflow.mjs        # M7 P1 新增

# 一键跑全 (含 workflow.mjs)
node tests/e2e/run-all.mjs
```

每个模块退出码:
- 0: 全部通过 (或仅 SKIP)
- 1: 至少 1 个 FAIL
- 2: 测试基建挂 (CDP 连不上 / renderer 找不到)

`run-all.mjs` 串行跑全部 11 个模块, 汇总到 stdout + 写 `tests/e2e/last-run.json` (供 TEST_REPORT.md 二次加工)。

## 5. 报告结构

跑完后 `TEST_REPORT.md` 内含:

1. 总览统计 (模块/用例/通过/失败/跳过)
2. 每模块 pass/fail 列表
3. 失败用例详情 (重现步骤 + 期望 vs 实际)
4. **文档 vs 实现偏差清单** (核心交付物之一)
5. Bug 严重度: Critical / Major / Minor
6. 建议修复优先级

## 7. 已知运行时 issue (测试前置)

### 7.1 license=active 但 renderer 显示激活页 (B-001 v0.2 已修)

测试启动时曾发现一个 P0 bug: `window.api.license.status()` 返回 `status='active'` 且 `code/machine_id` 一致, 但 renderer DOM 显示的是 `<div class="activation-page">`, 主 UI (`.tabbar` / `.chat-panel`) 没渲染。

**已修 (v0.2)**: 主进程 `license:changed` push channel 实现, renderer license 状态变化时实时重渲染 UI。`_helper.connect({ requireMainUI: true })` 现在简单 wait `.tabbar__tab` (no reload)。

### 7.2 CDP port 漂移

每次 `npm run dev` 重启, Electron CDP port 可能换。`_helper.mjs` `CDP_PORT_CANDIDATES` 数组首项为最新, 失败时往下 fallback。改了 dev 后需手动 update `CDP_PORT_CANDIDATES[0]`。

### 7.3 Vite renderer port 漂移

Renderer 默认 `5173`, 占用时切 `5174` / `5175`. `_helper.mjs` 已支持这 3 个 fallback URL。

### 7.4 dev SQLite 脏数据

频繁跑测试会在 SQLite 留下脏数据 (临时 conv / assets / workflows). 已在每个测试结尾 cleanup, 但失败中断时残留概率高. 建议跑前手动确认 `sqlite3 ... 'SELECT count(*) FROM workflows WHERE deleted_at IS NULL'` 数量, 跑后再比对。

### 7.5 workflow.mjs 残留风险

workflow.mjs 会在 SQLite 留 soft-deleted workflows (`deleted_at IS NOT NULL`), 不影响功能但占空间. 偶尔可手动:
```sql
DELETE FROM workflow_runs WHERE workflow_id IN (SELECT id FROM workflows WHERE deleted_at IS NOT NULL);
DELETE FROM workflows WHERE deleted_at IS NOT NULL;
```

## 6. 已知风险

- **dev state 污染**: 频繁跑测试会在 SQLite 留下脏数据 (临时 conv / assets / **workflows**). 已在每个测试结尾 cleanup, 但失败中断时残留概率高
- **真发布**: 整套测试不调 publish_content/publish_with_video, 但运营面板/Tool Calling Loop 若有 UI 入口可能被误触. 测试只走 IPC, 不点 UI 上的 "发布" 按钮
- **真跑工作流**: workflow.mjs 严格不调 runNow / devFireSoon, **手动测试时也要小心** (会真实点赞 + 评论)
- **LLM vision**: BYOK 未配时 analyzeImage 不可测. 跳过 SKIP
- **LLM quota**: chat / tools-agent suite 真调中转 (消耗 newapi quota), 不阻塞但会扣 quota
- **频率护栏污染**: 不大量 log publish/comment, 避免吃掉用户的日额

---
文档结束 · v0.3 (2026-05-20)
