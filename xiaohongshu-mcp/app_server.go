package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/sirupsen/logrus"
)

// AppServer 应用服务器结构体，封装所有服务和处理器
type AppServer struct {
	xiaohongshuService *XiaohongshuService
	mcpServer          *mcp.Server
	router             *gin.Engine
	httpServer         *http.Server
}

// NewAppServer 创建新的应用服务器实例
func NewAppServer(xiaohongshuService *XiaohongshuService) *AppServer {
	appServer := &AppServer{
		xiaohongshuService: xiaohongshuService,
	}

	// 初始化 MCP Server（需要在创建 appServer 之后，因为工具注册需要访问 appServer）
	appServer.mcpServer = InitMCPServer(appServer)

	return appServer
}

// Start 启动服务器。
//
// port 形如 ":18060" (固定端口) 或 ":0" (随机端口, 用于 Electron 内嵌场景,
// 主进程通过解析 stdout 的 "BIND_PORT=<n>" 行获取实际端口)。
func (s *AppServer) Start(port string) error {
	s.router = setupRoutes(s)

	// 显式创建 listener 以便 port=":0" 时拿到实际端口
	listener, err := net.Listen("tcp", port)
	if err != nil {
		return fmt.Errorf("listen %s: %w", port, err)
	}
	actualAddr := listener.Addr().(*net.TCPAddr)
	// 向 stdout 输出端口供 Electron 主进程解析。
	// 用 fmt 而非 logrus, 保证不被日志级别过滤、且行格式稳定。
	fmt.Printf("BIND_PORT=%d\n", actualAddr.Port)
	logrus.Infof("HTTP server bound: 127.0.0.1:%d", actualAddr.Port)

	s.httpServer = &http.Server{
		Handler: s.router,
	}

	// 启动服务器的 goroutine
	go func() {
		if err := s.httpServer.Serve(listener); err != nil && err != http.ErrServerClosed {
			logrus.Errorf("服务器启动失败: %v", err)
			os.Exit(1)
		}
	}()

	// 等待中断信号
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logrus.Infof("正在关闭服务器...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := s.httpServer.Shutdown(ctx); err != nil {
		logrus.Warnf("等待连接关闭超时，强制退出: %v", err)
	} else {
		logrus.Infof("服务器已优雅关闭")
	}

	return nil
}
