# 小红书自运营系统 PRD

> 版本 v0.7 · 2026-05-20 · 工作流自动化 (定时点赞 / 评论 / 发布 / 数据快照)

## 0. 版本变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-05-15 | 初稿（路线 B：服务端反代 LLM + 卖 token） |
| v0.2 | 2026-05-15 | 重大调整：切换到路线 A（完全本地化 + BYOK）。卖 token 业务剥离为独立项目 |
| v0.3 | 2026-05-16 | 决策无证书发布：砍掉 Apple 公证 + Win 代码签名，接受首次启动用户教育成本 |
| v0.4 | 2026-05-16 | M3 决策拍板：D1 挂牌 ¥399 客服议价、D2 不提供试用、D4 个人收款。M3 服务端 5 接口 + admin CLI 实现完成（E2E 测试 11/11 通过） |
| v0.5 | 2026-05-17 | v0.2 ~ v0.3 系列功能 ship：4-tab UI 重构 / 智能素材库 / 📎 附件 + xhs-asset:// 协议 / 联网搜索 / 网页管理后台 / dmg 内嵌「首次安装.command」+ 0 Keychain. 中转站方案 (E)：待用户决策 |
| v0.5.1 | 2026-05-17 | 黑盒 E2E 测试 (subagent 跑 164/167 pass) 发现 5 个 bug, 修完: B-001 license 状态变化 push 通道; B-002 工具计数 11/13 → 14; B-003 删 xhs_generate_cover 占位; B-004 SPEC §2.2 加 v0.2 重构通知; B-005 §9.1 错误码前缀约定明确 |
| **v0.6** | **2026-05-19** | **D6 拍板：自营 LLM 中转方案 (newapi 网关 + 一码一 newapi user + bind XHS Plan)。商业模式：软件一次性买断 + LLM 月费另收 (newapi VIP Plan monthly reset, 维护者运营时定价)。未续费 → token suspend + chat 锁 + 15 天后 revoke (分级停用)。BYOK 默认 UI 隐藏, dev 模式暗号解锁逃生口。详见 §6.7 + SPEC §12.10** |
| v0.6.1 | 2026-05-20 | D6 实施完成 (M6 ship): Worker v0.6.0 deploy + 客户端 v0.6.0 ship. Cloudflare Tunnel `llm-cf.maxwellii.com` 接通 (newapi-proxy 项目侧). newapi.ts 适配 newapi 真实 API 行为 (POST 不返 data + UserAuth 严格 + cookie 登录). suspend/resume/revoke 改 admin 端点. createUser 显式传 group=xhs 多租户隔离. 真实 E2E 验证: agent.ts → IP 直连 → newapi xhs group → 火山方舟 doubao 返中文 |
| **v0.7** | **2026-05-20** | **工作流模块拍板 (M7 计划): 控制台左侧 3 段 (常用命令 3 个 + 工作流 + 会话列表). 5 个 MVP 模板 (👍 每日点赞评论 / ⏰ 定时发布 / ✍️ 签到式互动 / 📊 数据快照 / 🔍 关键词搜索点赞评论). 技术路线: 固定骨架 + AI 填补 (创意步骤交 LLM, 流程硬编码). 调度: 简化下拉 (每天/每周/每隔X小时) + ±10min 随机抖动 + 步间 30-90s 延迟. 风控: 步骤硬上限 + 首次启用弹"风控注意"对话框 + 连续 3 次 fail auto disable. MVP 路径: P1 (引擎+1 模板) → P2 (剩 4 模板) → P3 (polish). 详见 §4 末尾工作流自动化 + SPEC §13** |

## 1. 产品定位

一句话：**一个内置 AI 助手的小红书桌面浏览器，登录即用、完全本地化、零配置 LLM (自营 newapi 中转 + auto-llm 智能调度) 驱动 14 个工具 (12 个 Go MCP + 2 个 renderer 本地) 完成创作 / 发布 / 运营全流程。**

- 形态：基于 Electron + Chromium 内核的专用浏览器
- 内嵌：`xiaohongshu-mcp` Go 服务（不对外暴露）
- AI：侧边栏 Chat，**自营 LLM 中转 (newapi 网关 + auto-llm 智能调度)，客户零配置；BYOK 默认 UI 隐藏，dev 模式暗号解锁逃生口**
- 商业模式：软件一次性买断 + 激活码授权 + LLM 服务费月续 (未续费 → 分级停用)
- 服务端：Cloudflare Worker 激活服务 + 自营 newapi 中转站 (alicloud-sh)

## 2. 目标用户

| 用户画像 | 核心诉求 | 我们的解决 |
|---|---|---|
| 个人高频创作者 | 一键发笔记、AI 写文案、操作可视化 | Electron 壳 + AI 侧边栏 |
| 隐私敏感者 | 数据不出本机、Cookie 不流转 | 完全本地化，仅 LLM 调用走自营中转 (跟厂商 BYOK 同性质) |
| **零配置型用户** | **买完即用，不想注册火山方舟/DeepSeek 账号** | **激活即聊, LLM 服务费按月续, 维护者后台运维** |

**注 1**：原 PRD v0.1 的"MCN 工作室"用户群因"仅支持 1 个小红书账号"决策而退出目标用户。

**注 2**：v0.6 起 BYOK 不再是默认对外卖点 (UI 隐藏)，dev 模式暗号解锁后仍可用作逃生口 (中转站宕机 / 客户特殊需求 / 内部调试)。

