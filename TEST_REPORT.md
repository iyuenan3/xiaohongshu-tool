# 小红书自运营系统 · E2E 测试报告

> 版本 v0.2 · 2026-05-17 · 针对 PRD v0.5.1 / SPEC v0.2 / ROADMAP v0.4 · 客户端 v0.3.1
>
> 测试方法: 黑盒 E2E (CDP attach + `window.api.*` IPC + Worker admin API), 不读 `app/src/` 源码
> 运行环境: macOS Tahoe (Darwin 25.4.0) · Electron 38.8.6 · Node 22 · CDP port 60334 · BYOK 未配置
> 测试目录: [`tests/e2e/`](./tests/e2e/) · 策略文档: [`TESTING.md`](./TESTING.md)
> 完整原始输出: `tests/e2e/last-run.json`

## 0. 与 v0.1 报告差分

| 指标 | v0.1 (2026-05-16) | v0.2 (2026-05-17) | 增量 |
|---|---|---|---|
| 测试用例数 | 167 | **179** | +12 |
| 通过 | 164 | **176** | +12 |
| 失败 | 0 | **0** | 0 |
| 跳过 | 3 | 3 | 0 |
| Critical / P0 bug | 1 (B-001) | **0** | -1 |
| P1 文档偏差 bug | 4 (B-002~005) | **1** (新发现 B-006) | -3 |

**结论**: 客户端代码层面 0 残留 bug, 4 份文档层面仅 1 处「11 个」残留 (B-006, 低优), 全部 v0.1 报告的 5 个 bug 均已验证 [FIXED]。

## 1. 总览

| 指标 | 值 |
|---|---|
| 测试模块数 | 10 |
| 测试用例数 (含子断言) | **179** |
| **通过** | **176** |
| 失败 | **0** |
| 跳过 | 3 |
| 模块全 0 退出码 | 10 / 10 |
| 总运行时长 | ~17.8 s |

### 1.1 模块结果

| 模块 | 文件 | exit | pass | fail | skip | 耗时 |
|---|---|---|---|---|---|---|
| License (+LIC-08 push) | `license.mjs` | 0 | **25** | 0 | 1 | 4.6 s |
| IPC Surface (+onChanged) | `ipc-surface.mjs` | 0 | **40** | 0 | 0 | 0.1 s |
| Assets | `assets.mjs` | 0 | 26 | 0 | 0 | 1.2 s |
| Chat / Conv | `chat.mjs` | 0 | 21 | 0 | 0 | 0.1 s |
| Tabs / UI | `tabs.mjs` | 0 | 15 | 0 | 1 | 1.0 s |
| Rate Limit | `rate-limit.mjs` | 0 | 6 | 0 | 0 | 0.1 s |
| Web Search | `web-search.mjs` | 0 | 9 | 0 | 0 | 5.0 s |
| Tools / Agent | `tools-agent.mjs` | 0 | 13 | 0 | 1 | 0.1 s |
| Errors | `errors.mjs` | 0 | 10 | 0 | 0 | 0.9 s |
| Integration | `integration.mjs` | 0 | 11 | 0 | 0 | 4.7 s |
| **合计** | — | **0/10** | **176** | **0** | **3** | **~17.8 s** |

### 1.2 跳过说明 (与 v0.1 一致, 非 bug)

| ID | 模块 | 原因 |
|---|---|---|
| LIC-07 | license | `license.clear()` 独立用例 (clear without re-activate) 略过, 改由新增的 LIC-08 端到端覆盖 |
| TAB-08b | tabs | CDP 测试 window 无 OS-level focus; 真机用户操作下 `.focus()` 正常 |
| TOOL-09b | tools-agent | BYOK 未配置, vision `analyzeImage` 路径无法测; 真机配 BYOK 后应工作 |

## 2. v0.1 报告 5 个 bug 验证

### B-001 [FIXED · Critical] License `active` 但 renderer 卡激活页

