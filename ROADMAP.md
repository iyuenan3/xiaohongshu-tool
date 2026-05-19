# 小红书自运营系统 ROADMAP

> 路线图 v0.5 · 2026-05-19 · 配套 PRD v0.6 + SPEC v0.3
>
> **v0.5 变更 (2026-05-19)**: D6 LLM Gateway 中转站方案拍板, M6 新增独立 milestone (一码一 newapi user + bind XHS Plan 自营中转, 详见 §13)。M5 已结, M7 (公测发售) 排到 M6 之后, 依赖 D3/D5 决策。
>
> **v0.4 变更 (2026-05-17)**: 实际开发节奏远超原 10 周计划。M1~M4 全部完成, M5 (公测打磨) 的核心功能也已 ship (v0.2.0 ~ v0.3.0): 4-tab UI / 智能素材库 / 联网搜索 / dmg 引导 / 网页管理后台 / 7 次发版迭代修各种 build pipeline 问题。
>
> 实际版本里程碑:
> - v0.1.0 (M3 商业化收尾) - 已 ship
> - v0.2.0 ~ v0.2.7 (UI 重构 + 素材库 + vision + mac 打包流水线 7 次迭代) - 已 ship
> - v0.3.0 ~ v0.3.2 (联网搜索 / E2E bug 修 / 更新策略 + 内测日志) - 已 ship
> - v0.6.0 (D6 LLM Gateway 实施) - **进行中 M6 (2026-05-19+)**
> - v0.7.0 (公测发售 M7) - 待 D3/D5 决策

## 0. 总览

| 阶段 | 周次 | 日历范围 | 主目标 | 状态 |
|---|---|---|---|---|
| **M1 PoC** | W1-W2 | 2026-05-18 → 2026-05-31 | 验证 CDP attach 架构 + 单工具跑通 | ✅ |
| **M2 内核完成** | W3-W5 | 2026-06-01 → 2026-06-21 | 11 工具全跑通 + AI 侧边栏 | ✅ |
| **M3 商业化** | W6-W7 | 2026-06-22 → 2026-07-05 | License 系统全链路 | ✅ |
| **M4 跨平台 + 自动更新** | W8 | 2026-07-06 → 2026-07-12 | macOS + Windows **无证书**打包 + 自动更新 | ✅ |
| **M5 公测打磨** | W9-W10 | 2026-07-13 → 2026-07-26 | UI 重构 / 素材库 / 联网搜索 / 12 次发版迭代 | ✅ |
| **M6 LLM Gateway 实施** | 2026-05-19 → 2026-05-22 | (并入实际开发节奏, 2-3 天) | **D6 自营中转站, 一码一 newapi user + bind XHS Plan + suspend/resume 机制** | 🔧 |
| **M7 公测发售** | 待 D3/D5 决策 | TBD | 种子用户灰度 + 首发 | ⏳ |

**首版预计发售**：M6 完成后, 待 D3/D5 决策再排

**说明**：周计划，关键节点拆到日级（标 `🔑` 的为关键路径里程碑，失败会延期整个项目）。

**v0.2 主要变更**：无证书发布决策（PRD v0.3）→ M4 缩短 1 周（W8-W9 → W8）→ 发售提前 1 周。

**v0.3 主要变更**（2026-05-16）：M3 W6 提前完成（License Worker 服务端 + admin CLI + E2E 测试 11/11 通过）。D1/D2/D4 决策拍板（PRD v0.4）。

## 1. 关键路径

```
[CDP attach 验证] ────► [11 工具接通] ────► [AI 侧边栏 + Loop] ────► ...
       ↑
       这一步失败要回退架构（双 Chromium 方案）

[首次启动指引文档] ───────────────────► [M4 发布]
       ↑
       无证书后唯一关键依赖：用户教育材料必须就绪
```

无证书后**不再需要**：Apple Developer 申请、Windows 代码签名证书申请（关键路径上的两个最长流程消失）。

## 2. M1 · PoC（W1-W2）

