# 小红书自运营系统 PRD

> 版本 v0.5 · 2026-05-17 · 路线 A（完全本地化 + BYOK + 无证书发布）

## 0. 版本变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-05-15 | 初稿（路线 B：服务端反代 LLM + 卖 token） |
| v0.2 | 2026-05-15 | 重大调整：切换到路线 A（完全本地化 + BYOK）。卖 token 业务剥离为独立项目 |
| v0.3 | 2026-05-16 | 决策无证书发布：砍掉 Apple 公证 + Win 代码签名，接受首次启动用户教育成本 |
| v0.4 | 2026-05-16 | M3 决策拍板：D1 挂牌 ¥399 客服议价、D2 不提供试用、D4 个人收款。M3 服务端 5 接口 + admin CLI 实现完成（E2E 测试 11/11 通过） |
| v0.5 | 2026-05-17 | v0.2 ~ v0.3 系列功能 ship：4-tab UI 重构 / 智能素材库 (压缩 + LLM vision 打 tag) / 📎 附件 + xhs-asset:// 协议 / 联网搜索 (搜狗 hidden BrowserWindow) / 网页管理后台 (Worker /admin) / dmg 内嵌「首次安装.command」+ 0 Keychain. 中转站方案 (E)：待用户决策 |
| **v0.5.1** | 2026-05-17 | **黑盒 E2E 测试 (subagent 跑 164/167 pass) 发现 5 个 bug, 修完: B-001 license 状态变化 push 通道 (代码改); B-002 工具计数 11/13 → 14 (PRD §4.4 + SPEC §12.9); B-003 删 xhs_generate_cover 占位 (PRD §4.4); B-004 SPEC §2.2 加 v0.2 重构通知; B-005 §9.1 错误码前缀约定明确 (Worker 不带 LICENSE_)** |

## 1. 产品定位

一句话：**一个内置 AI 助手的小红书桌面浏览器，登录即用、完全本地化、BYOK 驱动 11 个原生 MCP 工具完成创作 / 发布 / 运营全流程。**

- 形态：基于 Electron + Chromium 内核的专用浏览器
- 内嵌：`xiaohongshu-mcp` Go 服务（不对外暴露）
- AI：侧边栏 Chat，用户自带大模型 API Key（BYOK），客户端直连大模型
- 商业模式：一次性买断 + 激活码授权
- 零服务端（仅 Cloudflare Workers 上的轻量激活服务，免费）

## 2. 目标用户

| 用户画像 | 核心诉求 | 我们的解决 |
|---|---|---|
| 个人高频创作者 | 一键发笔记、AI 写文案、操作可视化 | Electron 壳 + AI 侧边栏 |
| 隐私敏感者 | 数据不出本机、Cookie 不流转 | 完全本地化，零云端 |
| 技术友好型用户 | BYOK 自管、不愿被云中转 | 直连自己的大模型账号 |

**注**：原 PRD v0.1 的"MCN 工作室"用户群因"仅支持 1 个小红书账号"决策而退出目标用户。

## 3. 竞品对比

| 维度 | xiaohongshu-mcp Docker | x-mcp 插件版 | **本方案** |
|---|---|---|---|
| 部署门槛 | 高（Docker/Go） | 低（装插件） | **极低（装应用）** |
| 云依赖 | 无 | 强依赖 aredink | **无（除激活服务）** |
| 操作可见 | 无头不可见 | 在日常 Chrome 可见 | **专用窗口可见** |
| AI 内置 | 无 | 无 | **侧边栏 Chat（BYOK）** |
| 隔离性 | 进程级 | 与日常浏览混用 | **应用级独立** |
| 商业化 | 开源免费 | 免费 + 云端付费 token | **付费 + 激活码绑机器** |

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

3. **AI 侧边栏（BYOK 直连）**
   - 右侧常驻可折叠面板
   - 支持 3 类 Provider：
     - 火山方舟（`https://ark.cn-beijing.volces.com/api/v3`）
     - DeepSeek 官方（`https://api.deepseek.com/v1`）
     - OpenAI 兼容自定义（baseURL + key 用户填）
   - API Key 用 Electron `safeStorage` 加密存储（macOS Keychain / Windows DPAPI）
   - 不预设默认模型，引导用户从 Provider 选择
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

### 商业化 · 中转站方案（待决策 D6）

> v0.5 新议题。用户提出: 想发"API key"给客户开箱即用,但客户端不能存上游 LLP key (会被破解)。

