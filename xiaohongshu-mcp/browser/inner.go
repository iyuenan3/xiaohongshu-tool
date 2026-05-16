// Package browser provides a unified browser wrapper supporting two modes:
//   - Launcher mode: 自启 Chrome (向后兼容 Docker 部署)
//   - Attach mode:   通过 CDP WebSocket attach 到已有 Chromium (用于 Electron 内嵌)
//
// 本文件实现底层 Browser 结构,替代原 headless_browser.Browser 以支持 attach。
package browser

import (
	"encoding/json"
	"strings"
	"sync"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
	"github.com/go-rod/rod/lib/proto"
	"github.com/go-rod/stealth"
	"github.com/sirupsen/logrus"
)

// Browser 浏览器实例,可能由 launcher 启动 或 attach 到外部 Chromium。
type Browser struct {
	rodBrowser *rod.Browser
	launcher   *launcher.Launcher // attach 模式下为 nil
	attached   bool               // 是否 attach 模式
}

// innerConfig 本地包装的浏览器配置
type innerConfig struct {
	headless      bool
	chromeBinPath string
	cookies       string
	proxy         string
	userAgent     string
	cdpEndpoint   string // 非空时走 attach 模式
}

// defaultUA 与原 headless_browser 保持一致,避免风控差异
const defaultUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// newInner 创建底层 Browser。
// attach 模式: cdpEndpoint 非空,跳过 launcher 直接 ControlURL.Connect。
// launcher 模式: 启动 Chrome 子进程。
func newInner(cfg *innerConfig) (*Browser, error) {
	if cfg.cdpEndpoint != "" {
		return newAttached(cfg)
	}
	return newLaunched(cfg)
}

func newAttached(cfg *innerConfig) (*Browser, error) {
	logrus.Infof("attach mode: connecting to CDP %s", cfg.cdpEndpoint)

	rb := rod.New().ControlURL(cfg.cdpEndpoint)
	if err := rb.Connect(); err != nil {
		return nil, err
	}

	// attach 模式下不主动设置 cookies (Electron 已自行管理)
	// 也不接管 UA (Electron 设置)

	return &Browser{
		rodBrowser: rb,
		launcher:   nil,
		attached:   true,
	}, nil
}

func newLaunched(cfg *innerConfig) (*Browser, error) {
	ua := cfg.userAgent
	if ua == "" {
		ua = defaultUA
	}

	l := launcher.New().
		Headless(cfg.headless).
		Set("--no-sandbox").
		Set("user-agent", ua)

	if cfg.chromeBinPath != "" {
		l = l.Bin(cfg.chromeBinPath)
	}
	if cfg.proxy != "" {
		l = l.Proxy(cfg.proxy)
	}

	url, err := l.Launch()
	if err != nil {
		return nil, err
	}

	rb := rod.New().ControlURL(url)
	if err := rb.Connect(); err != nil {
		l.Cleanup()
		return nil, err
	}

	// 加载 cookies (仅 launcher 模式)
	if cfg.cookies != "" {
		var cks []*proto.NetworkCookie
		if err := json.Unmarshal([]byte(cfg.cookies), &cks); err != nil {
			logrus.Warnf("failed to unmarshal cookies: %v", err)
		} else if err := rb.SetCookies(proto.CookiesToParams(cks)); err != nil {
			logrus.Warnf("failed to set cookies: %v", err)
		}
	}

	return &Browser{
		rodBrowser: rb,
		launcher:   l,
		attached:   false,
	}, nil
}

// NewPage 创建或选择一个用于业务操作的页面。
//
// launcher 模式: 使用 stealth 创建新 page (原行为)。
// attach 模式:   Electron 的 Chromium 不支持 CDP Target.createTarget,
//
//	必须复用已有 page。选择策略 (优先级降序):
//	  1. URL 含 xiaohongshu.com 的 page (业务已经在用)
//	  2. 非 localhost/127.0.0.1 的 http(s) page (即 Electron 开的浏览器窗口)
//	  3. 第一个 page (兜底, 调用方会 navigate)
//	找不到任何 page 时返回 nil, 调用方必须检查。
func (b *Browser) NewPage() *rod.Page {
	if b.attached {
		return b.selectAttachedPage()
	}
	return stealth.MustPage(b.rodBrowser)
}