> **目标**：把"Electron Chromium 通过 CDP 给 Go 用"这条路走通，证明架构可行。

### Entry Criteria

- [x] PRD v0.3 + SPEC v0.1 审核通过
- [ ] 本地开发环境就绪（Node 20、Go 1.24、Xcode CLT）

### W1（2026-05-18 → 2026-05-24）

#### Day 1-2 · Electron 脚手架

- 初始化项目：`electron + vite + react + typescript`
- 配置 `electron-builder` 基础
- 跑通 main 进程 + renderer 进程 + IPC contextBridge
- 提交 commit 0：Hello World 能启动

#### Day 3-4 · Go 端改造

- 在 `xiaohongshu-mcp` 新分支开发：
  - `main.go` 加 `--cdp-endpoint` 参数
  - `browser/browser.go` 加 `WithCDPEndpoint` Option + attach 实现
  - `--port=:0` 支持 + stdout 输出实际端口
  - 新增 `/internal/attach` 接口
- 单元测试：手动开 Chrome `--remote-debugging-port=9222`，跑 Go 命令验证 attach 成功

#### Day 5-7 · CDP 联调 🔑

> **关键日级里程碑** —— 失败要立刻评估回退

- Electron `appendSwitch('remote-debugging-port', '0')`
- 启动后通过 `/json/version` 拿 `webSocketDebuggerUrl`
- Main spawn Go subprocess，传 env + 调 `/internal/attach`
- Go 端 `rod.New().ControlURL(ws).MustConnect()`
- 验证：在 Electron 窗口打开小红书，Go 端能 `page.Info()` 拿到 URL

**风险**：Electron 默认 webContents 隔离机制可能导致 go-rod 看不到主窗口的 page。如果出现 → 见 §7 回退方案。

### W2（2026-05-25 → 2026-05-31）

#### Day 8-10 · 单工具端到端

- 在 Electron 窗口扫码登录小红书（人工操作）
- cookies 自动写到 `userData/cookies.json`（Go 端处理）
- Renderer 写一个简陋按钮：手动填标题/内容/图片 → 通过 IPC 调 `mcp:call("publish_content", args)`
- Main 转发到 Go HTTP `/api/v1/publish`
- 验证：能成功发布一篇测试笔记

#### Day 11-12 · 联调收尾

- Bug fix：CDP 断连重连、Go 进程崩溃恢复、端口冲突等
- 编写《PoC 验证报告》：截图 + 录屏 + 已知问题清单

#### Day 13-14 · 缓冲

- 留 1-2 天缓冲应对联调中的意外
- 若提前完成则启动 M2 准备工作（设计 AI 侧边栏 UI 草图）

### Exit Criteria

- ✅ Electron 启动后能看到小红书首页
- ✅ 用户能在 Electron 窗口扫码登录
- ✅ `publish_content` 工具端到端跑通（手动触发，无 AI 参与）
- ✅ Go subprocess 启动/退出/崩溃恢复行为符合预期
- ✅ 《PoC 验证报告》产出

### 并行任务（不阻塞但要启动）

- ✂️ ~~申请 Apple Developer ID~~（v0.3 决策无证书后取消）
- ✂️ ~~了解 Windows 代码签名证书申请~~（同上）
- ℹ️ 开始草拟《首次启动指引》文档大纲（macOS + Windows 两份截图教程）

## 3. M2 · 内核完成（W3-W5）

> **目标**：11 个 MCP 工具全跑通 + AI 侧边栏（火山方舟单 Provider 起步）<br>**实际**: M2 ship 11 个 Go 工具, v0.2/v0.3 增量再加 1 Go (`favorite_feed`) + 2 renderer local (`search_local_assets` / `web_search`) = 当前共 14 个

### W3（2026-06-01 → 2026-06-07）

#### 接通剩余 10 个 MCP 工具

按优先级分组：

**Day 15-16** 读操作（无风控风险，先做）：
- `check_login_status`
- `list_feeds` / `search_feeds`
- `get_feed_detail`
- `user_profile` / `my_profile`

