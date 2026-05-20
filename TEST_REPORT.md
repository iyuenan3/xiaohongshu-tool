# v0.7 E2E 测试报告

> 测试日期: 2026-05-20 (round 2, web_search bug 修后重跑)
> 测试人: subagent (claude-opus) + maxwell (修 web_search 后手动重跑)
> 环境: dev mode, license active (XHS-D8PP-BGAY-YPZU-T8SD), Go ready, schema_version=7 已 migrate
> 提交: cb94be9 + 后续 M7 P1 实施 + web-search.ts 切 DuckDuckGo
> CDP port 51121 / Renderer http://localhost:5173/

## 总览 (round 2, web_search 修后全绿)

| Suite | Cases | Pass | Fail | Skip | Time |
| ---- | --- | --- | --- | --- | --- |
| License        | 26  | 25  | 0  | 1  | ~5s |
| IPC Surface    | 40  | 40  | 0  | 0  | <100ms |
| **Workflow (M7)** | **69** | **69** | **0** | **0** | **~90ms** |
| Assets         | 26  | 26  | 0  | 0  | ~1.2s |
| Chat/Conv      | 21  | 21  | 0  | 0  | ~130ms |
| Tabs/UI        | 16  | 15  | 0  | 1  | ~1s |
| Rate Limit     | 6   | 6   | 0  | 0  | ~90ms |
| **Web Search** | **9**  | **9**  | **0** | **0** | ~5.5s |
| Tools/Agent    | 13  | 13  | 0  | 0  | <100ms |
| Errors         | 10  | 10  | 0  | 0  | ~1s |
| Integration    | 11  | 11  | 0  | 0  | ~2.3s |
| **Total**      | **247** | **245** | **0** | **2** | ~16s |

Pass rate: **99.2%** (245/247, 排除 skip 后 **100%** ✅)

## Round 1 → Round 2 变化

| 项 | Round 1 | Round 2 |
|---|---|---|
| Web Search pass | 7/9 (2 fail) | **9/9** ✅ |
| 总 fail | 2 | **0** |
| Pass rate | 98.4% | **99.2%** |

修复内容: `app/src/main/web-search.ts` 从搜狗 (`div.vrwrap` 失效) 切到 DuckDuckGo HTML (`html.duckduckgo.com/html/?q=`). 实测返 5 条真实结果, 第二次连续搜索也成功。

## 各套件细节

### 1. license.mjs (25/0/1)
- 测试 license 完整生命周期: status / getMachineId / heartbeat / activate / clear / push channel (`license:changed`)
- LIC-07 (license.clear) 故意 SKIP, 避免破坏 dev state (LIC-08 内部会 clear+activate 测 push 通道)
- LIC-08 push 通道 E2E: clear → DOM 切到 activation-card → activate → DOM 切回 tabbar. **passing** 证明主进程 push channel 工作正常
- 关键修复: `_helper.mjs` 里 LICENSE.code 从老版 `XHS-7WXF-...` 更新为当前真实绑定码 `XHS-D8PP-BGAY-YPZU-T8SD` (machine_id 不变)

### 2. ipc-surface.mjs (40/0/0)
- 反射验证 32 个 `window.api.*` 路径全是 function (root/conv/rate/updater/license/assets/web)
- IPC-13 goStatus 返 `{ok:true, baseUrl}`, baseUrl 是动态端口 (Go --port=0)
- IPC-14 goApi GET /health 调通
- **注**: 不覆盖 `window.api.workflow` 的 15 个子函数, 由 §3 workflow 套件验证

### 3. workflow.mjs (69/0/0) M7 P1 新增 ✅
- 完全绿. 覆盖范围:
  - WF-01 (5 cases): IPC 表面 15 个方法 + list/getTemplates/getConfig 不 throw
  - WF-02 (8 cases): getTemplates 含 `daily_like_comment`, paramsSchema 含 `top_n:int` + `comment_style:enum`
  - WF-04 (25 cases): CRUD 闭环 (create / list / get / update name / enable true/false / runs=[] / delete soft / 不含 / 幂等 delete)
  - WF-05 (8 cases): 4 种 schedule type (daily/weekly/interval/manual) create + JSON 入库 + list 可见 + cleanup
  - WF-06 (5 cases): 风险确认 appConfig schema (`workflow_risk_accepted`) getConfig null / setConfig / getConfig read-back / idempotent
  - WF-07 (3 cases): 4 个 push listener (onRunStarted/onRunStepUpdate/onRunFinished/onAutoDisabled) 注册返 unsubscribe fn + 调用不 throw
  - WF-08 (5 cases): 错误 path (get 99999=null / create 缺 template_id throw or ok:false / delete 已删 idempotent)
  - WF-09 (2 cases): 不存在 template_id 处理 + 进程 alive