func (b *Browser) selectAttachedPage() *rod.Page {
	// 1. 先用 rod.Pages() 找 (仅 type=page)
	pages, err := b.rodBrowser.Pages()
	if err == nil {
		for _, p := range pages {
			if info, err := p.Info(); err == nil && strings.Contains(info.URL, "xiaohongshu.com") {
				logrus.Debugf("attach: selected xhs page (type=page): %s", info.URL)
				return p
			}
		}
	}

	// 2. fallback: 用底层 Target.getTargets 查所有 target (含 webview / iframe)
	// Electron <webview> guest page 的 type 是 "webview", 默认 Pages() 不返回
	targetsResp, terr := proto.TargetGetTargets{}.Call(b.rodBrowser)
	if terr == nil {
		for _, t := range targetsResp.TargetInfos {
			if !strings.Contains(t.URL, "xiaohongshu.com") {
				continue
			}
			// 用 PageFromTarget 把 TargetInfo 转 rod.Page
			page, perr := b.rodBrowser.PageFromTarget(t.TargetID)
			if perr == nil && page != nil {
				logrus.Infof("attach: selected xhs target (type=%s): %s", t.Type, t.URL)
				return page
			}
			logrus.Warnf("attach: PageFromTarget failed for %s: %v", t.URL, perr)
		}
	}

	// 3. 还没找到, 列已知 page + target URLs 帮助 debug
	urls := make([]string, 0)
	for _, p := range pages {
		if info, err := p.Info(); err == nil {
			urls = append(urls, "page:"+info.URL)
		}
	}
	if targetsResp != nil {
		for _, t := range targetsResp.TargetInfos {
			urls = append(urls, string(t.Type)+":"+t.URL)
		}
	}
	logrus.Warnf("attach: no xhs page/target found, available=%v", urls)
	panic("XHS_WINDOW_NOT_OPEN: 没有找到小红书浏览器窗口, 请在 UI 中点击「打开/聚焦 小红书窗口」")
}

// Pages 返回所有当前打开的 page (用于 attach 模式下定位 Electron 主窗口)。
func (b *Browser) Pages() (rod.Pages, error) {
	return b.rodBrowser.Pages()
}

// RodBrowser 暴露底层 rod.Browser, 供需要直接操作的代码使用 (谨慎调用)。
func (b *Browser) RodBrowser() *rod.Browser {
	return b.rodBrowser
}

// Attached 返回是否 attach 模式。
func (b *Browser) Attached() bool {
	return b.attached
}

// Close 清理浏览器资源。
//   - launcher 模式: 关闭 rod.Browser + cleanup launcher (杀 Chrome 子进程)
//   - attach 模式: 仅 Disconnect, 不关 Electron 的 Chromium
func (b *Browser) Close() {
	if b.attached {
		// 不能 MustClose, 会把 Electron 的 Chromium 也关掉
		// 只需要释放本地 rod 资源
		// rod 没有显式 Disconnect, 但 GC 会处理
		logrus.Debug("attach mode: skipping browser close")
		return
	}

	if b.rodBrowser != nil {
		if err := b.rodBrowser.Close(); err != nil {
			logrus.Warnf("failed to close browser: %v", err)
		}
	}
	if b.launcher != nil {
		b.launcher.Cleanup()
	}
}

// --- attached 模式: 全局单例 (避免每次操作都重连 CDP) ---

var (
	attachedOnce sync.Once
	attachedInst *Browser
	attachedErr  error
)

// SetAttachedSingleton 由 main 进程在收到 CDP endpoint 后调用一次。
// 后续 NewBrowser() 在 attach 模式下复用这个单例,不再重连。
func SetAttachedSingleton(b *Browser) {
	attachedOnce.Do(func() {
		attachedInst = b
	})
}

// GetAttachedSingleton 获取已注册的 attach 单例。返回 nil 表示未注册。
func GetAttachedSingleton() *Browser {
	return attachedInst
}