**Day 17-19** 写操作（有风控，加频率护栏）：
- `publish_with_video`
- `post_comment_to_feed` / `reply_comment_in_feed`
- `like_feed` / `favorite_feed`

**Day 20-21** 频率护栏 + 错误处理：
- SQLite `rate_log` 表 + `checkGuard()` 实现
- 错误码统一封装
- 单元测试

### W4（2026-06-08 → 2026-06-14）

#### AI 侧边栏 UI

**Day 22-23** UI 骨架：
- 侧边栏可折叠组件
- 消息列表 + 输入框
- Markdown 渲染（用户内容） + 工具调用气泡

**Day 24-25** BYOK 配置：
- 设置页 - AI 配置 tab
- 火山方舟单 Provider 接入
- API key 用 safeStorage 加密存储
- "测试连接"按钮

**Day 26-28** Tool Calling Loop：
- `openai-node` 集成
- 启动时 `mcp:listTools` 拉 schema
- 转换为 OpenAI function 格式
- 流式响应处理 + tool_call 累积逻辑
- 多轮 loop 实现

### W5（2026-06-15 → 2026-06-21）

#### 敏感操作 + 上下文 + 测试

**Day 29-30** 敏感操作确认：
- 全局确认对话框组件（Portal + useImperativeHandle）
- 4 类敏感操作分支：publish / comment / like / favorite
- 设置里"自动模式"开关

**Day 31-32** 对话历史：
- SQLite `conversations` + `messages` 表
- 启动恢复 / 新建 / 切换 / 删除
- 侧边栏顶部历史列表

**Day 33-34** 页面上下文感知：
- `webContents.executeJavaScript` 抓 URL/title/innerText
- 注入 system prompt

**Day 35** 端到端验收：
- 真实场景测试："写一篇关于咖啡的笔记并发布"
- AI 自主调用 generate_cover + publish_content
- 记录 bug → 立即修

### Exit Criteria

- ✅ 11 个工具全部能通过 AI 调用 (M2 当时基线; 当前 v0.3 扩展为 14 个)
- ✅ 流式响应 UI 顺畅，无卡顿
- ✅ 敏感操作弹确认且 UI 一致
- ✅ 应用重启后历史对话保留
- ✅ 频率护栏触发后弹软提示

### 并行任务

- ⚠️ **决策 D1（售价）/ D2（试用版）/ D4（法律主体）** ← 阻塞 M3 启动
- ℹ️ 《首次启动指引》文档草稿撰写（V2 还会复用）

## 4. M3 · 商业化（W6-W7）

> **目标**：License 系统全链路打通

### W6（2026-06-22 → 2026-06-28）· License Worker 服务端

**Day 36-37** Cloudflare Worker 项目：
- `wrangler init license-worker`
- 创建 KV namespace
- Ed25519 keypair 生成（本地用 Node `crypto.generateKeyPairSync`）
- 私钥放 `wrangler secret put SIGNING_PRIVATE_KEY`
- 公钥导出 → 后续打包进客户端

**Day 38-40** 实现接口：
- `/activate` 完整逻辑（含所有错误分支）
- `/heartbeat` （含 token 自动续期）
- `/admin/codes` 批量生成
- `/admin/revoke` / `/admin/rebind`
- ADMIN_TOKEN 验证 + rate limit

**Day 41-42** 测试 + 部署：
- 单元测试覆盖关键路径
- 部署到 `xhs-license.<account>.workers.dev`
- 写 admin CLI 脚本（你日常用）：`./xhs-license issue --count 1 --notes "..."`

### W7（2026-06-29 → 2026-07-05）· 客户端 License

**Day 43-44** LicenseManager：
- `node-machine-id` 集成 + 加盐 SHA-256
- Ed25519 验签（公钥写在 native addon 或混淆 JS）
- safeStorage 存 token
- 状态机：unactivated / active / expired / revoked / mismatch

**Day 45-46** 激活页 UI：
- 输入框 + "复制机器码"按钮
- 错误状态友好提示（参照 SPEC §9.1 错误码）
- 激活成功 → 跳转 onboarding