## 3. 竞品对比

| 维度 | xiaohongshu-mcp Docker | x-mcp 插件版 | **本方案** |
|---|---|---|---|
| 部署门槛 | 高（Docker/Go） | 低（装插件） | **极低（装应用）** |
| 云依赖 | 无 | 强依赖 aredink | **轻 (激活 + LLM 中转)** |
| 操作可见 | 无头不可见 | 在日常 Chrome 可见 | **专用窗口可见** |
| AI 内置 | 无 | 无 | **侧边栏 Chat (零配置, 自营 LLM 中转)** |
| 隔离性 | 进程级 | 与日常浏览混用 | **应用级独立** |
| 商业化 | 开源免费 | 免费 + 云端付费 token | **软件一次性买断 + 激活码绑机器 + LLM 月续费** |

## 4. 核心功能

### P0 必须有

1. **Electron 壳 + 专用浏览器窗口**
   - Chromium 内核，默认首页 `xiaohongshu.com`
   - UA 伪装为标准 Chrome（避开风控对"非主流浏览器"识别）
   - 基础 stealth：抹除 `navigator.webdriver` / 随机延迟 / UA 精确伪装

2. **嵌入式 xiaohongshu-mcp Go 服务**
   - 打包内置 `xiaohongshu-mcp` 二进制为子进程
   - 监听 `127.0.0.1:<random>`，不绑定 0.0.0.0，**不对外暴露**
   - Go 端改造：新增 `--cdp-endpoint` 参数，让 `go-rod` 通过 CDP attach 到 Electron BrowserWindow

3. **AI 侧边栏（v0.6 起：中转默认 + BYOK 逃生口）**
   - 右侧常驻可折叠面板
   - **默认中转模式**: 激活后 Worker `/activate` 下发 `llm: { base_url, api_key, model: "auto-llm" }`, 客户端写 `license.json`, agent 直接调用, 用户零配置 (详见 §6.7)
   - **BYOK 逃生口** (Dev 模式, UI 隐藏): 暗号 `doubleLyuzhouwudidashuaige` 在 Settings 反馈框 onChange 检测解锁, 解锁后显示 BYOK 配置区, 仍支持火山方舟 / DeepSeek / OpenAI 兼容自定义 (详见 §7)
   - License + LLM 配置用 file base64 编码存储（v0.2.7 起改文件存储, 不再用 macOS Keychain）
   - 流式响应（SSE，OpenAI 兼容 chat.completions）
   - 页面上下文感知：能读取当前激活 webContents 的 URL/标题/简化 DOM 作为 prompt 上下文
   - 客户端持有 conversation history（SQLite，存 `app.getPath('userData')`）

4. **MCP 工具完整可用（双模式调用）**
   - 14 个工具 (12 个走 Go MCP HTTP + 2 个 renderer 本地):
     - **登录/浏览**: check_login_status / list_feeds / search_feeds / get_feed_detail
     - **资料**: user_profile / my_profile
     - **互动 (敏感)**: post_comment_to_feed / reply_comment_in_feed / like_feed / favorite_feed
     - **发布 (敏感)**: publish_content / publish_with_video
     - **本地工具 (v0.2/v0.3 增量, 不走 Go)**: search_local_assets (按 tag 检索素材库) / web_search (搜狗联网搜索)
   - 模式 A：侧边栏 Chat 中 AI 自主多轮调用（autonomous agent）
   - 模式 B：运营面板里固定工作流（一键发布 = 编排好的固定步骤）
   - 客户端启动时通过 MCP `list_tools` 拉取 schema，转 OpenAI function calling 格式
   - **敏感操作默认确认**：发布、评论、点赞、收藏都弹确认对话框
   - 自动模式开关（设置里），开启后跳过确认（用户协议告知风险）

5. **频率护栏**（防风控）
   - 单账号发布 ≤ 3 篇/天，间隔 ≥ 30 分钟
   - 点赞 ≤ 30/小时
   - 评论 ≤ 10/小时
   - 软提示 + 用户选择（不硬阻挡）

6. **应用生命周期**
   - 应用打开 = MCP 子进程启动；关闭 = 子进程优雅停止
   - **定时发布**：客户端后台常驻（必须保持软件运行才能定时发布），不走服务端代发

7. **激活与防破解**
   - 极轻量在线激活（Cloudflare Workers 免费版）
   - 首次启动需输入激活码 → 绑定机器指纹（node-machine-id）
   - 返回 Ed25519 签名 token（365 天有效）
   - 后续启动本地验证 token + machine_id
   - 每 15 天后台心跳一次（吊销响应窗口）
   - **不限设备数，但 1 个激活码绑 1 台机器**；换机需联系客服换绑

8. **跨平台打包（无证书）**
   - macOS：dmg，**不做 Apple 公证 / 不买开发者证书**
   - Windows：NSIS，**不做代码签名**
   - 首次启动用户体验：macOS 需手动允许"未知开发者"，Windows 需点 SmartScreen "仍要运行"
   - 配套：《首次启动指引》文档（截图教程，macOS + Windows 各一份）

### P1 应该有

9. **应用内置运营面板**
   - 草稿库：本地保存图文 / 视频 / 标题 / 标签
   - 定时发布队列：到点自动调用 MCP（客户端跑）
   - 简易数据看板：当日发布数 / 点赞 / 评论汇总

