# 小红书自运营系统 · E2E 测试报告

> 版本 v0.1 · 2026-05-17 · 针对 PRD v0.5 / SPEC v0.2 / ROADMAP v0.4 · 客户端 v0.3.0
>
> 测试方法: 黑盒 E2E (CDP attach + `window.api.*` IPC + Worker admin API), 不读 `app/src/` 源码
> 运行环境: macOS Tahoe (Darwin 25.4.0) · Electron 38.8.6 · Node 22 · BYOK 未配置
> 测试目录: [`tests/e2e/`](./tests/e2e/) · 策略文档: [`TESTING.md`](./TESTING.md)
> 完整原始输出: `tests/e2e/last-run.json`

## 1. 总览

| 指标 | 值 |
|---|---|
| 测试模块数 | 10 |
| 测试用例数 (含子断言) | **167** |
| **通过** | **164** |
| 失败 | **0** |
| 跳过 | 3 |
| 模块全 0 退出码 | 10 / 10 |
| 总运行时长 | ~21 s |

### 1.1 模块结果

| 模块 | 文件 | exit | pass | fail | skip | 耗时 |
|---|---|---|---|---|---|---|
| License | `license.mjs` | 0 | 14 | 0 | 1 | 7.4 s |
| IPC Surface | `ipc-surface.mjs` | 0 | 39 | 0 | 0 | 0.1 s |
| Assets | `assets.mjs` | 0 | 26 | 0 | 0 | 1.2 s |
| Chat / Conv | `chat.mjs` | 0 | 21 | 0 | 0 | 0.1 s |
| Tabs / UI | `tabs.mjs` | 0 | 15 | 0 | 1 | 1.0 s |
| Rate Limit | `rate-limit.mjs` | 0 | 6 | 0 | 0 | 0.1 s |
| Web Search | `web-search.mjs` | 0 | 9 | 0 | 0 | 5.9 s |
| Tools / Agent | `tools-agent.mjs` | 0 | 13 | 0 | 1 | 0.1 s |
| Errors | `errors.mjs` | 0 | 10 | 0 | 0 | 1.6 s |
| Integration | `integration.mjs` | 0 | 11 | 0 | 0 | 3.3 s |
| **合计** | — | **0/10** | **164** | **0** | **3** | **~21s** |

### 1.2 跳过说明

| ID | 模块 | 原因 |
|---|---|---|
| LIC-07 | license | `license.clear()` 会清掉 dev 激活态; 测完无法自动恢复, 故跳过 |
| TAB-08b | tabs | CDP 测试时 `document.hasFocus()=false`, Electron `.focus()` 在 OS-level 无 focus 时不生效; 用户真实操作 (有 focus) 时此行为应该正常 |
| TOOL-09b | tools-agent | BYOK 未配置 (localStorage 没 byok 相关 key), 故 vision 分析 `analyzeImage` 无法测; 真机用户配 BYOK 后此路径应可工作 |

## 2. 5 大测试类别覆盖回顾

| 类别 | 已覆盖用例 (举例) |
|---|---|
| 1 · 正常路径 | LIC-01~03 / IPC-11~15 / AST-01~05 / CONV-01~08 / WEB-02 / TAB-01~06 |
| 2 · 异常输入 | LIC-04~05 (错码/不存在码) / AST-18 / WEB-06 / CONV-09/12 / ERR-01~08 |
| 3 · 状态机错误 | LIC-04 (worker reject) / ERR-04~05 (activate 'abc' / '') |
| 4 · 边界值 | CONV-10 (1000 字 title) / CONV-11 (50 条 msg) / AST-11 (limit=2) / WEB-05 (n=1) / WEB-07 (500 字 query) |
| 5 · 链路集成 | INT-01 (上传→setTags→search) / INT-02 (上传→list→删除→404) / INT-03 (本机激活态 vs Worker admin) / INT-04 (tab 切换值保留) |

## 3. 关键发现 (文档 vs 实现偏差)

> 本节为**主要交付物**: 仅看测试通过率没有意义, 关键是与 PRD/SPEC 比对。