**Day 47-48** 启动流程改造：
- License Check 优先级最高，未激活直接路由到激活页
- 心跳 scheduler（每 15 天 + 退避重试）
- 心跳响应处理（吊销 / 强制更新 / token 续期）

**Day 49** asar 加固：
- electron-builder `asar: true` + `asarUnpack` 例外
- 关键校验逻辑分离到独立 minified file
- 反 DevTools 检测

### Exit Criteria

- ✅ 你能在 Worker 后台批量生成 10 个激活码
- ✅ 客户端激活流程跑通（含错误分支）
- ✅ 模拟"吊销"：调 `/admin/revoke` 后客户端 15 天内（实测加速时间）失效
- ✅ 模拟"换绑"：调 `/admin/rebind` 后客户端能用新机器码激活
- ✅ asar 加密生效，普通用户无法解包看到源码

### 并行任务

- 准备用户协议草稿 / 隐私协议草稿（无证书后用户协议要加"未签名软件，请按指引允许"声明）
- ℹ️ 《首次启动指引》文档：截图 + 步骤定稿

## 5. M4 · 跨平台 + 自动更新（W8）

> **目标**：双平台**无证书**安装包能在干净系统上跑（用户按指引允许后）

**v0.3 变更**：原 W8-W9 两周（含公证 + 签名）缩短为 **W8 单周**，全部砍掉证书相关任务。

### W8（2026-07-06 → 2026-07-12）

**Day 50-51** macOS 打包（无证书）：
- `electron-builder` `build.mac` 配置（dmg + zip）
- `hardenedRuntime: false`（不启用，因为无签名）
- ad-hoc 签名（`identity: null`，让 electron-builder 跳过证书校验）
- 测试 dmg 在 macOS 上能挂载 + 拖到 Applications

**Day 52-53** Windows 打包（无证书）：
- electron-builder `build.win` 配置（NSIS installer + portable）
- 不调用 `signtool`
- 测试 installer 在 Win10 / Win11 上能执行

**Day 54** 实机首次启动测试 🔑：
- 干净 macOS：双击 dmg → 拖入 → 启动出现 Gatekeeper 警告 → 验证《指引》能引导用户绕过
- 干净 Win10/11：双击 installer → 出现 SmartScreen → 验证《指引》能引导用户绕过
- 录屏作为《首次启动指引》素材

**Day 55** 自动更新：
- `electron-updater` 集成
- GitHub Releases 作为 update channel
- 注意：未签名更新需要禁用签名校验（`requestHeaders` + 平台配置）
- 模拟更新场景（发布 0.9.0 → 0.9.1 → 客户端检测并升级）

**Day 56** 接入剩余 Provider + 缓冲：
- DeepSeek 官方
- OpenAI 兼容自定义（baseURL + key + model 三字段）
- 缓冲应对意外

### Exit Criteria

- ✅ macOS dmg 在干净系统上能安装，**用户按指引能顺利启动**
- ✅ Windows installer 在干净系统上能安装，**用户按指引能顺利启动**
- ✅ 《首次启动指引》macOS + Windows 各一份截图教程定稿
- ✅ 自动更新流程跑通（手动触发 + 静默模式）
- ✅ 3 个 Provider 全部能切换使用

### 并行任务

- ⚠️ **决策 D3（产品全名+域名）** —— 影响官网准备

## 6. M5 · 公测打磨（W9-W10）

> **目标**：种子用户灰度 + 发售流程演练

### W9（2026-07-13 → 2026-07-19）· 种子灰度

**Day 57-59** 招募 + 分发：
- 5-10 个种子用户（朋友 / 小红书运营圈熟人 / 知乎自荐）
- 免费提供激活码 + 收集反馈承诺
- 建微信群作为反馈通道
- **特别观察**：用户是否能顺利完成首次启动（无证书的最大变数）

