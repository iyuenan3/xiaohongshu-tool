# 小红书自运营系统 · 测试策略与用例清单

> 版本 v0.2 · 2026-05-17 · 针对 PRD v0.5 / SPEC v0.2 / ROADMAP v0.4
>
> 测试范围: 已 ship 到 v0.3.0 的功能 (M1-M4 + M5 核心功能 ship 完毕)
> 测试视角: **黑盒 E2E**, 通过 CDP attach + IPC + Worker admin API 三层调用, 不读 app/src/ 源码
>
> v0.2 增量: 新增 §3.10 Tools/Agent 契约模块 + §7 已知运行时 issue (license active 但 UI 卡在激活页)

## 1. 测试策略

### 1.1 测试目标 (按优先级)

1. **P0 · 阻断发布的功能正确性**: 激活流程、AI 工具调用契约、4-tab 切换、xhs-asset:// 协议、IPC 表面完整
2. **P1 · 用户体验保障**: 会话 CRUD、素材库 setTags/search、联网搜索可用、频率护栏、敏感操作确认
3. **P2 · 边界/异常处理**: 错的激活码、空 query、超长输入、不存在的 conv/asset id、网络错误兜底
4. **文档 vs 实现差异**: 找出 "SPEC/PRD 描述 X 但实现没/反之" 的 bug 候选

### 1.2 工具选型与失败哲学

| 维度 | 选择 | 理由 |
|---|---|---|
| 运行时 | Node 22 ESM, 无外部依赖 | 全局 fetch + WebSocket, 与 /tmp/e2e-*.mjs 同风格 |
| 注入方式 | CDP `Runtime.evaluate` → `window.api.*` | 测的是 preload 契约 + renderer DOM, 不是源码 |
| 副作用清理 | 每个 case 自治, 测完即删 | 不污染 dev DB / dev state |
| 失败处理 | 每个文件独立计数 + exit code | 单文件可跑, run-all.mjs 汇总 |
| 真发布 | **禁止** 真调 publish_content / publish_with_video Go 端 | 只验 IPC schema / agent 是否会拦截 |
| 联网搜索 | 真调 (搜狗免登录免 key) | 验证 mutex + 兜底 |
| LLM vision | **SKIP** (BYOK 未配 / 调真模型太慢) | 仅验 IPC + 工具注册 |

### 1.3 测试覆盖度目标

- **IPC 表面**: preload/index.ts 暴露的所有 `window.api.*` 路径 (统计 30+ 入口) 至少各被调一次, 验证非空响应
- **黑盒功能模块**: 6 大模块 (license / assets / chat-conv / web-search / tabs / errors)
- **真实链路**: 至少 1 条端到端集成路径 (上传 → setTags → search → 找到)

### 1.4 不在范围内 (明确说明)