10. **自动更新**
    - `electron-updater` + GitHub Releases
    - 强制更新策略：安全 / 反破解 / 反风控更新强制升级

11. **激活管理**
    - 应用内查看当前机器绑定状态
    - "复制机器码"按钮（换绑时联系客服用）

### P2 后续做

- 内容灵感库（保存高赞笔记 / 一键改写）
- 数据导出 / 备份
- 自定义 system prompt（高级用户）
- 多账号支持（如果商业模式验证后扩展，且解决风控关联）

### v0.2 ~ v0.3 增量功能（已上线）

> v0.5 PRD 加入这批 ship 完的功能。对应 git tag `v0.2.0` ~ `v0.3.0`。

12. **4-tab UI 重构**（v0.2.0）
    - tabbar：控制台 / 小红书 / 素材库 / 帮助
    - 控制台 25/75 分栏：左 (5 常用命令 + 会话列表) + 右 (聊天消息流 + 输入框)
    - 会话 CRUD：SQLite 存 / 新建 / 切换 / 重命名 / 删除 / 清空消息
    - 工具调用默认折叠 (错误自动展开)
    - thinking indicator：思考 / 调用中 / 文字流时各显示

13. **智能素材库**（v0.2.0 + v0.2.2 vision）
    - 上传 pipeline：nativeImage.toJPEG(75) 压缩 (不缩尺寸) + 重命名 `picture-YYYYMMDD-HHmmss-N.jpg`
    - LLM vision 打 tag：素材库顶部「🪄 补分析 N 张」按钮，逐张调 BYOK vision 模型生成 3-5 个中文 tag + 一句描述
    - MCP tool `search_local_assets(query)`：本地处理（不走 Go），按 tag / 描述 / 文件名模糊匹配，AI 拿到候选选 path 塞 `publish_content.images`
    - 📎 附件 picker modal：从素材库多选，发送时附件路径同时以文本注入 (publish_content.images 用) + base64 image_url 注入 (LLM vision 看图)
    - 自定义协议 `xhs-asset://{id}`：renderer 在 http://localhost 上加载本地图片，绕过 file:// 跨域限制

14. **联网搜索**（v0.3.0）
    - MCP tool `web_search(query, n)`：hidden BrowserWindow + 搜狗 HTML 抓取 (executeJavaScript 拿 `div.vrwrap`)
    - 零外部依赖（无 cheerio、无 API key、无配额）/ 国内直连 / 全 LLM 通用
    - 串行化 mutex 防并发开多窗 + 15s timeout + 失败结构化兜底
    - 真 Chrome UA 覆盖 Electron 默认 UA，绕反爬
    - 用户场景：AI 帮查热点 / 创作素材 / 不确定事实

15. **网页管理后台**（Worker /admin）
    - https://xhslicense.maxwellii.com/admin
    - 同源调 admin API 避 CORS，ADMIN_TOKEN 是唯一防线
    - 两个 tab：发码 (数量 + 过期 + 备注) / 列表 (filter + 吊销 + 换绑)
    - 行内按钮：吊销 (软删除 revoked + 原因) / 换绑 (新 machine_id)

16. **macOS 首启零命令**（v0.2.7）
    - dmg 内嵌 `首次安装.command` + Applications 拖拽快捷
    - 用户双击 .command 自动 `xattr -cr` 解 quarantine + 启动应用
    - 不再让用户跑命令行
    - 配合 ad-hoc codesign（无 Apple Developer ID）

17. **客户端零钥匙串弹窗**（v0.2.7）
    - license.ts 不再用 macOS Keychain (safeStorage)，改文件 base64 编码
    - 安全保障由服务端 verify machine_id 提供 (拷文件到别机器也激活不了)
    - 老 Keychain 用户启动会失效需重激活 (一次性 UX 损失)

### 工作流自动化（v0.7 / M7 计划，未实施）

把"用户每次手动让 AI 跑一遍"升级成"工作流定时自动跑"，是从"AI 助手"转向"AI 运营员"的关键一步。

#### 价值主张

| 当前痛点 | v0.7 解决 |
|---|---|
| 每天要手动开软件 + 让 AI 浏览点赞 | 设好"每天 9 点点赞 + 评论 3 条", 后台自动跑 |
| 发笔记必须人坐在电脑前 | 提前准备好图文/视频, 设"周六 19:00 发", 到点自动发 |
| 无法系统跟踪自己主页数据 | "每天 23:00 记录粉丝/笔记数/获赞", 增长趋势可查 |
| 手动操作不可避免不规律 | 工作流加 ±10min 调度抖动 + 步间 30-90s 随机延迟, 反风控比手动更稳 |

#### 5 个 MVP 模板

| 模板 | 触发场景 | 固定步骤 | AI 填补 |
|---|---|---|---|
| 👍 每日首页点赞评论 | 每天 X 点 | `list_feeds` → top N (≤5) `like_feed` → 部分笔记 `post_comment` | 生成评论文案 |
| ⏰ 定时发布笔记 | 单次 / 每周 X X 点 | `publish_content` 或 `publish_with_video` | 无 (用户预填) |
| ✍️ 签到式互动 | 每天 X 点 | 取关注列表前 N → 每人最新一篇 `like_feed` | 无 |
| 📊 每日数据快照 | 每天 X 点 | `my_profile` → SQLite snapshots 表 | 无 |
| 🔍 关键词点赞评论 | 每 X 小时 / 每天 X 点 | `search_feeds(keyword)` → top N `like_feed` + `post_comment` | 生成评论文案 |