**Day 60-63** 反馈循环：
- 每日收集 → 优先级排序 → 修复
- P0 bug 24h 内修复 + 紧急更新推送
- 首次启动失败案例单独追踪 → 改进《指引》文档

### W10（2026-07-20 → 2026-07-26）· 发售准备

**Day 64-65** 文档与协议：
- 用户协议 + 隐私协议 final（含"未签名软件免责"条款）
- 软件使用文档（如何激活、配置 BYOK、常见问题）
- 火山方舟注册指引文档（带截图）
- 《首次启动指引》正式发布

**Day 66-67** 发售页面：
- 简易官网或落地页（可暂用 GitHub Pages / Vercel）
- 购买入口（先用支付宝/微信收款码图片，引导加微信付款）
- **首次启动指引链接放醒目位置**
- 客服 SOP（响应模板 / 常见问题处理）

**Day 68-69** 演练 + 上线：
- 完整走一遍"用户买 → 你发激活码 → 用户激活 → 使用 → 反馈"
- 发售（先小规模发布到朋友圈 / 即刻 / V2EX）

### Exit Criteria

- ✅ 种子用户使用 1 周无 P0 bug
- ✅ 首次启动成功率 > 90%（剩余 10% 通过客服指导解决）
- ✅ 用户协议法律审查通过
- ✅ 发售页 + 客服 SOP 上线
- ✅ 至少完成 1 单真实付费交易

## 7. 风险节点与回退方案

| 风险 | 触发条件 | 回退方案 | 影响 |
|---|---|---|---|
| **CDP attach 失败** | W1 Day 7 联调跑不通 | 双 Chromium 方案：UI 跑 Electron 默认，go-rod 自启独立 Chrome，cookies 共享 | 失去"操作可见"卖点，但能上线 |
| **无证书首次启动失败率高** | W8-W9 实测发现用户绕不过 Gatekeeper / SmartScreen | 加强《指引》文档（视频教程）+ 客服一对一指导；最后兜底买证书 | 转化率拉低，可能延期 |
| **小红书反爬升级** | 任何时间 | 紧急更新 stealth 注入 / UA / 选择器；通过自动更新强推 | 1-3 天恢复 |
| **火山方舟 API 大变更** | 任何时间 | 切换到 DeepSeek 官方作为默认 | 引导用户重配 BYOK |
| **种子用户反馈大量 P0** | W9 | 推迟 W10 发售，先稳定 | 发售延期 1-2 周 |
| **electron-updater 无签名更新无法推送** | W8 Day 55 | 用 GitHub Release 直链 + 应用内手动提示 | 用户要手动下载新版 |

## 8. 与待决策清单的对应

PRD §10 的 D1-D5 需要在不同 milestone 前敲定：

| 决策 | 议题 | 状态 | 截止节点 |
|---|---|---|---|
| ✅ D1 | 售价 | 挂牌 ¥399 + 客服议价（v0.4 / 2026-05-16） | — |
| ✅ D2 | 试用版 | 无（仅 demo 视频/截图）（v0.4 / 2026-05-16） | — |
| D3 | 产品名 + 域名 | 待决策 | W10 开始前 |
| ✅ D4 | 法律主体 | 个人名义（销量验证后升级个体户）（v0.4 / 2026-05-16） | — |
| D5 | 支持渠道 | 待决策 | W10 结束前 |

## 9. 资源 / 成本预算（10 周内）

**v0.3 变更**：砍掉 Apple Developer ¥720 + Windows 代码签名证书 ¥1,000-2,000，总现金支出从 ¥3,000 降至 ~¥100。

| 项 | 一次性 | 重复 |
|---|---|---|
| ~~Apple Developer~~ | ~~$99 (≈¥720)~~ | ✂️ 取消 |
| ~~Windows 代码签名证书（OV）~~ | ~~¥1,000-2,000~~ | ✂️ 取消 |
| Cloudflare Workers + KV | ¥0 | 免费额度足够 |
| GitHub Releases | ¥0 | 免费 |
| 域名（如 D3 决定独立域名） | ¥60-100 | 每年 |
| 时间投入 | 10 周全职 / 20 周兼职 | 一次性 |
| **总现金支出** | **~¥100**（仅域名可选） | **~¥100/年** |

