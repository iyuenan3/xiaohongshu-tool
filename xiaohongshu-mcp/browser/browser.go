package browser

import (
	"net/url"
	"os"

	"github.com/sirupsen/logrus"
	"github.com/xpzouying/xiaohongshu-mcp/cookies"
)

type browserConfig struct {
	binPath     string
	cdpEndpoint string
}

type Option func(*browserConfig)

func WithBinPath(binPath string) Option {
	return func(c *browserConfig) {
		c.binPath = binPath
	}
}

// WithCDPEndpoint 启用 attach 模式: 不启动 Chrome, 而是通过 CDP WebSocket
// attach 到一个已有的 Chromium 实例 (用于 Electron 内嵌场景)。
// endpoint 形如: ws://127.0.0.1:<port>/devtools/browser/<uuid>
func WithCDPEndpoint(endpoint string) Option {
	return func(c *browserConfig) {
		c.cdpEndpoint = endpoint
	}
}

// maskProxyCredentials masks username and password in proxy URL for safe logging.
func maskProxyCredentials(proxyURL string) string {
	u, err := url.Parse(proxyURL)
	if err != nil || u.User == nil {
		return proxyURL
	}
	if _, hasPassword := u.User.Password(); hasPassword {
		u.User = url.UserPassword("***", "***")
	} else {
		u.User = url.User("***")
	}
	return u.String()
}

// NewBrowser 创建浏览器实例 (launcher 模式 或 attach 模式)。
//
// attach 模式 (WithCDPEndpoint 非空):
//   - 优先复用 SetAttachedSingleton 注册的全局实例 (避免重复 CDP 握手)
//   - 否则首次调用时新建并注册
//
// launcher 模式 (默认):
//   - 启动 Chrome 子进程, 加载 cookies, 应用 proxy
//   - 行为与原 headless_browser 完全兼容
//
// 返回的 *Browser 由本包定义 (替代原 *headless_browser.Browser)。
func NewBrowser(headless bool, options ...Option) *Browser {
	cfg := &browserConfig{}
	for _, opt := range options {
		opt(cfg)
	}

	// attach 模式
	if cfg.cdpEndpoint != "" {
		if existing := GetAttachedSingleton(); existing != nil {
			return existing
		}
		b, err := newInner(&innerConfig{
			cdpEndpoint: cfg.cdpEndpoint,
		})
		if err != nil {
			logrus.Fatalf("attach to CDP failed: %v", err)
		}
		SetAttachedSingleton(b)
		return b
	}

	// launcher 模式 (向后兼容 Docker)
	innerCfg := &innerConfig{
		headless:      headless,
		chromeBinPath: cfg.binPath,
	}

	// Proxy from env
	if proxy := os.Getenv("XHS_PROXY"); proxy != "" {
		innerCfg.proxy = proxy
		logrus.Infof("Using proxy: %s", maskProxyCredentials(proxy))
	}

	// 加载 cookies
	cookiePath := cookies.GetCookiesFilePath()
	cookieLoader := cookies.NewLoadCookie(cookiePath)
	if data, err := cookieLoader.LoadCookies(); err == nil {
		innerCfg.cookies = string(data)
		logrus.Debugf("loaded cookies from file successfully")
	} else {
		logrus.Warnf("failed to load cookies: %v", err)
	}

	b, err := newInner(innerCfg)
	if err != nil {
		logrus.Fatalf("launch browser failed: %v", err)
	}
	return b
}