#### 技术路线 (拍板)

| 决策 | 选项 |
|---|---|
| 多步执行 | **固定骨架 + AI 填补创意步骤** (流程代码硬, 评论文案交 LLM) |
| 调度复杂度 | **简化下拉** (每天/每周/每隔X小时) + ±10min 抖动. cron 表达式留 dev 模式 |
| 错过处理 | **skip + 记 missed_runs** (启动后不补跑, 历史里标 missed) |
| 失败阈值 | **连续 3 次 fail → auto disable** + 状态 pill 标红 |
| 并发 | **queue 串行**, 同时刻 2 个工作流到点也排队跑 (避免风控 + LLM 并发双倍 quota) |

#### 风控加固 (3 条)

1. **随机抖动**: 调度时间 ±10min, 步骤间 30-90s 随机延迟
2. **步骤硬上限**: 每次运行 like ≤ 5 / comment ≤ 3 (代码内截, 即使用户填 10 也截到 5)
3. **首次启用弹"风控注意"对话框**: 全局一次性勾选, 后续启用不再弹. 内容明确告知"自动行为可能触发风控, 后果自负"

#### UI 改造 (控制台左侧 25% 区, 3 段)

```
┌─⚡ 常用命令────────┐  3 个按钮 (检查登录 / 发布笔记 / 获取首页推荐),
│  [检查登录    ]    │  ≈ 140px 固定
│  [发布笔记    ]    │
│  [获取首页推荐]    │
├─🎛 工作流  [+新建]┤  工作流列表 + ▶ 手动跑 + ⋮ 菜单 (编辑/历史/启停/删除)
│ ▶ 每日点赞评论    │  ≈ 40% 剩余空间, 内部滚动
│   每天 09:00 ✅   │
│ ⋯                 │
├─💬 会话  [+新增]──┤  当前会话历史
│ ● 默认会话        │  ≈ 60% 剩余空间, 内部滚动
│ ⋯                 │
└───────────────────┘
```

弹框: WorkflowEditor (新建/编辑) + WorkflowRunHistory (运行历史) + RiskWarningDialog (首次启用)

#### MVP 路径

**P1 (5-7 天)**: 引擎 + 1 个模板 (👍 每日点赞评论) + 完整 UI 闭环 + 风控护栏
**P2 (5-7 天)**: 加剩 4 模板
**P3 (3 天)**: polish (dev 模式 cron / 运行历史详细 trace / 失败 notification)

#### 跟其他模块的关系

- **LLM**: AI 填补步骤用 license.llm.api_key (复用 D6 中转, **不绕过 D6 护栏 — quota check / overdue 软停 / 多租户 / cert 放行都生效**, 计入月度 quota)
- **RateLimiter**: 沿用 v0.2 全局护栏 (publish 3/天 / comment 10/h / like 30/h), **多工作流共享同一 quota 池** (3 个 like-类工作流同窗口跑也只能合计 30/小时; UI 在 WorkflowEditor 创建时**预估当日消耗**警示用户, 详见 SPEC §13.6.1)
- **SQLite**: 加 `workflows` + `workflow_runs` + `appConfig` 表, 复用现有 `app.db` better-sqlite3 singleton. v0.7 启动时跑 schema migration (SPEC §13.2.1), 老用户启动自动建表无感知
- **跨设备**: 工作流数据本地 SQLite, **不跨设备同步**, 跟激活码单设备绑定一致
- **客户端关闭**: 调度依赖客户端进程存活. 关闭期间 = miss. 用户开机就跑符合 "运营员上班" 直觉
- **笔记本 sleep 唤醒**: 注册 `powerMonitor.on('resume')`, 唤醒时全量 recompute next_fire_at (SPEC §13.3)

#### LLM Quota 商业模型 (跟 D6 月费的关系)

工作流 24×7 后台跑可能远超个人聊天 quota. 当前决策 (v0.7 启动时):

- **不另收费**: 工作流 LLM 消耗计入同一月度 quota (XHS Plan ¥X/月)
- **超额自动停**: 用户当月 quota 耗尽 → 工作流单次 run 标 `failed/quota_exhausted`, 整工作流不 auto-disable. 下月 quota reset 后自动恢复
- **若运营数据显示高度运营户耗光 quota 影响付费用户体验**, M8 公测前评估是否升级为"工作流单独配额桶"或"分级月费" (待 **D9 决策**, 见 §10)
- 文档明示这一点, 避免用户期望落差

### 商业化 · 中转站方案（v0.6 D6 已拍板）

✅ **方案 X · 一码一 newapi user + bind XHS Plan** (newapi 网关 + 月度自动 reset)

落地详见 §6.7 「LLM 中转站架构 (D6)」, 技术实现详见 [SPEC §12.10](./SPEC.md), 实施 checklist 详见 [ROADMAP §13 M6](./ROADMAP.md)。