- 真发笔记到小红书 (有风控成本, 也不验证 Go 内部)
- 跨平台打包 dmg/nsis (build pipeline 验证另开)
- 自动更新 electron-updater (依赖发版)
- SQLite 文件直接读写 (绕开 IPC 抽象层无意义)
- xiaohongshu-mcp Go 内部实现 (子进程 black-box)
- Worker 内部实现 (worker/* 整目录禁读)

## 2. 测试环境前置

| 项 | 期望值 |
|---|---|
| Dev server 跑着 | `npm run dev` 已 spawn 主进程 + Go + vite |
| Renderer URL | `http://localhost:5174/` (CDP target 用) |
| Go API base | `http://127.0.0.1:54092/api/v1/*` (健康 = `/health` 不带前缀) |
| CDP `/json` | `http://127.0.0.1:53759/json` |
| License | active, code `XHS-7WXF-K9LR-3FLR-FQAG`, machine_id `b4fabf11aa748f11bcfe03f28b08e13d8ec67ce05b97ca39f8150baab98d4a9a` |
| Worker URL | `https://xhslicense.maxwellii.com` |
| ADMIN_TOKEN | 见 INFRA.md |

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
| IPC-05 | conv 6 个子函数 | P0 | 1 | 全是 function |
| IPC-06 | rate 2 个子函数 | P0 | 1 | 全是 function |
| IPC-07 | updater 1 个 | P0 | 1 | 是 function |
| IPC-08 | license 5 个 | P0 | 1 | 全是 function |
| IPC-09 | assets 8 个 | P0 | 1 | 全是 function |
| IPC-10 | web.search | P0 | 1 | 是 function |
| IPC-11 | ping 调用返 pong 或字符串 | P1 | 1 | 非 undefined |
| IPC-12 | getVersion 返回字符串 | P1 | 1 | string |
| IPC-13 | goStatus 返 {ok, baseUrl} | P0 | 1 | ok=true 且 baseUrl 含端口 |
| IPC-14 | goApi GET /health 调通 | P0 | 5 | 返 success |
| IPC-15 | getPageContext 返 {url, title, text} 或 null | P1 | 1 | 类型正确 |

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

> v0.2 新增. 验证 13 工具注册 + 本地分发 + 敏感操作集合, 不真发布也不真调 LLM.

| ID | 用例 | 优先级 | 类型 | 期望 |
|---|---|---|---|---|
| TOOL-01 | dynamic import `/src/ai/tools.ts`, ALL_TOOL_SCHEMAS 暴露 | P0 | 1 | hasAll=true, names 数组非空 |
| TOOL-02 | 13 个工具 (PRD §4.4 + SPEC §12.9) 名称都注册 | P0 | 1 | 全部命中, missing=[] |
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

## 4. 运行方式

```bash
# 单模块
node tests/e2e/license.mjs
node tests/e2e/assets.mjs

# 一键跑全
node tests/e2e/run-all.mjs
```

每个模块退出码:
- 0: 全部通过 (或仅 SKIP)
- 1: 至少 1 个 FAIL
- 2: 测试基建挂 (CDP 连不上 / renderer 找不到)

## 5. 报告结构

跑完后 `TEST_REPORT.md` 内含:

1. 总览统计 (模块/用例/通过/失败/跳过)
2. 每模块 pass/fail 列表
3. 失败用例详情 (重现步骤 + 期望 vs 实际)
4. **文档 vs 实现偏差清单** (核心交付物之一)
5. Bug 严重度: Critical / Major / Minor
6. 建议修复优先级

## 7. 已知运行时 issue (测试前置)

### 7.1 license=active 但 renderer 显示激活页

测试启动时发现一个**潜在 P0 bug**: `window.api.license.status()` 返回 `status='active'` 且 `code/machine_id` 与文档一致, 但 renderer DOM 显示的是 `<div class="activation-page">`, 主 UI (`.tabbar` / `.chat-panel`) 没渲染。

通过 CDP `Page.reload` 软重载后, UI 立刻显示主界面 (4 个 tab + 控制台正常工作)。

**临时应对** (测试侧):
- `_helper.connect({ requireMainUI: true })` 会先探测 `.tabbar__tab`, 找不到则 Page.reload + 等 ≤4s
- 仅 `tabs.mjs` / `integration.mjs` 需要主 UI; 其他模块走 `window.api` 不依赖 DOM
- 详见 TEST_REPORT.md §"文档 vs 实现偏差"

## 6. 已知风险

- **dev state 污染**: 频繁跑测试会在 SQLite 留下脏数据 (临时 conv / assets). 已在每个测试结尾 cleanup, 但失败中断时残留概率高. 建议跑前手动确认 `sqlite3 ... 'SELECT count(*) FROM conversations'` 数量, 跑后再比对.
- **真发布**: 整套测试不调 publish_content/publish_with_video, 但运营面板/Tool Calling Loop 若有 UI 入口可能被误触. 测试只走 IPC, 不点 UI 上的 "发布" 按钮.
- **LLM vision**: BYOK 未配时 analyzeImage 不可测. 跳过 SKIP.
- **频率护栏污染**: 不大量 log publish/comment, 避免吃掉用户的日额.

---
文档结束 · v0.1