LLM 费用由用户自付（BYOK），不计入。

## 10. 检查清单（每周 Friday self-check）

```
[ ] 本周交付物完成度 / 是否延误
[ ] 关键路径有无新增风险
[ ] 待决策项是否到截止节点
[ ] 下周任务是否清晰
[ ] 是否需要调整 ROADMAP
```

## 11. 版本变更

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-05-16 | 初稿（基于 PRD v0.2 + SPEC v0.1） |
| v0.2 | 2026-05-16 | 配套 PRD v0.3 无证书决策：M4 缩短为 1 周；发售提前到 2026-07-26；成本从 ¥3,000 降至 ~¥100 |
| v0.3 | 2026-05-16 | M3 W6 提前完成（License Worker 服务端 + admin CLI + E2E 11/11）。D1/D2/D4 决策拍板 |
| **v0.4** | 2026-05-17 | **v0.2.0~v0.3.0 系列 ship 完毕 (7 次迭代发版)，M5 核心功能上线。新增 §12 M5+ 待规划 (中转站 / Intel build / 仓库公私 / 上游 LLM 选型)** |

## 12. M5+ 待规划

> v0.3.0 已 ship 后, 以下功能由用户最新提出。D6 已拍板进入 M6 实施 (§13), 其他仍待决策。

### 12.1 ~~LLM Gateway 中转站 (D6)~~  → 见 §13 M6 实施

**已拍板 (2026-05-19)**: 方案 X · 一码一 newapi user + bind XHS Plan, 软件买断 + LLM 月续费 + 未续 15 天软停 → revoke 硬停。详见 §13 (本路线图) + PRD §6.7 + SPEC §12.10。

### 12.2 mac Intel 支持 (D7)

**现状**: yml matrix arm64 + x64 双 job, 私仓 GH Actions Intel runner (macos-13) free tier quota 倍率 10x, 卡 queue 1h+。

**选项**:
- 接受卡 queue, 月初 quota 重置后再 build
- 砍 x64 (单 arm64), Intel 用户拿不到包
- 仓库改 public (free macOS minutes 无 quota, 见 D8)

### 12.3 仓库公私 (D8)

**现状**: private. 优点是源码不公开,缺点是 macOS GH runner 受 quota 限。

**改 public 后**:
- 无 quota 限制 (公仓 free)
- 利于品牌曝光
- 敏感的 INFRA.md / ADMIN_TOKEN 已 gitignore 不暴露
- 客户偷代码自己 build → 没有合法激活码 + Worker 配额仍跑不起来

**评估倾向**: 公开,跟"开源前端 + 服务收费"的现代商业模式契合。

### 12.4 ~~接口架构调整 (B 路径落地后)~~ — 已被方案 X 替代

原 B 路径 (Worker 自做 LLM Gateway + 反代上游) 已在 D6 拍板时弃用, 改走方案 X (自营 newapi 中转), 见 §13 M6 实施。本节内容过时, 不再适用。

### 12.5 Build pipeline 改善

- workflow 已改 `workflow_dispatch` 仅手动触发 (省 quota)
- 发版流程标准化: 本地 typecheck + e2e → tag → gh workflow run → release

---

## 13. M6 · LLM Gateway 实施 (D6 已拍板, 2026-05-19 起)

**目标**: 把 D6 自营中转 + LLM 月续费 + suspend/resume 分级停用机制落地, 详细 spec 见 PRD §6.7 + SPEC §12.10。

### 一次性 Setup (Maxwell 操作, 阻塞性前置)