核心:
- 自营 newapi 网关 (基于 [QuantumNous/new-api](https://github.com/QuantumNous/new-api), 已部署 alicloud-sh)
- 每激活码 = newapi 一个 user (username=`xhs-<激活码末两段小写>`, e.g. `xhs-wx2a-bcdf`, 13 字符) + bind XHS Plan (id=2, 月度 reset) + 一个 token (name=username, model_limits=`auto-llm`)
- **多租户隔离**: newapi 实例同时服务其他应用 (lijunfeng 等), Worker 仅管理 `xhs-` 前缀 user / XHS Plan / xhs group, 写操作前 `assertXhsTenant()` 护栏验证, 详见 SPEC §12.10.13
- 客户端零配置: base_url / api_key / model 由 Worker `/activate` 下发, 客户输完激活码即聊
- 未续费分级停用 (suspend 15 天软停 → revoke 硬停), 详见 §6.7
- BYOK 入口隐藏: Settings 反馈框输入暗号解锁 dev 模式 (具体暗号见 `~/.secrets/xhs-secrets.txt`)

## 5. 系统架构

```
┌────────────────────────────────────────────────────────────┐
│         Electron Main Process (用户本机)                    │
│                                                             │
│  ┌─────────────────────┐    ┌─────────────────────────┐   │
│  │  BrowserWindow      │    │  AI 侧边栏 (Renderer)    │   │
│  │  (小红书 web 页面)   │←─→│  • Chat UI               │   │
│  │  • remote-debug-port│    │  • BYOK 配置             │   │
│  │  • Stealth 注入     │    │  • 页面上下文抓取         │   │
│  └─────────────────────┘    └─────────────────────────┘   │
│           ↑                            ↓                    │
│           │ CDP attach            HTTPS 直连                │
│           │                            ↓                    │
│  ┌────────┴───────────────┐    ┌────────────────────┐     │
│  │ 内嵌 Go 子进程:         │    │ 大模型 Provider:    │     │
│  │ xiaohongshu-mcp        │    │ • 火山方舟          │     │
│  │ 127.0.0.1:<random>     │    │ • DeepSeek         │     │
│  │ 通过 --cdp-endpoint    │    │ • 自定义 OpenAI     │     │
│  │ 复用 Electron Chromium │    │   兼容端点          │     │
│  └────────────────────────┘    └────────────────────┘     │
│                                                             │
│  ┌──────────────────────┐    ┌────────────────────┐       │
│  │  License Manager     │    │  本地存储:          │       │
│  │  • 机器指纹           │    │  • SQLite (对话历史) │       │
│  │  • token 验证         │    │  • safeStorage     │       │
│  │  • 15 天心跳          │    │    (API key + token)│       │
│  └──────────┬───────────┘    └────────────────────┘       │
└─────────────┼──────────────────────────────────────────────┘
              ↓ HTTPS (激活/心跳, 仅必要时)
   ┌──────────────────────────────────────┐
   │ Cloudflare Worker (xxx.workers.dev)  │
   │ • /activate  (激活)                  │
   │ • /heartbeat (心跳)                  │
   │ • /admin/*   (你后台用)              │
   │ KV 存激活码状态                       │
   │ 成本: ¥0/月                          │
   └──────────────────────────────────────┘
```

### Go 端改造点

- `main.go` 增加 `--cdp-endpoint <ws-url>` 参数
- `browser/browser.go` 新增 `NewBrowserWithCDP(endpoint)` 用 `rod.New().ControlURL(endpoint).Connect()` 替代自启 Chrome
- 保留现有 HTTP/MCP server，仅绑定 localhost + 随机端口
- 弃用 `cmd/login` 独立登录入口（登录直接在 Electron 浏览器窗口完成）

### Electron 端职责

- 启 Chromium，开 `remote-debugging-port=<random>`，把 ws endpoint 通过 IPC 注入 Go 子进程
- AI 侧边栏 React + Vite 实现
- BYOK 配置 + LLM 直连（用 `openai-node` npm 包）
- Tool calling loop 在客户端实现
- License Manager
- Stealth 脚本注入（webdriver 抹除 + UA 伪装）

## 6. 商业化与许可证机制

### 6.1 销售模式

| 维度 | 决策 |
|---|---|
| 模式 | **软件一次性买断 + LLM 月续费 (松绑定 + 分级停用)** |
| 价格 | **挂牌 ¥399，实际成交价由客服 1V1 议价**（v0.4 D1 拍板）|
| LLM 服务费 | **按月续费, 维护者运营时定价**（v0.6 D6 拍板。auto-llm 智能调度, 月初 newapi 自动 reset quota; 未续费 → token suspend + chat 锁 + 15 天后 revoke。详见 §6.7）|
| 试用版 | **无**（仅提供 demo 视频 + 截图）（v0.4 D2 拍板）|
| 含更新 | 1 年内更新免费，1 年后买更新订阅（V2 决定）|
| 收款 | **MVP 个人名义收款**（微信/支付宝转账），首月销量 > 30 单后再升级个体工商户（v0.4 D4 拍板）|

### 6.2 激活码生成与发放

```
你后台:
  生成激活码: 调用 Cloudflare Worker /admin/codes
    POST { quantity: 1, notes: "买家: 张三 / 微信支付 ¥299 / 2026-05-15" }
    返回: { codes: ["XHS-XXXX-XXXX-XXXX-XXXX"] }
  
  把激活码 + 用户协议链接 + 火山方舟注册指引 发给买家

用户首次激活:
  打开软件 → 输入激活码 → 客户端读 machine_id → POST /activate
  Worker 校验: code unused? → 写入 bound_machine_id → 返回 token
  客户端: safeStorage 存 token → 进入主界面

后续启动 (大部分时间离线):
  读 token → 本地用 Ed25519 公钥验签 → 检查 machine_id 匹配 → 检查 valid_until
  全部通过 → 进入主界面
  
每 15 天:
  后台调 /heartbeat → 刷新 token / 检查吊销标志
```

### 6.3 防破解层级

| 层级 | 措施 | 防御效果 |
|---|---|---|
| 1. asar 加密 | electron-builder 加密 | 挡 80% 普通用户 |
| 2. safeStorage | API key + token 系统级加密 | 跨账号不可读 |
| 3. token 机器指纹绑定 | 跨机不可移植 | 复制安装失败 |
| 4. **远程吊销**（核心） | 破解码出现 → /admin/revoke → 15 天后失效 | 真正护城河 |

### 6.4 换机解绑流程

- 用户场景：电脑坏 / 升级新机 / 重装系统改变指纹
- 流程：用户微信联系你，提供激活码 + 付款凭证 + 新 machine_id
- 你执行：`curl /admin/rebind -d '{"code":"XXX","new_machine_id":"YYY"}'`
- 策略：**每年 3 次免费，超出 ¥99/次**（文案明示）

### 6.7 LLM 中转站架构（v0.6 D6 拍板）

#### 商业模式

- **软件一次性买断 + LLM 服务费月续**: 软件 ¥399 一次性 (永久 license), LLM 服务费按月续 (具体金额由 Maxwell 跟客户协商, 不写文档)
- **自动续费 vs 手动停用**:
  - 默认 = 自动续费 (newapi `XHS Plan` 原生 monthly reset, 月初自动恢复 quota)
  - 客户没付月费 → Maxwell **手动**调 Worker `/admin/suspend` → newapi token disable + license.status="suspended"
  - 客户续费 → Maxwell 调 `/admin/resume` → token enable + license.status 恢复 "active"
- **分级停用** (松绑定, 防误伤"软件买断"语义):
  - 短期 (≤ 15 天 suspended): 软件能开, chat 锁死 + banner 提示续费, 其他功能 (浏览/手动发布/查素材) 正常
  - 长期 (> 15 天 suspended 未恢复): Maxwell 手动 `/admin/revoke` → license 永久失效, 软件硬停
- **配额机制**: 客户绑 `XHS Plan` (newapi 原生 monthly reset), Maxwell 后台配 `total_amount` 调整 cap, 具体数值不写文档
- 选型: 自营 [QuantumNous/new-api](https://github.com/QuantumNous/new-api) 中转 (alicloud-sh 部署, Caddy 反代。**域名 `llm.maxwellii.com` 走 LE 合法证书** (Worker 跨境用); **IP `139.196.157.57` 走 Caddy 自签 sni-fallback** (客户端国内用, DPI 拦 SNI 必须 IP)。详见 [newapi-proxy/USAGE.md](../newapi-proxy/USAGE.md))

#### 用户体验

- **零配置激活**: 输入激活码 → 主进程 license push 通道下发 LLM 配置 (base_url + api_key + model) → 立即可聊
- **强制 auto-llm 智能调度**: 客户端 model 字段写死 `auto-llm` (newapi token model_limits 锁死), 火山方舟自动在豆包/Kimi/DeepSeek/GLM/MiniMax 间挑最优, 价格最低
- **配额可视**: Settings 显示"本月剩余 ¥X / ¥Y, 下月 1 日 00:00 自动重置", 启动 + 每次 chat 完成异步刷新
- **配额耗尽硬阻断**: chat 输入框 disable, Send 按钮置灰, 顶部 banner "本月额度已用完, 下月 1 日 00:00 自动重置, 联系客服微信 xxx 临时加额"
- **suspended (未续费) 软停**: chat 输入框 disable, Send 置灰, banner "AI 服务已暂停, 请联系客服续费 LLM 服务", dev 暗号入口仍可用

#### Dev 模式逃生口（隐藏）

- **触发**: Settings 反馈框 (常驻 UI, 主用途给客服反馈问题), 输入暗号 `doubleLyuzhouwudidashuaige`, onChange 实时检测 → 弹 dialog "已解锁开发者模式"
- **能力**: 解锁后 Settings 出现 BYOK 配置区 (baseURL / API Key / model), 可在中转 / BYOK 间切换
- **持久化**: `license.json` 加 `dev_mode: true` 标志, 重启保留
- **存储**: `license.json` 加 `byok: { base_url, api_key, model }` 字段, 跟 `llm` 字段并列
- **agent 选择**: `license.dev_mode === true ? license.byok : license.llm`
- **使用场景**: 中转站宕机应急 / 客户要 Claude/GPT-4 等中转不支持的模型 / 内部 debug

#### 失败兜底

| 场景 | 处理 |
|---|---|
| Worker → newapi 网络/超时 | 重试 3 次, 仍失败 → `/activate` 返回 `llm: null`, 客户端 dialog "中转暂不可用, 暗号切 BYOK" |
| newapi 自身宕机 | 同上 |
| 客户端 SSL handshake 失败 | dialog "网络异常, 请检查 IP 或暗号切 BYOK" |
| 配额耗尽 | dialog + 输入框 disable, 仅 dev mode 入口可用 |

#### 跟其他模块的关系

- **激活码生命周期**: 发码同步建 newapi user + sub + token (强一致回滚), 吊销同步 disable newapi token, 换绑不动 newapi (LLM key 跟 machine 解耦)
- **base_url 动态下发**: Worker `/activate` + `/heartbeat` 都返回最新 `llm.base_url`, 客户端检测变化 → push renderer 更新 → Maxwell 改 IP 后客户端最迟 heartbeat 周期 (1h) 内自动 catch
- **客户端 SSL**: 主进程 `app.on('certificate-error')` 仅对 `139.196.157.57` 放行 (Caddy 自签证书), 其他 HTTPS 仍严格验证

### 6.5 License Server（Cloudflare Workers）

接口设计：

```
用户端:
  POST /activate    { code, machine_id }    → { token, valid_until, status, llm }
  POST /heartbeat   { token }                → { ok, status, llm, latest_version, revoked? }
  GET  /quota?code&sig                       → { remain_cny, total_cny, used_cny, next_reset_at }    (v0.6 D6)

管理端 (Bearer ADMIN_TOKEN):
  POST /admin/codes  { quantity, notes }      → { codes: [...] }
  POST /admin/revoke { code, reason }         → { ok }
  POST /admin/rebind { code, new_machine_id } → { ok }
  POST /admin/suspend{ code, reason }         → { ok }    (v0.6 D6: 软停, token disable + status=suspended)
  POST /admin/resume { code }                 → { ok }    (v0.6 D6: 恢复, token enable + status=active)
```

**heartbeat 周期**: 客户端 24h 一次主动调 /heartbeat (代码常量 HEARTBEAT_INTERVAL_MS)。**suspend 后客户端实际感知**靠两条路径取早:
- 主路径 (即时): 用户调 LLM 时 newapi token 已 disable → 401/403 → agent.ts catch → 立即 refreshLicense + 锁 chat
- 兜底路径 (最多 24h): 下次 heartbeat 同步 status → 锁 chat

离线 + 不调 LLM 时 license 不更新, 但此场景下用户也无法用 AI 功能, 业务无损。

KV 数据结构：

```
key: code:XHS-XXXX-XXXX-XXXX-XXXX
value: {
  status: 'unused' | 'active' | 'suspended' | 'revoked',  // v0.6 D6 加 suspended
  bound_machine_id: string | null,
  bound_at: ISO timestamp,
  expire_at: ISO timestamp,
  rebind_count: number,
  notes: string,
  // v0.6 D6 加 (完整 schema 详见 SPEC §6.4)
  newapi_user_id: number | null,
  newapi_sub_id: number | null,
  newapi_token_id: number | null,
  api_key_encrypted: string | null,
  suspended_at: ISO timestamp | null,
  suspend_reason: string | null,         // 仅运营内部, 客户端不展示
  resumed_at: ISO timestamp | null,
  revoked_at: ISO timestamp | null
}
```

成本：Cloudflare Workers 免费版（10w 请求/天 + 100k KV 读/天）足够你年用户量级。

## 7. LLM 接入（v0.6 起：中转默认 + BYOK 逃生口）

### 7.1 配置 UI

- **默认状态 (中转模式)**: 用户**无需任何 LLM 配置**, 激活后 Worker /activate 下发完整 LLM 配置 (base_url + api_key + model), 自动写 `license.llm`
- **Dev 模式 (BYOK 逃生口)**: 暗号 `doubleLyuzhouwudidashuaige` 解锁后, Settings 出现 BYOK 配置区, 允许填 baseURL / API Key / model 并切换

### 7.2 Provider 支持

**中转模式 (默认)**:

| 端点 | URL | 模型 |
|---|---|---|
| OpenAI 兼容 | `https://139.196.157.57/v1` (Worker 下发) | 强制 `auto-llm` (火山方舟智能调度, 自动选豆包/Kimi/GLM/MiniMax/DeepSeek 最优) |

**BYOK 模式 (Dev 模式可见)**:

| Provider | baseURL | 注册指引 |
|---|---|---|
| 火山方舟（默认推荐） | `https://ark.cn-beijing.volces.com/api/v3` | 引导用户访问 volcengine.com/product/ark 注册 |
| DeepSeek 官方 | `https://api.deepseek.com/v1` | 引导用户访问 platform.deepseek.com 注册 |
| OpenAI 兼容自定义 | 用户填 | 覆盖 Kimi / 智谱 / 通义 等任意厂商 |

### 7.3 Tool Calling Loop

标准 OpenAI function calling，客户端实现：

```
1. 启动时通过 MCP list_tools 拉取 14 个工具的 schema (12 个走 Go + 2 个 renderer 本地)
2. 转换为 OpenAI function 格式
3. 用户对话 → 发请求到 LLM（带 tools）
4. LLM 返回 tool_calls → 客户端识别
5. 敏感操作弹确认对话框（发布/评论/点赞/收藏）
6. 用户确认后执行 MCP 工具
7. 工具结果回传 LLM
8. Loop 直到 finish_reason: stop
```

### 7.4 上下文管理

- 单次对话最大上下文：32K tokens（豆包 Pro / DeepSeek 等的常见限制）
- 超限：自动 trim 最早消息
- 持久化：SQLite 存 `app.getPath('userData')`
- 用户可查看 / 删除历史

## 8. 关键风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Electron Chromium 版本被小红书识别 | 高 | UA 伪装 + 测试主流版本 + 必要时锁版 |
| 用户的 LLM API 调用失败 | 中 | 错误提示清晰 + 引导去 Provider 后台检查 |
| 激活码被批量泄露 | 中 | 远程吊销 + 用户协议明示禁止转售 |
| Cloudflare Workers 国内访问偶尔慢 | 低 | 15 天心跳 + 365 天 token 有效，离线宽限充足 |
| 无证书 APP 首次启动用户教育成本 | 中 | 提供《首次启动指引》截图文档；预计首次安装转化率下降 ~20-30% |
| 法律：模拟用户操作可能违反小红书 ToS | 中 | 用户协议明确告知 + 风险用户自担 + 不做规避风控的高危功能 |
| Bundle 体积 ~300MB | 低 | 行业常见 |

## 9. 里程碑（一人 + AI 协同节奏）

| 阶段 | 周期 | 产出 |
|---|---|---|
| **M1 PoC** | 1-2 周 | Electron 单窗口 + Go 子进程 + CDP 联调成功 + `publish_content` 单工具跑通 (✅ 已完成) |
| **M2 内核完成** | 2-3 周 | 11 个 MCP 工具全跑通 + 侧边栏 Chat (BYOK 火山方舟起步, v0.2/v0.3 后扩为 12 Go + 2 local = 14) (✅ 已完成) |
| **M3 商业化** | 2 周 | Cloudflare Worker 激活服务 + 客户端激活流程 + 加固 (✅ 已完成) |
| **M4 跨平台 + 自动更新** | 1 周 | macOS / Windows 无证书打包 + electron-updater + 首次启动指引文档 (✅ 已完成) |
| **M5 公测打磨** | 1-2 周 | UI 重构 / 智能素材库 / 联网搜索 / 12 次发版迭代 (✅ 已完成) |
| **M6 LLM Gateway 实施** | 2 天 | **D6 自营 newapi 中转 (方案 X 一码一 user + bind XHS Plan)。详见 ROADMAP §13** (✅ 已完成 2026-05-20, v0.6.0 ship) |
| **M7 工作流自动化** | 2-3 周 | 工作流引擎 + 5 模板 + 风控加固 (P1 引擎+1 模板 → P2 加 4 模板 → P3 polish)。详见 §4 末尾工作流自动化 + SPEC §13 (🔧 待启动) |
| **M8 公测发售** | 待 D3/D5 决策 | 种子用户灰度 + 首发 (⏳ pending) |

总计: M1-M6 完成 (D6 ship), M7 工作流后再做 M8 公测发售。

## 10. 待决策清单（剩余）

### 已拍板

| 编号 | 议题 | 决策 |
|---|---|---|
| ✅ D1 | 售价 | 挂牌 ¥399 + 客服议价（v0.4 / 2026-05-16） |
| ✅ D2 | 试用版 | 无（仅 demo 视频/截图）（v0.4 / 2026-05-16） |
| ✅ D4 | 法律主体 | 个人名义（首月销量验证后升级个体户）（v0.4 / 2026-05-16） |
| ✅ **D6** | **LLM 中转站方案** | **方案 X · 一码一 newapi user + bind XHS Plan, 软件买断 + LLM 月续费 + 未续 15 天软停 → revoke 硬停（v0.6 / 2026-05-19）。详见 §6.7** |

### 待决策

| 编号 | 议题 | 影响 | 截止 |
|---|---|---|---|
| D3 | 产品全名（中英文）+ 域名 | 影响品牌；可选官网 | M8 公测前 |
| D5 | 支持渠道（微信群 / 邮件 / GitHub Issues） | 影响客服压力 | M8 公测前 |
| D7 | mac Intel build 是否保留 | 私仓 GH Actions macOS quota 倍率 10x，Intel runner 卡 queue | M8 公测前 |
| D8 | 仓库公私 | private 现状 vs public 解决 macOS quota + 利于品牌曝光，无重大泄密 | M8 公测前 |
| **D9** | **工作流 LLM quota 商业模型** | 高度运营户后台 24×7 跑可能超 ¥X/月 quota. 选项: (a) 维持现状, 单 run quota_exhausted 失败下月 reset 恢复; (b) 工作流独立 quota 桶; (c) 工作流模式分级月费. 影响商业可持续性 + 用户期望 | M7 P1 ship + 收 2 周运营数据后定, M8 公测前必拍 |

## 11. 附录：现有代码资产清单

### xiaohongshu-mcp（Go，复用 + 改造）

| 文件/目录 | 用途 | 改造点 |
|---|---|---|
| `main.go` / `app_server.go` | HTTP/MCP 服务入口 | 加 `--cdp-endpoint` 参数 |
| `browser/browser.go` | go-rod 封装 | **新增 CDP attach 模式** |
| `cookies/cookies.go` | cookies 持久化 | 路径改为 Electron userData 下 |
| `xiaohongshu/*.go` | 14 个领域逻辑文件 | 不变 |
| `mcp_server.go` / `mcp_handlers.go` | MCP 协议适配 | 不变 |
| `cmd/login/main.go` | 独立登录入口 | **弃用**（登录在 Electron 窗口完成） |

### x-mcp（参考，不复用代码）

- `SKILL.md` 中的 11 工具描述 → 可作为 AI 系统提示词参考
- 整体作为产品形态对照

### 新建项目

1. **Electron 主项目**（TypeScript + React + Vite）
   - 主进程：BrowserWindow + Go 子进程管理 + License Manager
   - 渲染进程：AI 侧边栏 + 设置页 + 激活页 + 运营面板（P1）
   
2. **License Worker**（TypeScript + Cloudflare Workers）
   - ~150 行代码
   - 部署到 `xxx.workers.dev`

---

**文档结束 · v0.6**