| 项 | 内容 |
|---|---|
| 状态 | **FIXED**, push 通道完美工作 |
| 修复方式 (用户描述, 未读源验证) | LicenseManager 加 `onChanged(cb)` listener → main `index.ts` 注册 → renderer push `license:changed` IPC → preload 暴露 `license.onChanged` → `App.tsx` useEffect 订阅 |
| 验证用例 | 新增 `LIC-08` (a~k 共 11 个子断言) |
| 验证流程 | 1) baseline 抓 DOM (有 `.tabbar` 无 `.activation-card`)<br>2) 注入 hook 累计 push 事件<br>3) `license.clear()` → 等 300ms<br>4) 检查 push count, 最新 status, DOM 状态<br>5) `license.activate(LICENSE.code)` → 等 300ms<br>6) 再次检查 |
| 实测结果 | clear 后 push count=1 + status=unactivated + `.activation-card` 出现 + `.tabbar` 消失 (耗时 < 300ms);<br>activate 后 push count=2 + status=active + `.activation-card` 消失 + `.tabbar` 重现 (耗时 < 300ms);<br>onChanged 返回的 unsubscribe function 可正常调用 |
| 衍生改造 | `_helper.mjs` 旧的 `Page.reload` workaround 已移除, 现在仅"等 .tabbar__tab 5 s 出现", 验证无需 reload 也能进主 UI |

### B-002 [FIXED · P1] 工具计数 11/13 → 14

| 项 | 内容 |
|---|---|
| 状态 | **大部分 FIXED** (主声明位置), 残留 5 处 (拆出 B-006) |
| 已修 | PRD §4.4 (14 个 + 12 Go + 2 local) · PRD §7.3 · SPEC §1.3 表格 (12+2) · SPEC §12.9 |
| 验证 | `TOOL-02` 在客户端实测 `ALL_TOOL_SCHEMAS.length === 14`, PASS |
| 残留 | 见 B-006 (PRD §1 一句话 / PRD §2 阶段表 M2 / SPEC §11 测试策略 / ROADMAP §W2~W3) |

### B-003 [FIXED · P1] xhs_generate_cover 占位工具

| 项 | 内容 |
|---|---|
| 状态 | **FIXED** |
| 修复方式 | PRD §4.4 工具清单删除 `xhs_generate_cover` |
| 验证 | `TOOL-02` 列出的 14 工具名单不含 `xhs_generate_cover`, PASS |

### B-004 [FIXED · P1] SPEC §2.2 IPC 表面文档与代码不一致

| 项 | 内容 |
|---|---|
| 状态 | **FIXED** |
| 修复方式 | SPEC §2.2 顶部加 v0.2 重构通知 (⚠️ 区块), 列出 v0.2 重命名/删除/新增的 IPC 路径, 指向 §12 + `app/src/preload/index.ts` |
| 用户视角清晰度 | 良好。文档读者会被先告知"以下接口可能过时", 再点过去看新的 §12 |
| 备注 | preload 表面在本次 E2E 已完全覆盖 (`ipc-surface.mjs` 40 条 + LIC `onChanged` 新增) |

### B-005 [FIXED · P1] 错误码前缀不一致

| 项 | 内容 |
|---|---|
| 状态 | **FIXED** |
| 修复方式 | SPEC §9.1 加 ⚠️ 命名约定说明: Worker 端响应 `code` **不带** `LICENSE_` 前缀 (例 `CODE_NOT_FOUND`); 客户端转 i18n key 时补上前缀; 给了 4 个映射示例 (CODE_NOT_FOUND → LICENSE_CODE_NOT_FOUND 等) |
| 用户视角清晰度 | 优。映射表直观, 接口工程师与 i18n 工程师不会再迷惑 |
| 验证 | E2E `LIC-04/LIC-05` 实测 Worker 返 `ok=false` + `message`, 未直接断言 `code` 命名 (这是文档一致性问题, 非运行时 bug) |

## 3. 新发现 bug

### B-006 [Low · P2] 文档残留「11 个工具」共 5 处

| 维度 | 内容 |
|---|---|
| 严重度 | **Low** (B-002 修不彻底而已, 但用户读到首屏会被误导, 仍要修) |
| 发现位置 | grep `"11 个"` 在 4 份文档 |

具体位置:

| 文件 | 行 | 上下文片段 | 建议修法 |
|---|---|---|---|
| `PRD.md` | 18 | 一句话定位: "BYOK 驱动 **11 个**原生 MCP 工具完成创作 / 发布 / 运营全流程" | 改 14 个 (首屏 hero, **优先修**) |
| `PRD.md` | 380 | 阶段表 M2: "**11 个** MCP 工具全跑通 + 侧边栏 Chat" | 改 14 个 (路线表读者会以为现状 11) |
| `SPEC.md` | 834 | §11 测试策略: "手动验收 \| **11 个** MCP 工具 + 激活流程 + 跨平台打包" | 改 14 个 |
| `ROADMAP.md` | 120 | W3 目标: "**11 个** MCP 工具全跑通 + AI 侧边栏" | 改 14 个 |
| `ROADMAP.md` | 191 | W3 Exit Criteria: "✅ **11 个**工具全部能通过 AI 调用" | 改 14 个 (或保留"全部能调用"去数字化) |

**不建议改**: `PRD.md:422` "SKILL.md 中的 11 工具描述" —— 这指上游 `x-mcp` 仓库的 `SKILL.md` 内容, 该文件本身实际是 11 工具, 不属本项目口径。

| 触发后果 | 修复路径 |
|---|---|
| 阅读者看到 PRD 首屏 "11 个" 与 §4.4 "14 个" 不一致, 产生混乱 | 单一来源原则: 数字仅在 §4.4 出现, 其他位置用"全部 MCP 工具"或链接到 §4.4 |

### B-007 [Info, 非 bug] CDP port 不稳定

| 维度 | 内容 |
|---|---|
| 严重度 | 测试基础设施 / Info |
| 现象 | 每次 dev 重启 `picked remote-debugging-port=` 随机化 (v0.1 是 53759, v0.2 是 60334), 测试 helper 需要更新 candidates |
| 已 mitigate | `_helper.mjs` 改成 `CDP_PORT_CANDIDATES` 数组按序探测, 每次 dev 重启后只需在数组顶部加新端口即可 |
| 长期建议 | 不修。Electron `picked free port` 是正确行为, 测试侧 list 维护成本低 (5 秒内的事) |

## 4. 新增/改造测试用例汇总

### 4.1 LIC-08 push 通道 E2E (新增, 11 条断言)

```
LIC-08      baseline: main UI rendered (no .activation-card, has .tabbar)
LIC-08b     clear() 触发 push (count=1)
LIC-08c     push 最新 status=unactivated
LIC-08d     300ms 内 DOM 出现 .activation-card
LIC-08e     300ms 内 .tabbar 消失
LIC-08f     activate(XHS-7WXF-K9LR-3FLR-FQAG) 返 status=active
LIC-08g     activate() 再次触发 push (count=2)
LIC-08h     push 最新 status=active
LIC-08i     300ms 内 .activation-card 消失
LIC-08j     300ms 内 .tabbar 重新出现
LIC-08k     onChanged 返回 unsubscribe function
```

技术点: 在 renderer 注入 hook (`window.__lic_pushEvents = []`), 用 `window.api.license.onChanged()` 累计 push 事件 + timestamps, 比对 clear/activate 前后 DOM 与 push 队列状态。

### 4.2 IPC-license-onChanged (新增, 1 条断言)

`ipc-surface.mjs` 在 `license` namespace 加入 `onChanged` 检查, 验证新 API 已暴露并是 function。

### 4.3 `_helper.mjs` 改造 (workaround 移除)

- **删除**: `Page.reload + 4s wait` 的 B-001 workaround
- **新增**: `mainUiTimeoutMs` 选项 (默认 5000ms), 仅等 `.tabbar__tab` 出现, 不 reload
- **新增**: `CDP_PORT_CANDIDATES` 数组 + `probeCdpPort()`, 解决 dev 重启端口变更问题
- **实测**: 现在 `_helper` 启动时 0ms 内就抓到 `.tabbar__tab` (因为 B-001 已修, baseline 即主 UI), 完全不进 wait loop

## 5. 总结

> v0.2 测试报告核心结论一句话:
> **B-001 push 通道修复彻底, 客户端代码层 0 残留 bug; 14 工具计数文档仍有 5 处「11 个」残留 (B-006, Low), 建议 PRD §1 一句话 + §2 阶段表两处优先修, 其余可在下次 D 文档同步时一并清理。**