- **严格不调** runNow / devFireSoon (会真实点赞 + 评论 + 消耗 quota)
- SQLite migration v7 (workflows / workflow_runs / appConfig) 隐式验证通过 — 这 3 张表 + index 都在, IPC `workflow.list()` 不 throw "no such table"

### 4. assets.mjs (26/0/0)
- 智能素材库完整闭环: importUrl / list / search by tag/description/filename / xhs-asset:// 协议 / setTags / touchUsed / delete
- 多图源 fallback (gstatic / httpbin / picsum), 防 sniffer 挂掉
- xhs-asset:// 协议返 200 + image/jpeg 验证通过

### 5. chat.mjs (21/0/0)
- 会话 CRUD + 50 条大量消息 / 1000 字超长 title / 空 id / idempotent delete / 按 updated_at desc 排序
- 全过

### 6. tabs.mjs (15/0/1)
- 4-tab 切换 + 命令按钮 + textarea 预填 + tab 切换 hidden 而非 destroy
- **修复**: TAB-07 期望从 5 → 3 commands ("检查登录/发布笔记/获取首页推荐"), 符合 v0.7 M7 P1 CommandPalette 精简 (PRD §M7 + ROADMAP §14 Day 4-5)
- TAB-08b 聚焦 SKIP (CDP test window 无 OS focus, `.focus()` 不生效, 真实用户使用 OK)

### 7. rate-limit.mjs (6/0/0)
- rate.check + rate.log 闭环, like 通道 (30/h) 测试不污染 publish/comment quota
- 测完后 like windowCount=3 (上次 1 → 2 → 3), 自然 1h expire

### 8. web-search.mjs (9/0/0)  ✅ Round 2 修后全绿
- WEB-01 API 暴露
- WEB-02 (5 条返回) / WEB-02b (≥3 条) **通过** (round 1 fail 因搜狗 div.vrwrap 失效, round 2 切 DuckDuckGo 修)
- WEB-03 每条结构 {title, url, snippet} 类型对 / WEB-03b 有效结果数 5
- WEB-04 连续第二次搜索 ≥1 条 (3)
- WEB-05 n=1 截断 / WEB-06 空 query 不崩 / WEB-07 超长 query 不崩
- 详见 §"修复的 Production Bug" Bug 1

### 9. tools-agent.mjs (13/0/0)
- 14 工具全注册 (12 Go + 2 renderer 本地: search_local_assets / web_search)
- SENSITIVE_TOOLS 集合含 publish_content / publish_with_video / post_comment_to_feed / reply_comment_in_feed / like_feed / favorite_feed
- isLocalTool 正确识别 search_local_assets / web_search
- BYOK localStorage 探测 OK
- 注: tools-agent **真调 LLM 中转** 验证连通, 消耗 newapi quota (不阻塞)

### 10. errors.mjs (10/0/0)
- goApi 不存在 path / body=null / GET 带空 body (踩坑修过)
- activate 'abc' / '' / assets.delete idempotent / xhs-asset 非法 id 404 — 全过

### 11. integration.mjs (11/0/0)
- INT-01: 上传 → setTags → search → 找到 → getPath 一致 → xhs-asset:// 可加载
- INT-02: 上传 → list → 加载 → delete → list 不含 → xhs-asset 失效
- INT-03: Worker /admin/codes 找到本机 XHS-D8PP-BGAY-YPZU-T8SD active + bound_machine_id 一致
- INT-04: tab 切换 textarea 值保留

## 修复的 Production Bug

