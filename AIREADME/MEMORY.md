# MEMORY — 小红书自运营系统
<!-- 踩坑/失败/事故，append-only。别重复踩坑。决策→DECISIONS。 -->

## chromium occlusion 节流让隐藏窗口的 Go CDP 死掉
- 现象: 窗口最小化 / 移屏外后 Go CDP evaluate 报 `-32000` / `Execution context was destroyed`，5min 超时。
- 根因: Chromium 默认节流后台 / occluded 窗口的 execution context。
- 结论: 4 个 command-line switch 缺一不可 (见 ARCHITECTURE 禁改) + webPreferences `backgroundThrottling:false`。

## window.hide() vs minimize()
- 现象: `hide()` 后 go-rod 看不到那个 page，业务 fallback 到 localhost UI 被 navigate 覆盖。
- 根因: hide() 让 page 从 active targets 移除；minimize() 不会。
- 结论: 小红书窗口 close 拦截 → minimize()，仅 isQuitting 才真销毁。

## webview display:none 丢 cookies
- 现象: tab 切换用 display:none 后小红书登录态丢。
- 根因: `<webview>` guest 是独立 process，display:none 销毁 guest + partition cookies。
- 结论: tab 切换用 `left:-99999px + visibility:hidden` 保 guest alive。

## macOS Tahoe + Retina viewport lock (1280×800)
- 现象: 14" Mac "Looks Like 1800x1169" (1.68x 非整数 retina) 让 Chromium inner viewport 锁死 1280×800，BrowserWindow 调不大。
- 根因: chromium fractional scaling 锁，真因未完全明 (调试一晚 enumerate 所有 webPreferences/options/启动顺序，都不影响)。
- 结论: 主控锁 1280×800 + `resizable:false` 接受；小红书页用 **helper-popup 路径** (helper 加载 xhs.com same-origin → inject `<a target=_blank>` 到 documentElement → `sendInputEvent` 真 click → `setWindowOpenHandler` 返 allow **不带 override**) 开独立可 resize 窗口。**别再尝试主控 popup 解锁** (同路径加载 localhost/file:// 仍锁)。

## ad-hoc codesign 解决不了 quarantine + Tahoe install.command 悖论
- 现象: 无证书 app 报"已损坏"；dmg 内嵌 .command 想帮解 quarantine，但脚本自己被 Gatekeeper 拦。
- 根因: codesign 只解 app 内 hash 不解 quarantine；macOS Tahoe 对带 quarantine 的脚本也要 notarization；shell 脚本非 mach-o 无法签。
- 结论: 放弃内嵌可执行脚本，改纯文本教程教用户终端 `xattr -cr <app>`；Tahoe 唯一 GUI bypass = 系统设置→隐私安全→「仍要打开」(右键打开法已被堵)。

## *.maxwellii.com 跨网络 DPI 拦 SNI (CF 出口也拦)
- 现象: 客户端 + Cloudflare Workers 跨境调 `https://llm.maxwellii.com` 都 525 SSL handshake 失败。
- 根因: 国内 DPI 在 alicloud 入口侧拦 SNI，不只出口侧。
- 结论: 客户端走 IP 直连 + 关 verify；境外服务 (Worker) 必须走 CF Tunnel 合法证书域名 (CF Workers fetch 不能 skip SSL verify，无 `-k` 等价)。新域名 `doublel.top` 大概率不被拦 (待实测)。

## newapi 删 user 不级联 + 软删 user API 清不掉
- 现象: 删 user 后 subscription/token row 残留 (孤儿)，user_id 复用后新 user 继承孤儿；软删 (DeletedAt) 的 user API 无法再硬删 (`DELETE`→record not found，`manage`→空 no-op)。
- 根因: newapi HardDeleteUserById 只删 user row 不级联；admin 无 API path 删别人 token (UserAuth 严格)。
- 结论: 别用 newapi UI 删 user (软删残留 + id 复用)；清 token 走 impersonation (admin 改密 → user 登录 → DELETE token)；XHS Plan 无 API 硬删 (只能 disable / DB 直连)。B' 下 token 全归 `xhs-pool`，impersonate pool 可干净删。

## go-rod page.Context(ctx) 擦掉 .Timeout()
- 现象: search_feeds 单次请求卡 14h+，用户体感"接口异常"。
- 根因: `s.page.Context(ctx)` 重置了上面 `.Timeout(60s)`，SPA 加载失败时永久卡，直到上游 ctx 取消。
- 结论: `.Context(ctx)` 后必须再 `.Timeout(N)`；配 `defer recover()` + logrus page URL log 把 panic 转可读 error。

## npm install 频繁破坏 node_modules
- 现象: 每次 install/uninstall 某 transitive dep missing (tsc / electron-vite / esbuild / rollup native 等)。
- 结论: 不反复 install；nuke `rm -rf node_modules package-lock.json && npm install` 一次装全 (淘宝镜像 ~8s)。

## GH Actions 私仓 macOS quota 10x + workflow_dispatch release 条件
- 现象: 私仓 macOS runner 烧 quota 快 (×10)，Intel 卡 queue；`workflow_dispatch --ref main` 时 `github.ref=refs/heads/main` 不满足 tag release `if` → 只 build 不发版。
- 结论: 仅 `workflow_dispatch` 手动触发 + 加 `release_tag` input (`if: inputs.release_tag != ''`)；mac 暂只 arm64。

## v0.3.1 老用户永远收不到升级提醒
- 现象: v0.3.1 用 electron-updater + 私仓 atom feed (404)，新 `/version` 机制 v0.3.2 才有。
- 结论: 发新版必须客服 1V1 私发给已知 v0.3.1 用户，不能假设自动收到。
