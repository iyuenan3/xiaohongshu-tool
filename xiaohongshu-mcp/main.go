package main

import (
	"flag"
	"os"

	"github.com/sirupsen/logrus"
	"github.com/xpzouying/xiaohongshu-mcp/configs"
)

func main() {
	var (
		headless    bool
		binPath     string // 浏览器二进制文件路径
		port        string
		cdpEndpoint string
	)
	flag.BoolVar(&headless, "headless", true, "是否无头模式")
	flag.StringVar(&binPath, "bin", "", "浏览器二进制文件路径")
	flag.StringVar(&port, "port", ":18060", "端口 (使用 :0 让操作系统选择空闲端口)")
	flag.StringVar(&cdpEndpoint, "cdp-endpoint", "",
		"CDP WebSocket endpoint (启用 attach 模式, 不启动 Chrome)。"+
			"形如 ws://127.0.0.1:<port>/devtools/browser/<uuid>。"+
			"也可由 POST /internal/attach 运行时注入。")
	flag.Parse()

	if len(binPath) == 0 {
		binPath = os.Getenv("ROD_BROWSER_BIN")
	}

	configs.InitHeadless(headless)
	configs.SetBinPath(binPath)
	if cdpEndpoint != "" {
		configs.SetCDPEndpoint(cdpEndpoint)
		logrus.Infof("CDP endpoint preset via CLI: %s", cdpEndpoint)
	}

	// 初始化服务
	xiaohongshuService := NewXiaohongshuService()

	// 创建并启动应用服务器
	appServer := NewAppServer(xiaohongshuService)
	if err := appServer.Start(port); err != nil {
		logrus.Fatalf("failed to run server: %v", err)
	}
}