### Bug 1: web_search 返回 "无结果" — 搜狗 DOM 选择器失效  ✅ FIXED (2026-05-20)
- **位置**: `app/src/main/web-search.ts:81` `const nodes = document.querySelectorAll('div.vrwrap')`
- **现象**: web_search MCP 工具 (PRD §4.4 内联 14 工具之一) 对任意 query 都返回 `[{title:'无结果', url:'', snippet:'搜狗未返回有效结果'}]` (即 fallback 路径触发)
- **Root cause**: 搜狗 SERP 上游 DOM 改版, `div.vrwrap` 选择器已经不存在或被换. fallback 选择器 `.space-txt, p` 也没命中
- **修复**: 切换到 DuckDuckGo HTML 端点 (`https://html.duckduckgo.com/html/?q=`, 国内可达, 结构稳定, CLAUDE.md 用户全局规则推荐). 新选择器 `div.result, div.web-result` + `a.result__a` + `.result__snippet`, 含 DDG redirect URL 解析 (`duckduckgo.com/l/?uddg=...` → real URL)
- **验证**: Round 2 web-search.mjs 9/9 pass, 返回 5 条真实结果 + 第二次连续搜索 OK
- **原优先级**: P1, 现已修

## 已知限制 / 跳过项

- **LIC-07** `license.clear()` 不直接测试 — LIC-08 通过 `clear+activate` 间接测试同流程, 避免破坏 dev state
- **TAB-08b** textarea 聚焦 SKIP — CDP test window 无 OS-level focus, `.focus()` 调用不生效, 这是 Electron+CDP 测试固有限制 (真实用户使用 focus 正常)
- **workflow.runNow / devFireSoon** 全程不调用 — 会真实点赞 + 评论 + 消耗 newapi quota, 这俩在 workflow.mjs 严禁触发
- **D6 LLM Gateway 服务端** — Worker /admin/suspend/resume/revoke/overdue/quota / newapi user CRUD / Plan bind / 多租户隔离 / Cloudflare Tunnel 不在 client E2E 范围, 详见 TESTING.md §3.12 服务端验证清单 (admin curl 手动验证)
- **真实小红书 API 链路** — list_feeds / like_feed / post_comment_to_feed / publish_content 不实测, 仅验证工具 schema + 敏感操作集合
- **真实 LLM 调用** — chat / tools-agent 套件会真调中转 (消耗 quota, 不阻塞), workflow 不真调
- **scheduler 时钟漂移**: powerMonitor.on('resume') 行为, 需 sleep/wake 物理动作, 不入 E2E
- **连续 3 fail auto-disable**: 需模拟 3 次 LLM timeout, 涉及真调 LLM, 不入 E2E
- **queue 串行 2 个 enabled workflow 同时到点**: 需 runNow 触发, 不入 E2E
- **missed_run**: 需 kill app + 调系统时间, 不入 E2E

## 建议

### 立即处理 (v0.7 ship 前)
1. **Bug 1 (web_search)**: 优先级 P1, 切 DuckDuckGo 或修 sogou 新 DOM, 影响 AI 联网搜索可用性
2. 跑 `tests/e2e/run-all.mjs` 现在 243/247 pass + 2 skip + 2 fail, 这俩 fail 都来自 Bug 1, 修了就 245/247 pass

### v0.7 ship 检查清单 (建议加入 CI / 手动 release checklist)
1. `cd app && npm run typecheck` (必须通过)
2. `node tests/e2e/run-all.mjs` (≥99% pass, 排除 web-search 已知 bug)
3. 手动验证 M7 工作流 UI 路径 (新建 → 启用 → 风险确认 dialog → list 显示 → 删除)
4. 手动 dev 模式跑 1 个 daily_like_comment workflow (用 dev sandbox 账号) 验证 scheduler / template / 实时进度 push
5. 服务端: Worker /admin/codes 发码 1 个 + /activate + /admin/suspend + /admin/resume 验证 D6 多租户隔离
6. Cloudflare Tunnel: `curl https://llm-cf.maxwellii.com/v1/health` 验通 (新部署的 D6 入口)

### 工程改进
- **_helper.mjs 硬编码 LICENSE.code** 与 dev 实际 KV 状态可能漂移, 建议改为启动时调 `license.status()` 动态读取 (节省每次 dev 重启都要手动改 _helper.mjs)
- **GO_BASE 常量** (_helper.mjs:7 `http://127.0.0.1:54092`) 已失效 (Go 现用 `--port=0` 动态端口), 应删除或改为读 `goStatus().baseUrl` (当前并未实际使用, 不阻塞测试)
- **CDP_PORT_CANDIDATES** 维护成本: 每次 dev 重启都可能换端口, 建议改为扫常用端口范围 (`60000-65535` 任意 LISTEN tcp) 或读 Electron `.user-data-dir` 里的 DevToolsActivePort 文件

---
**生成于 2026-05-20 · 跑 `tests/e2e/run-all.mjs` 在 main@cb94be9**