3 条候选路线 (详见 ROADMAP M5+ 排期讨论):

- B · Worker LLM Gateway: client 用激活码 Bearer 调 Worker, Worker 转发上游 LLM (key 在 Worker secret)
- D · 混合: 默认 Worker, 高级用户切 BYOK (落地最优)
- 用户 BYOK 兜底: 现状, 用户输自己的 baseURL/key

待用户最终选 + 排期。涉及成本测算 (每激活码月度 token 配额) + 上游选型 (doubao / DeepSeek / OpenAI)。

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
| 模式 | **一次性买断** |
| 价格 | **挂牌 ¥399，实际成交价由客服 1V1 议价**（v0.4 D1 拍板） |
| 试用版 | **无**（仅提供 demo 视频 + 截图）（v0.4 D2 拍板） |
| 含更新 | 1 年内更新免费，1 年后买更新订阅（V2 决定） |
| 收款 | **MVP 个人名义收款**（微信/支付宝转账），首月销量 > 30 单后再升级个体工商户（v0.4 D4 拍板） |
| LLM 费用 | **用户自付**（用户自己开通火山方舟/DeepSeek 账号） |

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

### 6.5 License Server（Cloudflare Workers）

接口设计：

```
用户端:
  POST /activate    { code, machine_id }    → { token, valid_until }
  POST /heartbeat   { token }                → { ok, latest_version, revoked? }

管理端 (Bearer ADMIN_TOKEN):
  POST /admin/codes  { quantity, notes }      → { codes: [...] }
  POST /admin/revoke { code, reason }         → { ok }
  POST /admin/rebind { code, new_machine_id } → { ok }
```

KV 数据结构：

```
key: code:XHS-XXXX-XXXX-XXXX-XXXX
value: {
  status: 'unused' | 'active' | 'revoked',
  bound_machine_id: string | null,
  bound_at: ISO timestamp,
  expire_at: ISO timestamp,
  rebind_count: number,
  notes: string
}
```

成本：Cloudflare Workers 免费版（10w 请求/天 + 100k KV 读/天）足够你年用户量级。

## 7. BYOK 大模型接入

### 7.1 配置 UI

- **首次启动引导**：激活码输入 → AI 配置（选 Provider + 填 API Key + 选模型）→ 完成
- **设置页**：随时可改

### 7.2 Provider 支持

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
| **M1 PoC** | 1-2 周 | Electron 单窗口 + Go 子进程 + CDP 联调成功 + `publish_content` 单工具跑通 |
| **M2 内核完成** | 2-3 周 | 11 个 MCP 工具全跑通 + 侧边栏 Chat（BYOK 火山方舟一个 Provider 起步） |
| **M3 商业化** | 2 周 | Cloudflare Worker 激活服务 + 客户端激活流程 + 加固 |
| **M4 跨平台 + 自动更新** | 1 周 | macOS / Windows 无证书打包 + electron-updater + 首次启动指引文档 |
| **M5 公测打磨** | 1-2 周 | 小范围灰度 + bug fix + 文档 |

总计 ~10 周到首版可售卖（v0.3 无证书后再省 1 周）。

## 10. 待决策清单（剩余）

### 已拍板（v0.4 / 2026-05-16）

| 编号 | 议题 | 决策 |
|---|---|---|
| ✅ D1 | 售价 | 挂牌 ¥399 + 客服议价 |
| ✅ D2 | 试用版 | 无（仅 demo 视频/截图） |
| ✅ D4 | 法律主体 | 个人名义（首月销量验证后升级个体户） |

### 待决策

| 编号 | 议题 | 影响 | 截止 |
|---|---|---|---|
| D3 | 产品全名（中英文）+ 域名 | 影响品牌；可选官网 | W10（M5 公测前） |
| D5 | 支持渠道（微信群 / 邮件 / GitHub Issues） | 影响客服压力 | W10（M5 公测前） |
| D6 | 中转站方案（默认走 Worker 转发 LLM）落地与否 | 决定客户体验 (开箱即用 vs BYOK) + 服务端成本 | 公测前 |
| D7 | mac Intel build 是否保留 | 私仓 GH Actions macOS quota 倍率 10x，Intel runner 卡 queue | 公测前 |
| D8 | 仓库公私 | private 现状 vs public 解决 macOS quota + 利于品牌曝光，无重大泄密 | 公测前 |

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

**文档结束 · v0.2**