**newapi 端**:
- [x] 验证火山方舟 Pro Coding Plan ×2 + 阿里百炼 Pro ×1 渠道**已配置且 enabled** ✅ (2026-05-19)
- [x] 验证 newapi 已配 `auto-llm` model alias ✅ (2026-05-19)
- [x] 建 `xhs` group ✅ (2026-05-19, ratio=1)
- [x] 建 `XHS Plan` ✅ (2026-05-19, id=2, total_amount=68493151 占位, max_purchase_per_user=0)
- [x] 拷贝 `XHS_PLAN_ID=2` 写入 `~/.secrets/xhs-secrets.txt` ✅
- [N/A] 清空 newapi xhs-* 前缀测试 user/token — 暂无 xhs- 前缀残留, 不需操作; 其他租户 (maxwell/lijunfeng) 一律保留

**Caddy 端 (newapi-proxy 项目, 可能要同步改)**:
- [ ] 确认 Caddyfile 配 `tls internal` + sni-fallback 让 IP `139.196.157.57` HTTPS 用自签证书 (Let's Encrypt 不签公网 IP, 必须自签兜底)
- [ ] 域名 `llm.maxwellii.com` 仍走 LE 合法证书 (Worker 跨境访问用)

**Cloudflare 端**:
- [x] 清空所有 Cloudflare KV 测试激活码 ✅ (2026-05-19, 7 个 code:* 删除, 保留 config:latest_version / config:release_notes)
- [ ] Worker secrets 注入完 6 项 (见 §13 Worker 改动 → 配置, 跟 Worker 代码改动一起做)
- [ ] `wrangler deploy` 部署

### Worker 改动 (~600 行)

新增:
- [ ] `worker/src/newapi.ts` — newapi client 封装 (createUser / bindSubscription / createToken / deleteUser / deleteToken / updateTokenStatus / invalidateSubscription / getUserSubscriptions / **`assertXhsTenant(env, userId)`** 多租户隔离护栏)

修改:
- [ ] `POST /admin/codes` — 同步建 newapi 3 件套 + 强一致回滚
- [ ] `POST /activate` — 响应加 `llm: { base_url, api_key, model }` + `status` 字段
- [ ] `POST /heartbeat` — 响应加 `llm` + `status` (允许 Maxwell 改 IP / suspend 后客户端 catch)
- [ ] `POST /admin/revoke` — 同步 disable newapi token (status=2) + KV status=revoked
- [ ] `POST /admin/rebind` — 不动 newapi (LLM 跟 machine 解耦); suspended/revoked 状态拒绝换绑

新端点:
- [ ] `GET /quota?code=...&sig=...` — Worker 中转查 subscription quota
- [ ] **`POST /admin/suspend`** (v0.6 D6) — 软停: 检查 KV status==='active' (否则返回 INVALID_STATE + current + hint) + newapi token disable + KV status=suspended + 记 suspended_at + suspend_reason
- [ ] **`POST /admin/resume`** (v0.6 D6) — 恢复: 检查 KV status==='suspended' (否则返回 INVALID_STATE + current + hint) + newapi token enable + KV status=active + 记 resumed_at, **不补 quota** (suspend 期已用部分不返还)
- [ ] **`POST /activate`** (v0.6 D6 调整) — 入口加 status 过滤: revoked/suspended 拒绝重激活 (防清重装绕过), unused → 绑机+active, active+match → 重激活同机
- [ ] **`POST /heartbeat`** (v0.6 D6 调整) — 响应加 `status` + `suspend_reason` + `llm` 字段, 客户端 diff 触发 license 更新

Admin UI (`worker/src/admin-ui.ts`):
- [ ] 列表行加 "暂停 / 恢复" 操作按钮 (status=active 显示暂停; status=suspended 显示恢复)
- [ ] status filter 加 "suspended"
- [ ] 列表显示 suspended_at + suspend_reason (suspended 状态时)
- [ ] 显示距离 15 天硬停的剩余天数 (运营参考), ≤ 3 天用红色高亮
- [ ] 加 "超期清单" tab (`GET /admin/overdue` 端点, 列出所有 suspended_at + 15d < now 的码), 周末巡检用

配置:
- [ ] Worker secrets 6 项: NEW_API_BASE_URL / NEW_API_ACCESS_TOKEN / NEW_API_USER_ID / XHS_PLAN_ID / XHS_NEWAPI_GROUP / XHS_LLM_BASE_URL

### 客户端改动 (~400 行)

主进程:
- [ ] `src/main/index.ts` — `app.on('certificate-error')` 仅对 139.196.157.57 放行
- [ ] `src/main/license.ts` — license.json schema 加 `llm` / `byok` / `dev_mode` 字段, push 通道 payload 扩展
- [ ] `src/main/ipc.ts` — 加 `llm:getQuota` IPC

Renderer:
- [ ] `src/renderer/src/ai/byok.ts` → 读 license.llm (默认), dev mode 下读 license.byok
- [ ] `src/renderer/src/ai/agent.ts` — 写死 model='auto-llm' (中转模式), catch `insufficient_quota` → 锁 + dialog, catch `401/403` → refreshLicense + suspend dialog
- [ ] `src/renderer/src/components/Settings.tsx`:
  - 加 "AI 调用额度" 区块 (启动 + chat 完成后异步刷新)
  - 加 "故障排查 / 反馈" 区块 (常驻反馈框, onChange 检测暗号解锁 dev, 暗号见 `~/.secrets/xhs-secrets.txt`)
  - dev 模式后显示 BYOK 配置区 + 切换开关
- [ ] `src/renderer/src/components/ChatPanel.tsx` — **isChatLocked 状态机**: license.status===revoked 或 ===suspended 或 quota.remain_cny ≤ 0 三种触发都 disable 输入框 + Send 置灰 + banner (文案各不同, 详见 SPEC §12.10.9)

### 联调 + 测试

- [ ] 黑盒 E2E: 发码 → 激活 → chat → newapi UI quota 减 → 配额耗尽 dialog → 暗号解锁 BYOK → 切换 BYOK 调用通过
- [ ] cert-error 测试: cert 不放行 IP 应拒绝, 放行 IP 应连通
- [ ] heartbeat base_url 变更测试: 改 Worker secret XHS_LLM_BASE_URL + redeploy, heartbeat 后客户端自动 catch
- [ ] 强一致回滚测试: newapi 故意宕机, /admin/codes 应整体失败, 不留半残资源
- [ ] **suspend/resume 测试** (v0.6 D6): /admin/suspend → newapi token disabled + KV status=suspended + heartbeat 返回 status → ChatPanel 锁 + suspend banner; /admin/resume → token enable + status=active + heartbeat 返回 → ChatPanel 立即解锁
- [ ] **revoke 测试** (v0.6 D6): /admin/revoke → status=revoked + heartbeat 返回 → 全应用 revoked banner
- [ ] **多租户隔离测试** (v0.6 D6, SPEC §12.10.13): 构造 KV `{newapi_user_id: 1}` (maxwell root) 或 `{newapi_user_id: 2}` (lijunfeng) 调 /admin/suspend → assertXhsTenant 应拒绝, 不影响其他租户; 正常 xhs- user → 通过

### 工程量预估

| 任务 | 时间 |
|---|---|
| Worker 改动 + 部署 + cert/secret 联调 | 1 天 |
| 客户端改动 + dev 模式联调 + cert-error 适配 | 1 天 |
| 黑盒 E2E + 文档同步 + buffer | 0.5-1 天 |
| **合计** | **2-3 天** |

> 注: 初估 1.5-2 天偏紧, ~1000 行新增 + cert 联调 + dev mode UX 调试经验上至少 2 天, 加 buffer 取 2-3 天。

### Exit Criteria

- [ ] 测试激活码走完整流程 (发码 → 激活 → chat → quota 减) 无错
- [ ] BYOK dev 模式暗号解锁链路通过
- [ ] 配额耗尽 UX 正确 (输入框 disable + banner + 暗号入口仍可用)
- [ ] PRD/SPEC/ROADMAP/INFRA 同步更新完成

### Blocker

- [ ] 一次性 setup 完成 (Maxwell 建 xhs group / XHS Plan / 清测试码 / 给 plan_id)

---

**文档结束 · ROADMAP v0.4**