### 3.1 [P0] License `active` 但 renderer 卡在激活页

| 维度 | 内容 |
|---|---|
| 严重度 | **Critical** |
| 发现源 | `tests/e2e/_helper.mjs` 启动时 probe |
| 现象 | 测试 dev server (Electron 已 ready) 状态下: `window.api.license.status()` 返回 `status='active'`, code 与 machine_id 完全匹配文档; 但 `document.querySelector('.activation-card')` 仍存在, 主 UI (`.tabbar` / `.chat-panel`) 没渲染 |
| 重现 | 1) 启动 dev server 等到 "Go MCP ready"<br>2) attach CDP 到 renderer page<br>3) `Runtime.evaluate('() => document.querySelector(".activation-card")')` 返非 null<br>4) 同时 `window.api.license.status()` 返 `active` |
| 触发后果 | 真实用户即使 token 仍 valid, 启动后 UI 错位; 必须手动 reload 才进主界面 |
| 解决建议 | renderer 启动时 license-check 完成后必须重新 trigger `setState`/路由; 当前怀疑首次挂载时机与 license 异步加载冲突 (v0.2.7 license.bin 文件 IO 改造后引入?) |
| 测试侧 workaround | `connect({ requireMainUI: true })` 会自动 `Page.reload` + 等 ≤4s 直到 `.tabbar__tab` 出现 |

如果这是 dev 启动后用户激活成功首次的 case, 还是 build 包之后冷启动也会重现, 需进一步实机验证。**强烈建议优先复现 + 修复**。

### 3.2 [P1] 工具计数: 文档 13 vs 实现 14

PRD §4.4 第一段写"11 个工具", SPEC §12.9 写"13 个 MCP 工具", **实际 `ALL_TOOL_SCHEMAS` 注册了 14 个**:

```
check_login_status
list_feeds
search_feeds
get_feed_detail
user_profile
my_profile
post_comment_to_feed     [SENSITIVE]
reply_comment_in_feed    [SENSITIVE]
like_feed                [SENSITIVE]
favorite_feed            [SENSITIVE]
publish_content          [SENSITIVE]
publish_with_video       [SENSITIVE]
search_local_assets      [local]
web_search               [local]
```

**两处对照表**:

| 来源 | 计数 | 偏差 |
|---|---|---|
| PRD §4.4 第一段 (P0 必须有 · 第 4 项) | 11 | 包含 `xhs_generate_cover` (**实际未注册**), 不包含 `like_feed` / `favorite_feed` (实际有) |
| SPEC §12.9 | 13 | 列了 12 工具 + `search_local_assets` + `web_search`, **少算 1 个** (实际 14) |

**修复建议**:
- PRD §4.4 工具清单更新: 删除 `xhs_generate_cover` 或确认它的状态 (是否在 P2 未做?); 加入 `like_feed` / `favorite_feed`
- SPEC §12.9 把"13 个"改为"14 个", 列表里加上 `favorite_feed`

### 3.3 [Minor] PRD §4 列 v0.2~v0.3 部分小细节

- PRD v0.5 §4 第 4 项最后一句"自动模式开关": 测试时未在设置里发现该开关入口; 但 IPC 表面也没暴露相关 endpoint。无法判定是否实现 — 仅 IPC + DOM 黑盒看不到。
- SPEC §3.2 描述 ChatSidebar 频率护栏存计数到 SQLite `rate_log`, 但 `IPC.rate.check` 返回字段含 `windowCount/windowMax/nextAvailableAt` — 与文档描述一致 (PASS, 这里记为正向确认)。

### 3.4 [Minor] license 错误码命名

SPEC §9.1 定义错误码 `LICENSE_CODE_NOT_FOUND`, 但实测 `worker /activate` 调非法 code 返回 `{ ok: false, code: 'CODE_NOT_FOUND', message: ... }` — Worker 端用的是不带 `LICENSE_` 前缀的。客户端如果直接转发可能与 SPEC 不一致。**未阻断功能, 仅命名不统一**。

可选: 在 Worker 端统一加 `LICENSE_` 前缀, 或在 SPEC §9.1 注明 "Worker 错误码不带前缀, 客户端展示前补"。

### 3.5 [Positive] 实现符合 SPEC §12 增量描述

下列实测全部符合文档:

| 项 | 文档 | 测试 ID | 实际 |
|---|---|---|---|
| `xhs-asset://` 协议 | SPEC §12.4 | AST-13 / INT-01c | content-type=image/*, 内容 ≥1KB |
| `xhs-asset://` 不存在 id | SPEC §12.4 | AST-14 / INT-02c / ERR-08 | 返 404 |
| filename 格式 `picture-YYYYMMDD-HHmmss-N.jpg` | SPEC §12.2 | AST-01 | 正则匹配 ✓ |
| LLM vision 后 `analyzed=1` + tags 入库 | SPEC §12.2 | AST-05~05d | 字段一致 |
| `search_local_assets` 本地分发 (`isLocalTool`) | SPEC §12.3 | TOOL-03 / TOOL-11 | 标记 local + IPC `assets.search` 调通 |
| `web_search` 本地分发 + 搜狗结构化结果 | SPEC §12.3 | WEB-02~07 / TOOL-04 | 返回 ≥3 条 {title,url,snippet} |
| 4 tab UI (`控制台/小红书/素材库/帮助`) | SPEC §12.1 | TAB-01~06 | 顺序 + DOM class 完全一致 |
| 5 个常用命令 (`检查登录/发布笔记/发布视频/获取首页推荐/搜索关键词`) | SPEC §12.1 (隐含 5) | TAB-07b | 顺序匹配 |
| Worker admin list 含本机绑定码 | SPEC §6 + §12.8 | LIC-06 / INT-03 | active + bound_machine_id 一致 |
| `license.bin` base64 (非 safeStorage) | SPEC §12.5 | (隐含, 启动不弹 Keychain) | 启动无 Keychain 弹窗 |
| 敏感工具集 6 个 (publish + comment + reply + like + favorite + publish_video) | PRD §4.4 + SPEC §3.2 | TOOL-08 | `isSensitive()` 全覆盖, 安全工具未误标 |

### 3.6 [Minor] preload IPC 表面与 SPEC §2.2 对照

SPEC §2.2 列了 7 个 IPC handler 名 (license:state / mcp:call / config:get 等), 但实测 preload/index.ts 实际命名是:

| SPEC 写 | 实际 (preload `window.api.*`) | 状态 |
|---|---|---|
| `license:state` | `license.status` | 改名 (功能等价) |
| `mcp:call` | `goApi(method, path, body)` | 重构 (HTTP 透传) |
| `mcp:listTools` | (不直接暴露, 客户端硬编码 schemas) | 改架构 |
| `config:get/set` | (没暴露) | 删除? 未实现? |
| `byok:test` | (没暴露) | 删除 |

**所有 30 个 `window.api` 入口都可调** (IPC-01~10 全过), 但 SPEC §2.2 的接口签名已严重过时。建议同步更新 SPEC 或在文档中标注"v0.2 重构, 详见 preload/index.ts"。

## 4. Bug 清单与严重度

| ID | 严重度 | 描述 | 影响 | 建议优先级 |
|---|---|---|---|---|
| **B-001** | **Critical** | renderer license-active 但卡激活页, 需 reload | 用户体验严重 (启动后看不到主 UI) | **立即** |
| B-002 | Major | 工具计数文档 13 vs 实现 14 | 文档误导 (不影响功能) | 下个版本 |
| B-003 | Minor | `xhs_generate_cover` 在 PRD 列但未注册 | 用户预期落差 | 下个版本 |
| B-004 | Minor | SPEC §2.2 IPC 接口列表过时 (license:state / mcp:call / config:get / byok:test 均与实际不符) | 文档误导, 新协作者会找不到 | 文档周期 |
| B-005 | Minor | Worker `/activate` 错误 `code` 不带 `LICENSE_` 前缀, SPEC §9.1 写了前缀 | 客户端做错误码 i18n 时会 mismatch | 文档周期 |

## 5. 测试范围与限制

### 5.1 已覆盖
- ✅ License 全链路 (status / heartbeat / activate 异常 / Worker admin 互验)
- ✅ IPC 表面 30 个入口 (preload/index.ts 全部声明)
- ✅ Assets 素材库 18 个 case (上传压缩 / 重命名 / setTags / search 多路 / xhs-asset 协议 / touchUsed / delete)
- ✅ Chat / Conv CRUD (create / get / setTitle / saveMessages / clearMessages / delete / list / 边界)
- ✅ Tab 切换 4 个 pane + 5 命令按钮 + 输入框预填
- ✅ 频率护栏 (publish / comment / like / favorite, 包括非法 action)
- ✅ Web search (mutex / n 边界 / 空 query / 超长 query)
- ✅ Tools/Agent (14 工具注册 / 6 敏感 / 2 local / publish_content 含 images / search schema)
- ✅ 异常 (goApi 不存在 path / activate 'abc' / activate '' / xhs-asset 非法 id / conv.get 非法 id)
- ✅ 集成链路 (上传→setTags→search→AI 可拿 path / Worker admin 与本机一致 / tab 切换值保留)

### 5.2 未覆盖 (明确)
- **真发布到小红书**: publish_content / publish_with_video 仅验 schema + IPC 不触发 Go (避风控)
- **BYOK vision 分析**: 当前 dev 无 BYOK, 跳过; SPEC §13 `analyzeImage` 工作正确性未实证
- **小红书登录态**: dev 当前未登录, 测 Go `/api/v1/login/status` 返 `XHS_WINDOW_NOT_OPEN`, 链路无法走 publish
- **跨平台打包**: dmg/nsis build 不在 E2E 测试范围 (CI 验证)
- **自动更新**: 依赖发版, 不能本地测
- **SQLite 直接读写**: 绕开 IPC 抽象层无意义, 未做
- **安全 (asar 加固 / 公钥校验)**: 反向工程测试不在范围

### 5.3 测试环境局限
- CDP attach 时 `document.hasFocus()=false`, `.focus()` 调用在 Electron 中 OS-level 不生效 → TAB-08b 跳过
- 公网图源不稳定: 用 3 个 fallback (gstatic / httpbin / picsum)
- license dev 状态共享: 不能跑 `license.clear()` 否则破坏后续测试

## 6. 复现操作

```bash
# 前置: dev server 正在跑 (CDP=53759, Go=54092)
cd /Users/maxwell/Desktop/Claude-Project/xiaohongshu-tool

# 跑全套
node tests/e2e/run-all.mjs

# 跑单个模块 (退出码 0=PASS / 1=FAIL / 2=基建挂)
node tests/e2e/license.mjs
node tests/e2e/assets.mjs
node tests/e2e/tools-agent.mjs

# 看历史结果
cat tests/e2e/last-run.json | jq '.total, .modules[] | {file, exit, summary}'
```

## 7. 后续测试建议

1. **优先复现 B-001**: 关闭 dev server, 重启, 第一次 attach renderer 立刻 probe `.activation-card` vs `license.status()`; 多 run 几次看是否每次都重现
2. 等 BYOK 配置完, 加 `tools-agent.mjs` 的 TOOL-09b 真测 `analyzeImage` 链路 (`importUrl` → 调 BYOK vision → setTags 自动写入 → search 命中)
3. 加 mock LLM 测 `agent.ts` 的 tool-calling loop (敏感工具走确认 dialog 路径)
4. 加 mock 小红书登录态测 Go publish_content 端到端 (dev cookies.json 准备好)
5. 配置 Playwright 跑 visual regression (4 tab pane 截图 diff)

---

**测试结论**: v0.3.0 已实现的核心功能 (`assets / chat / web-search / tab / IPC / license / tools`) 全部通过 E2E 黑盒验证, 但发现 1 个 Critical UI 状态 bug (B-001) 应阻断公测发售前修复, 另发现 4 处文档与实现偏差应在下个文档同步周期修正。
